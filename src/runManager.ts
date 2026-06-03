import * as vscode from "vscode";
import { spawn, ChildProcess } from "node:child_process";
import { Glci } from "./glci";
import { RunHistory, RunKind, RunStatus } from "./history";
import { PipelineStore } from "./pipelineStore";

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

/** Per-job live state parsed out of a pipeline run's combined output. */
interface LiveJob {
  status: RunStatus;
  /** This job's slice of the pipeline output (prefix stripped, ANSI stripped). */
  log: string;
}

/**
 * Live state for one whole-pipeline run. {@link LivePipeline.names} is sorted
 * longest-first so prefix matching attributes a line to the most specific job
 * name (e.g. `test-2` wins over `test`). {@link LivePipeline.buf} holds the
 * partial trailing line between chunks.
 */
interface LivePipeline {
  names: string[];
  jobs: Map<string, LiveJob>;
  buf: string;
}

/**
 * Runs jobs/stages by spawning `glci` and piping its output into a
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
  /** Parsed per-job live state, keyed by the pipeline run's history id. */
  private readonly pipelines = new Map<string, LivePipeline>();
  /** Fires when a pipeline run's per-job status changes (drives the dashboard). */
  private readonly liveEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLive = this.liveEmitter.event;
  /**
   * Fires for every chunk of a job's output as it streams, so the inline log
   * viewer can append without a full re-render. `job` is the pipeline job name
   * for pipeline runs, or the run's target for single job/stage runs.
   */
  private readonly appendEmitter = new vscode.EventEmitter<{
    runId: string;
    job: string;
    chunk: string;
  }>();
  readonly onDidAppendJobLog = this.appendEmitter.event;

  constructor(
    private readonly glci: Glci,
    private readonly history: RunHistory,
    private readonly logChannel: vscode.OutputChannel,
    private readonly store: PipelineStore,
  ) {}

  runJob(name: string, opts: { withNeeds?: boolean; needs?: string[]; image?: string } = {}): void {
    const kind: RunKind = opts.withNeeds ? "job-needs" : "job";
    const label = opts.withNeeds ? `${name} (with needs)` : name;
    this.start(label, name, kind, this.glci.buildRunArgs(name, opts));
  }

  runStage(stage: string): void {
    this.start(`stage: ${stage}`, stage, "stage", this.glci.buildStageArgs(stage));
  }

  /**
   * Run the whole pipeline. `jobNames` (the current job index) lets the output
   * parser attribute each line to the right job for the live board overview.
   * Returns the run's history id so callers can navigate straight to its detail.
   */
  runPipeline(jobNames: string[]): string {
    return this.start(
      "pipeline",
      "pipeline",
      "pipeline",
      this.glci.buildPipelineArgs(),
      jobNames,
    );
  }

  /**
   * Per-job status for a pipeline run. Prefers the live in-memory state; after
   * a reload that map is gone, so it falls back to the persisted store.
   */
  pipelineStatuses(runId: string): Record<string, RunStatus> | undefined {
    const p = this.pipelines.get(runId);
    if (p) {
      const out: Record<string, RunStatus> = {};
      for (const [name, job] of p.jobs) {
        out[name] = job.status;
      }
      return out;
    }
    return this.store.statuses(runId);
  }

  /**
   * Synchronous in-memory log for a job, or undefined if it isn't held this
   * session. Reading without an `await` lets the dashboard seed the log pane in
   * the same tick it sets the route, so no streamed chunk slips through the gap.
   */
  liveJobLogText(runId: string, jobName: string): string | undefined {
    const p = this.pipelines.get(runId);
    if (p) {
      return p.jobs.get(jobName)?.log;
    }
    return this.logs.get(runId)?.text;
  }

  /**
   * One job's captured slice of a pipeline run. Live buffer first, then the
   * on-disk copy so a run from a previous session is still readable.
   */
  async jobLogText(runId: string, jobName: string): Promise<string | undefined> {
    const p = this.pipelines.get(runId);
    if (p) {
      const live = p.jobs.get(jobName)?.log;
      if (live !== undefined) {
        return live;
      }
      return this.store.logText(runId, jobName);
    }
    // Single job/stage run: the whole captured run log is the job's log. This
    // lives only in memory (never persisted), so it's available this session.
    return this.logs.get(runId)?.text;
  }

  /** Dump one job's slice of a pipeline run into the run-log channel. */
  async showJobLog(runId: string, jobName: string): Promise<void> {
    const text = await this.jobLogText(runId, jobName);
    this.logChannel.clear();
    if (text === undefined) {
      this.logChannel.appendLine(
        `No captured output for "${jobName}" in this pipeline run.`,
      );
    } else {
      this.logChannel.appendLine(`=== ${jobName} (pipeline run) ===`);
      this.logChannel.append(text);
    }
    this.logChannel.show(true);
  }

  /**
   * Feed a chunk of a pipeline run's combined output through the line parser.
   * Buffers the partial trailing line and fires {@link liveEmitter} once per
   * chunk if any job's status changed.
   */
  private feedLive(id: string, chunk: string): void {
    const p = this.pipelines.get(id);
    if (!p) {
      return;
    }
    p.buf += chunk;
    let changed = false;
    // Per-job text appended during this chunk, emitted once below so the inline
    // viewer streams smoothly (one message per job per chunk, not per line).
    const deltas = new Map<string, string>();
    let nl: number;
    while ((nl = p.buf.indexOf("\n")) !== -1) {
      const raw = p.buf.slice(0, nl);
      p.buf = p.buf.slice(nl + 1);
      const line = stripAnsi(raw).replace(/\r$/, "");
      if (this.parseLine(id, p, line, deltas)) {
        changed = true;
      }
    }
    for (const [job, text] of deltas) {
      this.appendEmitter.fire({ runId: id, job, chunk: text });
    }
    if (changed) {
      this.liveEmitter.fire();
    }
  }

  /**
   * Classify one (ANSI-stripped) output line and update per-job state. Returns
   * true if a job appeared or changed status. Looks for ` PASS  <job>` /
   * ` FAIL  <job>` summary lines, and lines prefixed with the job name.
   */
  private parseLine(
    id: string,
    p: LivePipeline,
    line: string,
    deltas: Map<string, string>,
  ): boolean {
    const summary = line.match(/^\s+(PASS|FAIL)\s+(.+?)\s*$/);
    if (summary) {
      const name = summary[2].trim();
      if (!p.names.includes(name)) {
        return false;
      }
      const job = this.ensureJob(p, name);
      const changed = this.setStatus(
        job,
        summary[1] === "PASS" ? "passed" : "failed",
      );
      this.persistJob(id, name, job);
      return changed;
    }

    for (const name of p.names) {
      if (
        line.startsWith(name) &&
        (line.length === name.length || line[name.length] === " ")
      ) {
        const rest = line.slice(name.length).trimStart();
        const isNew = !p.jobs.has(name);
        const job = this.ensureJob(p, name);
        job.log += rest + "\n";
        deltas.set(name, (deltas.get(name) ?? "") + rest + "\n");
        if (job.log.length > MAX_LOG) {
          job.log = job.log.slice(job.log.length - MAX_LOG);
        }
        let changed = isNew;
        if (rest.startsWith("starting ")) {
          changed = this.setStatus(job, "running") || changed;
        } else if (rest.startsWith("finished in")) {
          changed =
            this.setStatus(job, /FAIL/.test(rest) ? "failed" : "passed") ||
            changed;
        }
        if (isNew || changed) {
          this.persistJob(id, name, job);
        }
        return changed;
      }
    }
    return false;
  }

  /**
   * Mirror a job's live state into the persistent store: always its status,
   * and its full captured log once the job reaches a terminal state (the
   * in-memory buffer holds the complete slice, so we overwrite the file).
   */
  private persistJob(id: string, name: string, job: LiveJob): void {
    this.store.setStatus(id, name, job.status);
    if (job.status === "passed" || job.status === "failed") {
      this.store.writeJobLog(id, name, job.log);
    }
  }

  /** Get or create a job's live entry (new jobs start as `running`). */
  private ensureJob(p: LivePipeline, name: string): LiveJob {
    let job = p.jobs.get(name);
    if (!job) {
      job = { status: "running", log: "" };
      p.jobs.set(name, job);
    }
    return job;
  }

  /** Set a job's status; returns true only if it actually changed. */
  private setStatus(job: LiveJob, status: RunStatus): boolean {
    if (job.status === status) {
      return false;
    }
    job.status = status;
    return true;
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
    liveJobs?: string[],
  ): string {
    const id = this.history.start({ target, kind, label });

    if (liveJobs) {
      this.pipelines.set(id, {
        // Longest-first so prefix matching prefers the most specific job name.
        names: [...liveJobs].sort((a, b) => b.length - a.length),
        jobs: new Map(),
        buf: "",
      });
      this.store.begin(id);
    }

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

        const isPipeline = liveJobs !== undefined;
        const onData = (d: Buffer) => {
          const text = d.toString();
          writeEmitter.fire(toCrlf(text));
          this.appendLog(id, label, text);
          if (isPipeline) {
            // Per-job parsing emits its own append events.
            this.feedLive(id, text);
          } else {
            // Single job/stage run: the whole output is this job's log.
            this.appendEmitter.fire({
              runId: id,
              job: target,
              chunk: stripAnsi(text),
            });
          }
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
    return id;
  }

  /** Record the terminal outcome and surface failures so they can't be missed. */
  private settle(
    id: string,
    status: "passed" | "failed" | "canceled",
    code: number | null,
  ): void {
    this.procs.delete(id);
    this.history.finish(id, status, code);
    // A pipeline that exited may still have jobs we never saw a `finished` line
    // for (cancellation, or a crash mid-run). Settle them to the run's outcome
    // so the board never shows a phantom spinner.
    const pipeline = this.pipelines.get(id);
    if (pipeline) {
      const fallback: RunStatus = status === "canceled" ? "canceled" : "failed";
      for (const [name, job] of pipeline.jobs) {
        if (job.status === "running") {
          job.status = fallback;
          this.store.setStatus(id, name, fallback);
        }
        // Persist every job's final log (covers jobs we never saw finish).
        this.store.writeJobLog(id, name, job.log);
      }
      this.store.finish(id);
      this.liveEmitter.fire();
    }
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

  dispose(): void {
    this.liveEmitter.dispose();
    this.appendEmitter.dispose();
  }
}
