import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A single job as emitted by `glci jobs --json`. */
export interface GlciJob {
  name: string;
  stage: string;
  when: string;
  allow_failure: boolean;
  image?: string;
  needs?: string[];
}

/** Environment for listing / show / lint. Colors off; JSON-safe stdout. */
function listEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FORCE_COLOR: "0",
  };
}

/**
 * Environment for actual job runs. Colors are forced on so the captured output
 * rendered in the pseudoterminal keeps ANSI coloring (the piped stdout is not a
 * TTY, so the binary would otherwise drop color).
 */
function runEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FORCE_COLOR: "1",
  };
}

function binaryPath(): string {
  const configured = vscode.workspace
    .getConfiguration("glci")
    .get<string>("binaryPath");
  return configured && configured.trim() ? configured.trim() : "glci";
}

function extraArgs(): string[] {
  return vscode.workspace.getConfiguration("glci").get<string[]>("extraArgs") ?? [];
}

/** Variables map → repeated `--env KEY=VALUE` argument tokens. */
function variableArgs(vars: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    out.push("--env", `${key}=${value}`);
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
 * Args appended to every `glci run` invocation: variables (--env KEY=VALUE)
 * plus env-expanded extraArgs. Env vars are expanded here because there is no
 * shell to do it.
 */
function globalRunArgs(vars: Record<string, string>): string[] {
  return [...variableArgs(vars), ...extraArgs().map(expandEnv)];
}

/**
 * Args appended to non-run invocations (`show`, `lint`). glci does not accept
 * `--env` on those subcommands, so only extraArgs are included.
 */
function globalListArgs(): string[] {
  return extraArgs().map(expandEnv);
}

/**
 * The fallback Docker image for jobs that don't specify their own `image:`.
 * glci can't resolve images inherited via `extends:` or a top-level `image:`
 * in an included file, so those jobs would otherwise run with `alpine:latest`.
 * Set `glci.defaultImage` in workspace settings to the project's base image.
 */
function defaultImage(): string {
  return (
    vscode.workspace
      .getConfiguration("glci")
      .get<string>("defaultImage")
      ?.trim() ?? ""
  );
}

/**
 * `--context` args for `glci show`. When `glci.listContext` is set (e.g.
 * `"branch=main"`) those jobs are filtered by that pipeline context. When empty
 * (the default) no `--context` flag is passed, and glci visualizes the full
 * pipeline without rule filtering — showing every job regardless of rules.
 */
function listContextArgs(): string[] {
  const ctx = vscode.workspace
    .getConfiguration("glci")
    .get<string>("listContext")
    ?.trim();
  return ctx ? ["--context", ctx] : [];
}

/**
 * Parse `glci show --json` output. glci emits `{ "stages": [...], "jobs": [...] }`
 * and jobs are already returned in pipeline stage order.
 */
function parseShowJson(raw: string): GlciJob[] {
  const start = raw.indexOf("{");
  if (start === -1) {
    throw new Error("No JSON object found in glci show --json output.");
  }
  const end = raw.lastIndexOf("}");
  if (end === -1 || end < start) {
    throw new Error("Malformed JSON in glci show --json output.");
  }
  const parsed = JSON.parse(raw.slice(start, end + 1)) as {
    stages?: string[];
    jobs?: GlciJob[];
  };
  return parsed.jobs ?? [];
}

export class Glci {
  /**
   * @param root resolver for the project root (the glci cwd).
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
    const { stdout } = await execFileAsync(binaryPath(), ["version"], {
      cwd: this.root(),
      env: listEnv(),
    });
    return stdout.trim();
  }

  /**
   * List every job defined in the pipeline. Uses `glci show --json` which
   * visualizes the full pipeline without rule filtering, so all jobs appear
   * regardless of `$CI_PIPELINE_SOURCE` or branch rules. Set `glci.listContext`
   * to restrict listing to a specific pipeline context (e.g. `branch=main`).
   */
  async listJobs(): Promise<GlciJob[]> {
    const bin = binaryPath();
    const cwd = this.root();
    try {
      const { stdout } = await execFileAsync(
        bin,
        ["show", "--json", ...listContextArgs(), ...globalListArgs()],
        { cwd, env: listEnv(), maxBuffer: 32 * 1024 * 1024 },
      );
      return parseShowJson(stdout);
    } catch (err) {
      const e = err as Error & { code?: string; stderr?: string };
      const parts = [`glci listing failed (binary="${bin}", cwd="${cwd}")`];
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

  /** Environment for job runs (forced color). */
  get runEnv(): NodeJS.ProcessEnv {
    return runEnv();
  }

  /**
   * Argv for running a single job via `glci run`. When `withNeeds` is true and
   * `needs` is provided, upstream job names are prepended so glci executes the
   * dependency chain alongside the target. `image` overrides the container image
   * (passed as `--image`); falls back to the `glci.defaultImage` setting when
   * the job has no image in the CI config.
   */
  buildRunArgs(
    name: string,
    opts: { withNeeds?: boolean; needs?: string[] ; image?: string } = {},
  ): string[] {
    const args = ["run"];
    if (opts.withNeeds && opts.needs?.length) {
      args.push(...opts.needs);
    }
    args.push(name);
    const image = opts.image ?? defaultImage();
    if (image) {
      args.push("--image", image);
    }
    return [...args, ...globalRunArgs(this.mergedVars())];
  }

  /** Argv for running an entire stage via `glci run --stage`. */
  buildStageArgs(stage: string): string[] {
    const args = ["run", "--stage", stage];
    const img = defaultImage();
    if (img) {
      args.push("--image", img);
    }
    return [...args, ...globalRunArgs(this.mergedVars())];
  }

  /**
   * Argv for running the whole pipeline. With no job name and no `--stage`,
   * glci executes every job in stage order — exactly like a real pipeline run.
   */
  buildPipelineArgs(): string[] {
    const args = ["run"];
    const img = defaultImage();
    if (img) {
      args.push("--image", img);
    }
    return [...args, ...globalRunArgs(this.mergedVars())];
  }

  /**
   * Args for `glci show --plain`, respecting the `glci.listContext` setting so
   * the preview and the job list always show the same pipeline view.
   */
  buildPreviewArgs(): string[] {
    return ["show", "--plain", ...listContextArgs()];
  }

  /** Run `show` / `lint` and stream output into a channel. */
  async runToChannel(
    channel: vscode.OutputChannel,
    extraFlags: string[],
    label: string,
  ): Promise<void> {
    channel.show(true);
    channel.appendLine(`$ ${binaryPath()} ${extraFlags.join(" ")} (${label})`);
    try {
      const { stdout, stderr } = await execFileAsync(
        binaryPath(),
        [...extraFlags, ...globalListArgs()],
        { cwd: this.root(), env: listEnv(), maxBuffer: 64 * 1024 * 1024 },
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
