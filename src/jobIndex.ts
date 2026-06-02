import * as vscode from "vscode";
import { parseDocument, LineCounter, isMap, isScalar } from "yaml";
import { Glci, GlciJob } from "./glci";

/** Top-level YAML keys that are never jobs. */
const RESERVED_KEYS = new Set([
  "stages",
  "include",
  "variables",
  "default",
  "workflow",
  "image",
  "services",
  "cache",
  "before_script",
  "after_script",
  "pages",
  "spec",
]);

/**
 * Holds the authoritative job list (from `gitlab-ci-local --list-json`) plus a
 * map from job name to the YAML location where it is defined. The list drives
 * what is runnable; the location map powers "go to definition" and the tree.
 */
export class JobIndex {
  private jobs: GlciJob[] = [];
  private locations = new Map<string, vscode.Location>();
  private lastError: string | undefined;

  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onChangeEmitter.event;

  constructor(
    private readonly glci: Glci,
    private readonly getRoot: () => string,
  ) {}

  /** Re-list jobs and re-scan YAML for their definition locations. */
  async refresh(): Promise<void> {
    try {
      this.jobs = await this.glci.listJobs();
      this.lastError = undefined;
    } catch (err) {
      this.jobs = [];
      this.lastError = (err as Error).message;
    }
    await this.rebuildLocations();
    this.onChangeEmitter.fire();
  }

  getJobs(): GlciJob[] {
    return this.jobs;
  }

  getJob(name: string): GlciJob | undefined {
    return this.jobs.find((j) => j.name === name);
  }

  getLocation(name: string): vscode.Location | undefined {
    return this.locations.get(name);
  }

  get error(): string | undefined {
    return this.lastError;
  }

  /** Distinct stages in pipeline declaration order, with their jobs. */
  byStage(): Array<{ stage: string; jobs: GlciJob[] }> {
    const order: string[] = [];
    const map = new Map<string, GlciJob[]>();
    for (const job of this.jobs) {
      if (!map.has(job.stage)) {
        map.set(job.stage, []);
        order.push(job.stage);
      }
      map.get(job.stage)!.push(job);
    }
    return order.map((stage) => ({ stage, jobs: map.get(stage)! }));
  }

  private async rebuildLocations(): Promise<void> {
    this.locations.clear();
    if (this.jobs.length === 0) {
      return;
    }
    const jobNames = new Set(this.jobs.map((j) => j.name));
    const globs = vscode.workspace
      .getConfiguration("glci")
      .get<string[]>("ciFileGlobs") ?? [];
    // Base the search on the resolved project root so a custom root (e.g. a
    // subfolder of the workspace) is honored rather than the whole workspace.
    const base = vscode.Uri.file(this.getRoot());
    const pattern = new vscode.RelativePattern(base, `{${globs.join(",")}}`);
    const files = await vscode.workspace.findFiles(pattern, "**/node_modules/**");
    for (const file of files) {
      await this.indexFile(file, jobNames);
    }
  }

  private async indexFile(uri: vscode.Uri, jobNames: Set<string>): Promise<void> {
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      text = Buffer.from(bytes).toString("utf8");
    } catch {
      return;
    }
    const lineCounter = new LineCounter();
    let doc;
    try {
      doc = parseDocument(text, { lineCounter });
    } catch {
      return; // Skip unparseable YAML rather than failing the whole index.
    }
    if (!isMap(doc.contents)) {
      return;
    }
    for (const item of doc.contents.items) {
      const keyNode = item.key;
      if (!isScalar(keyNode) || typeof keyNode.value !== "string") {
        continue;
      }
      const name = keyNode.value;
      if (
        name.startsWith(".") ||
        RESERVED_KEYS.has(name) ||
        !jobNames.has(name) ||
        this.locations.has(name)
      ) {
        continue;
      }
      const offset = keyNode.range?.[0];
      if (offset === undefined) {
        continue;
      }
      const { line, col } = lineCounter.linePos(offset);
      const position = new vscode.Position(line - 1, col - 1);
      this.locations.set(name, new vscode.Location(uri, position));
    }
  }

  dispose(): void {
    this.onChangeEmitter.dispose();
  }
}
