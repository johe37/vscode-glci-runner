import * as vscode from "vscode";

/** What was launched: a single job, a job with its `needs`, a whole stage, or the entire pipeline. */
export type RunKind = "job" | "job-needs" | "stage" | "pipeline";

/** Lifecycle state of a run. `running` is the only non-terminal state. */
export type RunStatus = "running" | "passed" | "failed" | "canceled";

/** A single local run of a job/stage, persisted across sessions. */
export interface RunRecord {
  /** Stable id, also used as the live process key in {@link RunManager}. */
  id: string;
  /** The job name or stage name that was run. */
  target: string;
  kind: RunKind;
  /** Human label shown in the UI (e.g. `unit-tests` or `stage: test`). */
  label: string;
  /** Epoch ms when the run started. */
  startTime: number;
  /** Epoch ms when the run finished; unset while running. */
  endTime?: number;
  status: RunStatus;
  /** Process exit code once finished (`null` if killed before exiting). */
  exitCode?: number | null;
}

const KEY = "glci.runHistory";
/** Cap the stored history so workspaceState stays small. */
const MAX = 200;

/**
 * Persistent, newest-first log of local job/stage runs. Records are created in
 * the `running` state by {@link start} and transitioned to a terminal state by
 * {@link finish}. Backed by workspaceState and capped at {@link MAX} entries.
 */
export class RunHistory {
  private records: RunRecord[];
  private seq = 0;

  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onChangeEmitter.event;

  constructor(private readonly state: vscode.Memento) {
    this.records = state.get<RunRecord[]>(KEY, []);
    // Any run still marked `running` is stale from a previous session (the
    // process is long gone) — settle it so the UI never shows a phantom spinner.
    let changed = false;
    for (const r of this.records) {
      if (r.status === "running") {
        r.status = "canceled";
        r.endTime = r.endTime ?? r.startTime;
        changed = true;
      }
    }
    if (changed) {
      void this.persist();
    }
  }

  /** Append a new `running` record and return its id. */
  start(rec: { target: string; kind: RunKind; label: string }): string {
    const id = `${Date.now()}-${this.seq++}`;
    const record: RunRecord = {
      id,
      ...rec,
      startTime: Date.now(),
      status: "running",
    };
    this.records.unshift(record);
    if (this.records.length > MAX) {
      this.records.length = MAX;
    }
    void this.persist();
    return id;
  }

  /** Transition a record to a terminal state. No-op if the id is unknown. */
  finish(id: string, status: RunStatus, exitCode: number | null): void {
    const r = this.records.find((r) => r.id === id);
    if (!r) {
      return;
    }
    r.status = status;
    r.endTime = Date.now();
    r.exitCode = exitCode;
    void this.persist();
  }

  /** All records, newest first. */
  all(): readonly RunRecord[] {
    return this.records;
  }

  /** The most recent run for a given target (job/stage name), if any. */
  latestFor(target: string): RunRecord | undefined {
    return this.records.find((r) => r.target === target);
  }

  clear(): void {
    this.records = [];
    void this.persist();
  }

  private async persist(): Promise<void> {
    await this.state.update(KEY, this.records);
    this.onChangeEmitter.fire();
  }

  dispose(): void {
    this.onChangeEmitter.dispose();
  }
}
