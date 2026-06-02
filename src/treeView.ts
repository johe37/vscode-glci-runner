import * as vscode from "vscode";
import { JobIndex } from "./jobIndex";
import { JobFilter } from "./filter";
import { RunHistory, RunRecord, RunStatus } from "./history";
import { GlciJob } from "./glci";

type RootKey = "jobs" | "pipelines";

/** Top-level section header ("Jobs" / "Pipelines"). */
class RootItem extends vscode.TreeItem {
  constructor(public readonly key: RootKey) {
    super(
      key === "jobs" ? "Jobs" : "Pipelines",
      vscode.TreeItemCollapsibleState.Expanded,
    );
    this.contextValue = `glciRoot_${key}`;
    this.iconPath = new vscode.ThemeIcon(
      key === "jobs" ? "briefcase" : "rocket",
    );
  }
}

/** A stage grouping node in the tree. */
class StageItem extends vscode.TreeItem {
  constructor(
    public readonly stage: string,
    jobCount: number,
  ) {
    super(stage, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "glciStage";
    this.description = `${jobCount} job${jobCount === 1 ? "" : "s"}`;
    this.iconPath = new vscode.ThemeIcon("layers");
  }
}

/** A single job leaf node. */
class JobItem extends vscode.TreeItem {
  constructor(
    public readonly job: GlciJob,
    lastStatus?: RunStatus,
  ) {
    super(job.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "glciJob";
    this.description = describeShort(job, lastStatus);
    this.tooltip = buildTooltip(job);
    this.iconPath = iconFor(job, lastStatus);
    // Single click runs the job — the play affordance users expect.
    this.command = {
      title: "Run Job",
      command: "glci.runJob",
      arguments: [job.name],
    };
  }
}

/** A pipeline run leaf node. */
class PipelineItem extends vscode.TreeItem {
  constructor(public readonly record: RunRecord) {
    const label = record.number != null ? `#${record.number}` : record.label;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "glciPipeline";
    this.description = pipelineDescription(record);
    this.tooltip = buildPipelineTooltip(record);
    this.iconPath = pipelineIcon(record.status);
    this.command = {
      title: "Open Pipelines",
      command: "glci.openPipelines",
    };
  }
}

type Node = RootItem | StageItem | JobItem | PipelineItem;

/**
 * Sidebar tree with two top-level sections: Jobs (grouped by stage) and
 * Pipelines (whole-pipeline runs, newest first). Visibility of jobs follows
 * the shared {@link JobFilter}.
 */
export class JobTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onChangeEmitter.event;

  constructor(
    private readonly index: JobIndex,
    private readonly filter: JobFilter,
    private readonly history: RunHistory,
  ) {
    index.onDidChange(() => this.onChangeEmitter.fire());
    filter.onDidChange(() => this.onChangeEmitter.fire());
    history.onDidChange(() => this.onChangeEmitter.fire());
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      return [new RootItem("jobs"), new RootItem("pipelines")];
    }
    if (element instanceof RootItem && element.key === "jobs") {
      return this.index
        .byStage()
        .map((g) => ({
          stage: g.stage,
          jobs: g.jobs.filter((j) => this.filter.isVisible(j)),
        }))
        .filter((g) => g.jobs.length > 0)
        .map((g) => new StageItem(g.stage, g.jobs.length));
    }
    if (element instanceof RootItem && element.key === "pipelines") {
      return this.history
        .all()
        .filter((r) => r.kind === "pipeline")
        .map((r) => new PipelineItem(r));
    }
    if (element instanceof StageItem) {
      return (
        this.index
          .byStage()
          .find((g) => g.stage === element.stage)
          ?.jobs.filter((j) => this.filter.isVisible(j))
          .map((j) => new JobItem(j, this.history.latestFor(j.name)?.status)) ??
        []
      );
    }
    return [];
  }
}

function describeShort(job: GlciJob, lastStatus?: RunStatus): string {
  const bits: string[] = [];
  if (lastStatus) {
    bits.push(lastStatus);
  }
  if (job.when === "never") {
    bits.push("never");
  } else if (job.when === "manual") {
    bits.push("manual");
  }
  if (job.allow_failure) {
    bits.push("allow_failure");
  }
  return bits.join(" · ");
}

/** Theme-colored status glyph for the last run, falling back to a when-icon. */
function iconFor(job: GlciJob, lastStatus?: RunStatus): vscode.ThemeIcon {
  switch (lastStatus) {
    case "running":
      return new vscode.ThemeIcon(
        "loading~spin",
        new vscode.ThemeColor("charts.blue"),
      );
    case "passed":
      return new vscode.ThemeIcon(
        "pass-filled",
        new vscode.ThemeColor("testing.iconPassed"),
      );
    case "failed":
      return new vscode.ThemeIcon(
        "error",
        new vscode.ThemeColor("testing.iconFailed"),
      );
    case "canceled":
      return new vscode.ThemeIcon(
        "circle-slash",
        new vscode.ThemeColor("testing.iconSkipped"),
      );
  }
  if (job.when === "never") {
    return new vscode.ThemeIcon("circle-slash");
  }
  if (job.when === "manual") {
    return new vscode.ThemeIcon("person");
  }
  return new vscode.ThemeIcon("play-circle");
}

function pipelineDescription(record: RunRecord): string {
  const parts: string[] = [record.status];
  if (record.endTime) {
    const secs = Math.round((record.endTime - record.startTime) / 1000);
    parts.push(`${secs}s`);
  }
  return parts.join(" · ");
}

function pipelineIcon(status: RunStatus): vscode.ThemeIcon {
  switch (status) {
    case "running":
      return new vscode.ThemeIcon(
        "loading~spin",
        new vscode.ThemeColor("charts.blue"),
      );
    case "passed":
      return new vscode.ThemeIcon(
        "pass-filled",
        new vscode.ThemeColor("testing.iconPassed"),
      );
    case "failed":
      return new vscode.ThemeIcon(
        "error",
        new vscode.ThemeColor("testing.iconFailed"),
      );
    case "canceled":
      return new vscode.ThemeIcon(
        "circle-slash",
        new vscode.ThemeColor("testing.iconSkipped"),
      );
  }
}

function buildPipelineTooltip(record: RunRecord): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const label =
    record.number != null ? `Pipeline #${record.number}` : record.label;
  md.appendMarkdown(`**${label}**\n\n`);
  md.appendMarkdown(`- status: \`${record.status}\`\n`);
  const started = new Date(record.startTime).toLocaleString();
  md.appendMarkdown(`- started: ${started}\n`);
  if (record.endTime) {
    const secs = Math.round((record.endTime - record.startTime) / 1000);
    md.appendMarkdown(`- duration: ${secs}s\n`);
  }
  return md;
}

function buildTooltip(job: GlciJob): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${job.name}**\n\n`);
  if (job.description) {
    md.appendMarkdown(`${job.description}\n\n`);
  }
  md.appendMarkdown(`- stage: \`${job.stage}\`\n`);
  md.appendMarkdown(`- when: \`${job.when}\`\n`);
  md.appendMarkdown(`- allow_failure: \`${job.allow_failure}\`\n`);
  if (job.needs && job.needs.length > 0) {
    md.appendMarkdown(`- needs: ${job.needs.map((n) => `\`${n}\``).join(", ")}\n`);
  }
  if (job.rules && job.rules.length > 0) {
    md.appendMarkdown(`\n**Rules**\n`);
    for (const rule of job.rules) {
      const cond = rule.if ?? "(changes/exists)";
      const when = rule.when ? ` → ${rule.when}` : "";
      md.appendMarkdown(`- \`${cond}\`${when}\n`);
    }
  }
  return md;
}
