import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A single rule entry as emitted by `gitlab-ci-local --list-json`. */
export interface JobRule {
  if?: string;
  when?: string;
  changes?: unknown;
  exists?: unknown;
}

/** Job metadata as emitted by `gitlab-ci-local --list-json`. */
export interface GlciJob {
  name: string;
  description: string;
  stage: string;
  when: string;
  allow_failure: boolean;
  needs?: string[];
  rules?: JobRule[];
}

/**
 * Comma-separated value for `GCL_IGNORE_PREDEFINED_VARS`. It silences
 * gitlab-ci-local's "Avoid overriding predefined variables" warning, which is
 * critical: that warning prints to **stdout** and contains `[VAR_NAME]`, so it
 * would otherwise corrupt the `--list-json` payload (the parser slices from the
 * first `[`). We always silence the umask FF, honor any names already in the
 * environment, and — so users can override `CI_PIPELINE_SOURCE`,
 * `CI_COMMIT_BRANCH`, etc. via `glci.variables` to make `rules:` evaluate as a
 * real pipeline would — add every key from `glci.variables`.
 */
function ignorePredefinedVars(vars: Record<string, string>): string {
  const names = new Set<string>(["FF_DISABLE_UMASK_FOR_DOCKER_EXECUTOR"]);
  for (const n of (process.env.GCL_IGNORE_PREDEFINED_VARS ?? "").split(",")) {
    if (n.trim()) {
      names.add(n.trim());
    }
  }
  for (const key of Object.keys(vars)) {
    names.add(key);
  }
  return [...names].join(",");
}

/** Environment for listing/preview/validate. Colors off; JSON-safe stdout. */
function listEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GCL_IGNORE_PREDEFINED_VARS: ignorePredefinedVars(vars),
    FORCE_COLOR: "0",
  };
}

/**
 * Environment for actual job runs. Same predefined-var suppression as listing,
 * but colors are *forced on* so the captured output rendered in the
 * pseudoterminal keeps gitlab-ci-local's ANSI coloring (the piped stdout is not
 * a TTY, so the binary would otherwise drop color).
 */
function runEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GCL_IGNORE_PREDEFINED_VARS: ignorePredefinedVars(vars),
    FORCE_COLOR: "1",
  };
}

function binaryPath(): string {
  const configured = vscode.workspace
    .getConfiguration("glci")
    .get<string>("binaryPath");
  return configured && configured.trim() ? configured.trim() : "gitlab-ci-local";
}

function extraArgs(): string[] {
  return vscode.workspace.getConfiguration("glci").get<string[]>("extraArgs") ?? [];
}

/** Variables map → repeated `--variable KEY=VALUE` argument tokens. */
function variableArgs(vars: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    out.push("--variable", `${key}=${value}`);
  }
  return out;
}

/** Expand `$VAR` / `${VAR}` against the current environment (e.g. `$HOME`). */
function expandEnv(value: string): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced, bare) => process.env[braced ?? bare] ?? match,
  );
}

/**
 * Global args appended to every invocation, for the non-shell `execFile` path
 * (listing, preview, validate). Env vars are expanded here because there is no
 * shell to do it.
 */
function globalExecArgs(vars: Record<string, string>): string[] {
  return [...variableArgs(vars), ...extraArgs().map(expandEnv)];
}

/**
 * Extract the first JSON array from mixed output. `gitlab-ci-local` may print
 * warnings before the JSON payload, so we slice from the first `[`.
 */
function parseListJson(raw: string): GlciJob[] {
  const start = raw.indexOf("[");
  if (start === -1) {
    throw new Error("No JSON array found in gitlab-ci-local --list-json output.");
  }
  // Find the matching closing bracket by scanning from the end.
  const end = raw.lastIndexOf("]");
  if (end === -1 || end < start) {
    throw new Error("Malformed JSON in gitlab-ci-local --list-json output.");
  }
  const slice = raw.slice(start, end + 1);
  const parsed = JSON.parse(slice) as GlciJob[];
  return parsed;
}

export class Glci {
  /**
   * @param root resolver for the project root (the gitlab-ci-local cwd).
   * @param extraVars runtime CI variables (from the UI) merged over the
   *   `glci.variables` setting, with UI values winning on conflict.
   */
  constructor(
    private readonly root: () => string,
    private readonly extraVars: () => Record<string, string> = () => ({}),
  ) {}

  /** Settings `glci.variables` with the runtime (UI) variables layered on top. */
  private mergedVars(): Record<string, string> {
    const config =
      vscode.workspace
        .getConfiguration("glci")
        .get<Record<string, string>>("variables") ?? {};
    return { ...config, ...this.extraVars() };
  }

  /** Verify the binary is callable; returns the version string or throws. */
  async checkBinary(): Promise<string> {
    const { stdout } = await execFileAsync(binaryPath(), ["--version"], {
      cwd: this.root(),
      env: listEnv(this.mergedVars()),
    });
    return stdout.trim();
  }

  /** List every job (including `when: never`) with metadata. */
  async listJobs(): Promise<GlciJob[]> {
    // Note: `--cwd` rejects absolute paths in gitlab-ci-local, so we rely on the
    // child process `cwd` instead and omit the flag.
    const bin = binaryPath();
    const cwd = this.root();
    const vars = this.mergedVars();
    try {
      const { stdout } = await execFileAsync(
        bin,
        ["--list-json", ...globalExecArgs(vars)],
        { cwd, env: listEnv(vars), maxBuffer: 32 * 1024 * 1024 },
      );
      return parseListJson(stdout);
    } catch (err) {
      // Wrap with the binary + cwd + any stderr so the failure is diagnosable
      // from the surfaced message rather than a bare ENOENT.
      const e = err as Error & { code?: string; stderr?: string };
      const parts = [`gitlab-ci-local listing failed (binary="${bin}", cwd="${cwd}")`];
      if (e.code) {
        parts.push(`code=${e.code}`);
      }
      parts.push(e.message);
      if (e.stderr && e.stderr.trim()) {
        parts.push(`stderr: ${e.stderr.trim()}`);
      }
      throw new Error(parts.join(" — "));
    }
  }

  /** The resolved binary name/path (PATH lookup or configured absolute path). */
  get binary(): string {
    return binaryPath();
  }

  /** The cwd every invocation runs in (the resolved project root). */
  get cwd(): string {
    return this.root();
  }

  /** Environment for job runs (predefined-var suppression + forced color). */
  get runEnv(): NodeJS.ProcessEnv {
    return runEnv(this.mergedVars());
  }

  /**
   * Argv for running a single job via a non-shell `spawn`. Mirrors the listing
   * path: global variables + env-expanded extraArgs are appended.
   */
  buildRunArgs(name: string, opts: { withNeeds?: boolean } = {}): string[] {
    const args = [name];
    if (opts.withNeeds) {
      args.push("--needs");
    }
    return [...args, ...globalExecArgs(this.mergedVars())];
  }

  /** Argv for running an entire stage via a non-shell `spawn`. */
  buildStageArgs(stage: string): string[] {
    return ["--stage", stage, ...globalExecArgs(this.mergedVars())];
  }

  /**
   * Argv for running the whole pipeline. With no job name and no `--stage`,
   * gitlab-ci-local executes every job in stage order honoring `needs` — i.e.
   * exactly like a real pipeline run.
   */
  buildPipelineArgs(): string[] {
    return [...globalExecArgs(this.mergedVars())];
  }

  /** Run `--preview` / `--validate` and stream output into a channel. */
  async runToChannel(
    channel: vscode.OutputChannel,
    extraFlags: string[],
    label: string,
  ): Promise<void> {
    channel.show(true);
    channel.appendLine(`$ ${binaryPath()} ${extraFlags.join(" ")} (${label})`);
    const vars = this.mergedVars();
    try {
      const { stdout, stderr } = await execFileAsync(
        binaryPath(),
        [...extraFlags, ...globalExecArgs(vars)],
        { cwd: this.root(), env: listEnv(vars), maxBuffer: 64 * 1024 * 1024 },
      );
      if (stderr.trim()) {
        channel.appendLine(stderr.trimEnd());
      }
      channel.appendLine(stdout.trimEnd());
    } catch (err) {
      channel.appendLine(`Error: ${(err as Error).message}`);
    }
  }
}
