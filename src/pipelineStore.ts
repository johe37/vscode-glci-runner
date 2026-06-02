import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { RunStatus } from "./history";

/**
 * On-disk persistence for whole-pipeline runs, so the Pipelines list, the
 * per-run detail board and each job's captured log survive a window reload.
 *
 * Layout under `<storageUri>/pipelines/`:
 *   - `<runId>.json`        — manifest: a `{ jobName: status }` map of seen jobs
 *   - `<runId>/<job>.log`   — that job's captured output (one file per job)
 *
 * Run-level metadata (label, times, overall status) already persists via
 * {@link RunHistory}; this store only adds the per-job detail history lacks.
 * It mirrors {@link RunManager}'s live state: during a run the in-memory
 * `LivePipeline` is the source of truth and writes through to here; after a
 * reload that map is gone and this store (hydrated by {@link init}) answers.
 */
export class PipelineStore {
  /** `<storageUri>/pipelines`, or undefined when no workspace storage exists. */
  private readonly dir?: string;
  /** Per-run job→status map. Tiny; safe to keep fully in memory. */
  private readonly cache = new Map<string, Map<string, RunStatus>>();
  /** Run ids whose manifest needs (re)writing; flushed on a short debounce. */
  private readonly dirty = new Set<string>();
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(storageUri: vscode.Uri | undefined) {
    this.dir = storageUri ? path.join(storageUri.fsPath, "pipelines") : undefined;
  }

  /** Hydrate per-job statuses from disk. Logs are read lazily on demand. */
  async init(): Promise<void> {
    if (!this.dir) {
      return;
    }
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const names = await fs.readdir(this.dir);
      for (const name of names) {
        if (!name.endsWith(".json")) {
          continue;
        }
        const id = name.slice(0, -".json".length);
        try {
          const raw = await fs.readFile(path.join(this.dir, name), "utf8");
          const data = JSON.parse(raw) as { jobs?: Record<string, RunStatus> };
          const jobs = new Map<string, RunStatus>();
          for (const [k, v] of Object.entries(data.jobs ?? {})) {
            jobs.set(k, v);
          }
          this.cache.set(id, jobs);
        } catch {
          // Skip a corrupt/partial manifest rather than failing activation.
        }
      }
    } catch {
      // Storage unavailable — persistence is simply disabled.
    }
  }

  /** Start tracking a pipeline run and create its per-run log directory. */
  begin(id: string): void {
    if (!this.dir) {
      return;
    }
    this.cache.set(id, new Map());
    void fs.mkdir(path.join(this.dir, id), { recursive: true });
    this.markDirty(id);
  }

  /** Record a job's current status (debounced manifest write). */
  setStatus(id: string, job: string, status: RunStatus): void {
    const jobs = this.cache.get(id);
    if (!jobs) {
      return;
    }
    jobs.set(job, status);
    this.markDirty(id);
  }

  /** Persist a job's full captured log (overwrite — callers hold the buffer). */
  writeJobLog(id: string, job: string, text: string): void {
    const file = this.logFile(id, job);
    if (!file) {
      return;
    }
    void fs.writeFile(file, text).catch(() => {
      /* best-effort; a missing log just shows as empty after reload */
    });
  }

  /** Per-job statuses for a run, or undefined if this run isn't tracked. */
  statuses(id: string): Record<string, RunStatus> | undefined {
    const jobs = this.cache.get(id);
    if (!jobs) {
      return undefined;
    }
    const out: Record<string, RunStatus> = {};
    for (const [k, v] of jobs) {
      out[k] = v;
    }
    return out;
  }

  /** Read a job's persisted log, or undefined if none was written. */
  async logText(id: string, job: string): Promise<string | undefined> {
    const file = this.logFile(id, job);
    if (!file) {
      return undefined;
    }
    try {
      return await fs.readFile(file, "utf8");
    } catch {
      return undefined;
    }
  }

  /** Flush a run's manifest immediately (call when the run settles). */
  finish(id: string): void {
    this.flush(id);
  }

  /** Forget a run entirely: drop the cache entry, manifest and log directory. */
  async delete(id: string): Promise<void> {
    this.cache.delete(id);
    this.dirty.delete(id);
    if (!this.dir) {
      return;
    }
    await fs
      .rm(path.join(this.dir, `${id}.json`), { force: true })
      .catch(() => {});
    await fs
      .rm(path.join(this.dir, id), { recursive: true, force: true })
      .catch(() => {});
  }

  private logFile(id: string, job: string): string | undefined {
    if (!this.dir) {
      return undefined;
    }
    // encodeURIComponent makes any job name a safe, reversible filename.
    return path.join(this.dir, id, `${encodeURIComponent(job)}.log`);
  }

  private markDirty(id: string): void {
    if (!this.dir) {
      return;
    }
    this.dirty.add(id);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushAll(), 300);
    }
  }

  private flushAll(): void {
    this.flushTimer = undefined;
    for (const id of this.dirty) {
      this.flush(id);
    }
  }

  private flush(id: string): void {
    this.dirty.delete(id);
    if (!this.dir) {
      return;
    }
    const jobs = this.cache.get(id);
    if (!jobs) {
      return;
    }
    const data = { jobs: Object.fromEntries(jobs) };
    void fs.writeFile(path.join(this.dir, `${id}.json`), JSON.stringify(data)).catch(
      () => {
        /* best-effort persistence */
      },
    );
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flushAll();
  }
}
