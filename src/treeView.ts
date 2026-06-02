import * as vscode from "vscode";
import { JobIndex } from "./jobIndex";
import { JobFilter } from "./filter";
import { GlciJob } from "./glci";

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
  constructor(public readonly job: GlciJob) {
    super(job.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "glciJob";
    this.description = describeShort(job);
    this.tooltip = buildTooltip(job);
    this.iconPath = iconFor(job);
    // Single click runs the job — the play affordance users expect.
    this.command = {
      title: "Run Job",
      command: "glci.runJob",
      arguments: [job.name],
    };
  }
}

type Node = StageItem | JobItem;

/**
 * Sidebar tree of jobs grouped by stage. Top-level children are stages; their
 * children are the visible jobs in that stage. Visibility follows the shared
 * {@link JobFilter}.
 */
export class JobTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onChangeEmitter.event;

  constructor(
    private readonly index: JobIndex,
    private readonly filter: JobFilter,
  ) {
    index.onDidChange(() => this.onChangeEmitter.fire());
    filter.onDidChange(() => this.onChangeEmitter.fire());
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      return this.index
        .byStage()
        .map((g) => ({
          stage: g.stage,
          jobs: g.jobs.filter((j) => this.filter.isVisible(j)),
        }))
        .filter((g) => g.jobs.length > 0)
        .map((g) => new StageItem(g.stage, g.jobs.length));
    }
    if (element instanceof StageItem) {
      return this.index
        .byStage()
        .find((g) => g.stage === element.stage)
        ?.jobs.filter((j) => this.filter.isVisible(j))
        .map((j) => new JobItem(j)) ?? [];
    }
    return [];
  }
}

function describeShort(job: GlciJob): string {
  const bits: string[] = [];
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

function iconFor(job: GlciJob): vscode.ThemeIcon {
  if (job.when === "never") {
    return new vscode.ThemeIcon("circle-slash");
  }
  if (job.when === "manual") {
    return new vscode.ThemeIcon("person");
  }
  return new vscode.ThemeIcon("play-circle");
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
