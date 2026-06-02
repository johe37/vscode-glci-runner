import * as vscode from "vscode";
import { spawn, ChildProcess } from "node:child_process";
import { Glci } from "./glci";
import { RunHistory, RunKind } from "./history";

/** Convert bare `\n` line endings to `\r\n` so a pseudoterminal renders them. */
function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

/**
 * Render an argv as a readable command line for the echoed `$ …` header,
 * quoting tokens that contain whitespace. Display-only — the real `spawn`
 * passes each argv element verbatim, so a job name with spaces stays one arg.
 */
function displayCommand(bin: string, argv: string[]): string {
  const quote = (a: string) => (/\s/.test(a) ? `"${a}"` : a);
  return [bin, ...argv].map(quote).join(" ");
}

/** Strip ANSI escape sequences so captured output is readable in a plain log. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** Cap a single captured run log (keep the tail when it overflows). */
const MAX_LOG = 1_000_000;

/**
 * Runs jobs/stages by spawning `gitlab-ci-local` and piping its output into a
 * {@link vscode.Pseudoterminal} (live, colored, `Ctrl-C`-able) while capturing
 * the exit code, duration, and full output. Results land in {@link RunHistory};
 * the captured log is viewable any time via {@link showLog}, so a failure is
 * never lost even if its terminal is closed.
 */
export class RunManager {
  /** Live processes keyed by their history record id. */
  private readonly procs = new Map<string, ChildProcess>();
  /** Ids the user asked to cancel, so the close handler reports `canceled`. */
  private readonly canceled = new Set<string>();
  /** Captured (ANSI-stripped) output per run, for on-demand log viewing. */
  private readonly logs = new Map<string, { label: string; text: string }>();
  /** The reused terminal when `terminalPerRun` is off. */
  private shared?: { terminal: vscode.Terminal; id: string; passed: boolean };

  constructor(
    private readonly glci: Glci,
    private readonly history: RunHistory,
    private readonly logChannel: vscode.OutputChannel,
  ) {}

  runJob(name: string, opts: { withNeeds?: boolean } = {}): void {
    const kind: RunKind = opts.withNeeds ? "job-needs" : "job";
    const label = opts.withNeeds ? `${name} (with needs)` : name;
    this.start(label, name, kind, this.glci.buildRunArgs(name, opts));
  }

  runStage(stage: string): void {
    this.start(`stage: ${stage}`, stage, "stage", this.glci.buildStageArgs(stage));
  }

  /** Send SIGINT to a live run; the close handler records it as canceled. */
  cancel(id: string): void {
    const child = this.procs.get(id);
    if (child && child.exitCode === null) {
      this.canceled.add(id);
      child.kill("SIGINT");
    }
  }

  /** Dump a run's captured output into the run-log channel and reveal it. */
  showLog(id: string): void {
    const entry = this.logs.get(id);
    this.logChannel.clear();
    if (!entry) {
      this.logChannel.appendLine(
        "No captured log for this run — it is likely from a previous session.",
      );
    } else {
      this.logChannel.appendLine(`=== ${entry.label} ===`);
      this.logChannel.append(entry.text);
    }
    this.logChannel.show(true);
  }

  private appendLog(id: string, label: string, chunk: string): void {
    const entry = this.logs.get(id) ?? { label, text: "" };
    entry.text += stripAnsi(chunk);
    if (entry.text.length > MAX_LOG) {
      entry.text = entry.text.slice(entry.text.length - MAX_LOG);
    }
    this.logs.set(id, entry);
  }

  private start(
    label: string,
    target: string,
    kind: RunKind,
    argv: string[],
  ): void {
    const id = this.history.start({ target, kind, label });

    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number | void>();
    let child: ChildProcess | undefined;

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,
      open: () => {
        const cmdline = displayCommand(this.glci.binary, argv);
        writeEmitter.fire(`\x1b[1m\x1b[36m$ ${cmdline}\x1b[0m\r\n\r\n`);
        this.appendLog(id, label, `$ ${cmdline}\n\n`);

        child = spawn(this.glci.binary, argv, {
          cwd: this.glci.cwd,
          env: this.glci.runEnv,
        });
        this.procs.set(id, child);

        const onData = (d: Buffer) => {
          const text = d.toString();
          writeEmitter.fire(toCrlf(text));
          this.appendLog(id, label, text);
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (err) => {
          const line = `Failed to launch ${this.glci.binary}: ${err.message}`;
          writeEmitter.fire(`\r\n\x1b[31m${line}\x1b[0m\r\n`);
          this.appendLog(id, label, `\n${line}\n`);
          this.settle(id, "failed", null);
        });

        child.on("close", (code) => {
          const wasCanceled = this.canceled.delete(id);
          const status = wasCanceled
            ? "canceled"
            : code === 0
              ? "passed"
              : "failed";
          const color =
            status === "passed" ? "32" : status === "failed" ? "31" : "33";
          const tail =
            status === "canceled" ? "canceled" : `${status} (exit ${code ?? 0})`;
          writeEmitter.fire(`\r\n\x1b[1m\x1b[${color}m── ${tail} ──\x1b[0m\r\n`);
          this.appendLog(id, label, `\n── ${tail} ──\n`);
          this.settle(id, status, code);
        });
      },
      // Deliberately never fire closeEmitter on completion: doing so disposes
      // the terminal (per the VSCode pty contract) and the output would vanish.
      // The terminal stays open until the user closes it (or a *passing* run is
      // reused). Failures are also preserved via the captured log + notification.
      close: () => {
        if (child && child.exitCode === null) {
          this.cancel(id);
        }
      },
      handleInput: (data) => {
        if (data === "\x03") {
          // Ctrl-C aborts the run, matching a normal terminal.
          this.cancel(id);
        }
      },
    };

    const terminal = this.makeTerminal(label, id, pty);
    terminal.show();
  }

  /** Record the terminal outcome and surface failures so they can't be missed. */
  private settle(
    id: string,
    status: "passed" | "failed" | "canceled",
    code: number | null,
  ): void {
    this.procs.delete(id);
    this.history.finish(id, status, code);
    if (this.shared && this.shared.id === id) {
      this.shared.passed = status === "passed";
    }
    if (status === "failed") {
      const label = this.logs.get(id)?.label ?? id;
      void vscode.window
        .showErrorMessage(
          `GitLab CI: "${label}" failed (exit ${code ?? "?"}).`,
          "Show Log",
        )
        .then((choice) => {
          if (choice === "Show Log") {
            this.showLog(id);
          }
        });
    }
  }

  /**
   * Create the terminal hosting a run. With `terminalPerRun` off we reuse a
   * single slot — but only dispose the previous terminal if its run *passed*,
   * so the output of a failed run is never thrown away by the next run.
   */
  private makeTerminal(
    label: string,
    id: string,
    pty: vscode.Pseudoterminal,
  ): vscode.Terminal {
    const perRun = vscode.workspace
      .getConfiguration("glci")
      .get<boolean>("terminalPerRun");

    if (
      !perRun &&
      this.shared &&
      !this.procs.has(this.shared.id) &&
      this.shared.passed
    ) {
      this.shared.terminal.dispose();
      this.shared = undefined;
    }

    const terminal = vscode.window.createTerminal({
      name: `▶ ${label}`,
      pty,
      iconPath: new vscode.ThemeIcon("rocket"),
    });

    if (!perRun) {
      this.shared = { terminal, id, passed: false };
    }
    return terminal;
  }
}
