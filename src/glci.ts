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

/** Suppress the predefined-variable warnings that otherwise pollute stdout. */
const LIST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GCL_IGNORE_PREDEFINED_VARS: "FF_DISABLE_UMASK_FOR_DOCKER_EXECUTOR",
  FORCE_COLOR: "0",
};

function binaryPath(): string {
  const configured = vscode.workspace
    .getConfiguration("glci")
    .get<string>("binaryPath");
  return configured && configured.trim() ? configured.trim() : "gitlab-ci-local";
}

function extraArgs(): string[] {
  return vscode.workspace.getConfiguration("glci").get<string[]>("extraArgs") ?? [];
}

/** `glci.variables` map → repeated `--variable KEY=VALUE` argument tokens. */
function variableArgs(): string[] {
  const vars =
    vscode.workspace.getConfiguration("glci").get<Record<string, string>>("variables") ??
    {};
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
function globalExecArgs(): string[] {
  return [...variableArgs(), ...extraArgs().map(expandEnv)];
}

/**
 * Global tokens for the terminal command line. Variables are shell-quoted;
 * `extraArgs` are passed verbatim so the shell expands `$HOME` and friends.
 */
function globalTerminalTokens(): string[] {
  return [...variableArgs().map(shellQuote), ...extraArgs()];
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
  /** @param root resolver for the project root (the gitlab-ci-local cwd). */
  constructor(private readonly root: () => string) {}

  /** Verify the binary is callable; returns the version string or throws. */
  async checkBinary(): Promise<string> {
    const { stdout } = await execFileAsync(binaryPath(), ["--version"], {
      cwd: this.root(),
      env: LIST_ENV,
    });
    return stdout.trim();
  }

  /** List every job (including `when: never`) with metadata. */
  async listJobs(): Promise<GlciJob[]> {
    // Note: `--cwd` rejects absolute paths in gitlab-ci-local, so we rely on the
    // child process `cwd` instead and omit the flag.
    const bin = binaryPath();
    const cwd = this.root();
    try {
      const { stdout } = await execFileAsync(
        bin,
        ["--list-json", ...globalExecArgs()],
        { cwd, env: LIST_ENV, maxBuffer: 32 * 1024 * 1024 },
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

  /** Run a single job in an integrated terminal. */
  runJob(name: string, opts: { withNeeds?: boolean } = {}): void {
    const args = [shellQuote(name)];
    if (opts.withNeeds) {
      args.push("--needs");
    }
    this.sendToTerminal(name, args);
  }

  /** Run an entire stage in an integrated terminal. */
  runStage(stage: string): void {
    this.sendToTerminal(`stage:${stage}`, ["--stage", shellQuote(stage)]);
  }

  /** Run `--preview` / `--validate` and stream output into a channel. */
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
        [...extraFlags, ...globalExecArgs()],
        { cwd: this.root(), env: LIST_ENV, maxBuffer: 64 * 1024 * 1024 },
      );
      if (stderr.trim()) {
        channel.appendLine(stderr.trimEnd());
      }
      channel.appendLine(stdout.trimEnd());
    } catch (err) {
      channel.appendLine(`Error: ${(err as Error).message}`);
    }
  }

  private sendToTerminal(title: string, args: string[]): void {
    const perRun = vscode.workspace
      .getConfiguration("glci")
      .get<boolean>("terminalPerRun");
    const name = perRun ? `glci: ${title}` : "gitlab-ci-local";
    let terminal = perRun
      ? undefined
      : vscode.window.terminals.find((t) => t.name === name);
    if (!terminal) {
      terminal = vscode.window.createTerminal({ name, cwd: this.root() });
    }
    terminal.show();
    const cmd = [binaryPath(), ...args, ...globalTerminalTokens()].join(" ");
    terminal.sendText(cmd);
  }
}

/** Minimal POSIX single-quote escaping for terminal command construction. */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-./=]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
