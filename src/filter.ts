import * as vscode from "vscode";
import * as toml from "@iarna/toml";
import { GlciJob } from "./glci";

const HIDE_NEVER_KEY = "glci.hideNever";
const HIDE_SKIPPED_KEY = "glci.hideSkipped";

/**
 * The `[skip]` table of a project's `.glciconfig.toml`, naming stages and jobs
 * that the user has chosen to exclude from local runs.
 */
interface SkipConfig {
  stages: string[];
  jobs: string[];
}

/**
 * Tracks which jobs are visible. Two independent toggles:
 *  - hideNever: hide jobs whose effective `when` is `never`.
 *  - hideSkipped: hide jobs/stages listed in `.glciconfig.toml [skip]`.
 * Toggle state is persisted per-workspace; the skip list is re-read on refresh.
 */
export class JobFilter {
  private hideNever: boolean;
  private hideSkipped: boolean;
  private skip: SkipConfig = { stages: [], jobs: [] };

  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onChangeEmitter.event;

  constructor(
    private readonly state: vscode.Memento,
    private readonly root: () => string,
  ) {
    const cfg = vscode.workspace.getConfiguration("glci");
    this.hideNever = state.get<boolean>(
      HIDE_NEVER_KEY,
      cfg.get<boolean>("hideNeverByDefault", false),
    );
    this.hideSkipped = state.get<boolean>(HIDE_SKIPPED_KEY, false);
  }

  /** Re-read `.glciconfig.toml` from disk. Call on activation and refresh. */
  async reloadSkipConfig(): Promise<void> {
    this.skip = { stages: [], jobs: [] };
    const uri = vscode.Uri.joinPath(vscode.Uri.file(this.root()), ".glciconfig.toml");
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const parsed = toml.parse(Buffer.from(bytes).toString("utf8")) as Record<
        string,
        unknown
      >;
      const skip = parsed.skip as Record<string, unknown> | undefined;
      if (skip) {
        this.skip.stages = asStringArray(skip.stages);
        this.skip.jobs = asStringArray(skip.jobs);
      }
    } catch {
      // No config file — nothing to skip.
    }
  }

  get isHidingNever(): boolean {
    return this.hideNever;
  }

  get isHidingSkipped(): boolean {
    return this.hideSkipped;
  }

  /** True if `.glciconfig.toml` actually contributes a skip list. */
  get hasSkipConfig(): boolean {
    return this.skip.stages.length > 0 || this.skip.jobs.length > 0;
  }

  async toggleHideNever(): Promise<void> {
    this.hideNever = !this.hideNever;
    await this.state.update(HIDE_NEVER_KEY, this.hideNever);
    this.onChangeEmitter.fire();
  }

  async toggleHideSkipped(): Promise<void> {
    this.hideSkipped = !this.hideSkipped;
    await this.state.update(HIDE_SKIPPED_KEY, this.hideSkipped);
    this.onChangeEmitter.fire();
  }

  /** Whether a job passes the current filters. */
  isVisible(job: GlciJob): boolean {
    if (this.hideNever && job.when === "never") {
      return false;
    }
    if (this.hideSkipped && this.isSkipped(job)) {
      return false;
    }
    return true;
  }

  private isSkipped(job: GlciJob): boolean {
    return (
      this.skip.jobs.includes(job.name) || this.skip.stages.includes(job.stage)
    );
  }

  dispose(): void {
    this.onChangeEmitter.dispose();
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
