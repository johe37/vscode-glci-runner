import * as vscode from "vscode";
import * as path from "node:path";
import { JobIndex } from "./jobIndex";
import { JobFilter } from "./filter";
import { RunHistory, RunRecord, RunStatus } from "./history";
import { RunManager } from "./runManager";
import { GlciJob } from "./glci";

/**
 * Reduce a job's `needs` to plain job names. gitlab-ci-local's `--list-json`
 * may emit each entry either as a bare string or as a `{ job: "name", ... }`
 * object; we accept both so the webview can match needs against job names.
 */
function normalizeNeeds(needs: GlciJob["needs"]): string[] {
  if (!needs) {
    return [];
  }
  return (needs as unknown[])
    .map((n) => (typeof n === "string" ? n : (n as { job?: string }).job))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

/** Random nonce for the webview content-security-policy. */
function nonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/**
 * Where the single webview panel is currently navigated. The extension owns the
 * route (set via `navigate` messages from the webview) and projects only the
 * data the active route needs into each {@link Dashboard.postState} payload.
 */
type Route =
  | { name: "home" }
  | { name: "jobs" }
  | { name: "pipelines" }
  | { name: "pipeline"; runId: string }
  | { name: "jobLog"; runId: string; job: string };

/** Serializable view of one job for the webview board. */
interface JobView {
  name: string;
  stage: string;
  when: string;
  allowFailure: boolean;
  needs: string[];
  hasLocation: boolean;
  status?: string;
  lastRunId?: string;
}

/** GitLab-style run number (e.g. `#42`); falls back to the id for old runs. */
function runTag(rec: RunRecord): string {
  if (typeof rec.number === "number") {
    return `#${rec.number}`;
  }
  return `#${rec.id.split("-")[1] ?? rec.id}`;
}

/**
 * The editor-area panel: a GitLab-styled, multi-view UI for the local runner.
 * It owns no domain state — it projects {@link JobIndex}, {@link JobFilter},
 * {@link RunHistory} and {@link RunManager} into HTML and routes user actions
 * back through the existing `glci.*` commands. Navigation (Home → Jobs /
 * Pipelines → a pipeline run → a job's log) is client-side, but the active
 * {@link Route} lives here so reloads and live updates stay consistent.
 */
export class Dashboard {
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private route: Route = { name: "home" };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly index: JobIndex,
    private readonly filter: JobFilter,
    private readonly history: RunHistory,
    private readonly runManager: RunManager,
    private readonly getRoot: () => string,
  ) {
    // Keep the panel live as the underlying data changes.
    const refresh = () => this.postState();
    this.disposables.push(
      this.index.onDidChange(refresh),
      this.filter.onDidChange(refresh),
      this.history.onDidChange(refresh),
      this.runManager.onDidChangeLive(refresh),
    );
  }

  /** Create the panel (or reveal it), optionally navigating to a route. */
  show(route?: Route): void {
    if (route) {
      this.route = route;
    }
    if (this.panel) {
      this.panel.reveal();
      this.postState();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "glci.pipeline",
      "GitLab CI",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.iconPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "media",
      "icon.svg",
    );
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
      },
      null,
      this.disposables,
    );
    this.panel.webview.onDidReceiveMessage(
      (msg) => void this.onMessage(msg),
      null,
      this.disposables,
    );
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private async onMessage(msg: {
    type: string;
    [k: string]: unknown;
  }): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.postState();
        return;
      case "navigate":
        if (msg.route && typeof msg.route === "object") {
          this.route = msg.route as Route;
          this.postState();
        }
        return;
      case "run":
        vscode.commands.executeCommand("glci.runJob", msg.name);
        return;
      case "runNeeds":
        vscode.commands.executeCommand("glci.runJobWithNeeds", msg.name);
        return;
      case "runStage":
        vscode.commands.executeCommand("glci.runStage", { stage: msg.stage });
        return;
      case "runPipeline": {
        // Land on the new run's detail page, GitLab-style.
        const id = await vscode.commands.executeCommand<string>(
          "glci.runPipeline",
        );
        if (typeof id === "string") {
          this.route = { name: "pipeline", runId: id };
        }
        this.postState();
        return;
      }
      case "goto":
        vscode.commands.executeCommand("glci.goToDefinition", msg.name);
        return;
      case "rerun": {
        // History rows carry their target + kind so re-run reproduces them.
        if (msg.kind === "pipeline") {
          const id = await vscode.commands.executeCommand<string>(
            "glci.runPipeline",
          );
          if (typeof id === "string") {
            this.route = { name: "pipeline", runId: id };
          }
          this.postState();
        } else if (msg.kind === "stage") {
          vscode.commands.executeCommand("glci.runStage", {
            stage: msg.target,
          });
        } else if (msg.kind === "job-needs") {
          vscode.commands.executeCommand("glci.runJobWithNeeds", msg.target);
        } else {
          vscode.commands.executeCommand("glci.runJob", msg.target);
        }
        return;
      }
      case "cancel":
        vscode.commands.executeCommand("glci.cancelRun", msg.id);
        return;
      case "showLog":
        vscode.commands.executeCommand("glci.showRunLog", msg.id);
        return;
      case "showJobLog":
        if (typeof msg.runId === "string" && typeof msg.job === "string") {
          void this.runManager.showJobLog(msg.runId, msg.job);
        }
        return;
      case "refresh":
        vscode.commands.executeCommand("glci.refresh");
        return;
      case "preview":
        vscode.commands.executeCommand("glci.preview");
        return;
      case "validate":
        vscode.commands.executeCommand("glci.validate");
        return;
      case "clearHistory":
        vscode.commands.executeCommand("glci.clearHistory");
        return;
      case "clearJobs":
        vscode.commands.executeCommand("glci.clearJobHistory");
        return;
      case "clearPipelines":
        vscode.commands.executeCommand("glci.clearPipelines");
        return;
      case "deletePipeline":
        vscode.commands.executeCommand("glci.deletePipeline", msg.id);
        return;
      case "toggleNever":
        vscode.commands.executeCommand("glci.toggleHideNever");
        return;
      case "toggleSkipped":
        vscode.commands.executeCommand("glci.toggleHideSkipped");
        return;
    }
  }

  /** Build the stage→jobs board, optionally overlaid with a run's per-job state. */
  private buildStages(overlay?: Record<string, RunStatus>): {
    stage: string;
    jobs: JobView[];
  }[] {
    const toView = (job: GlciJob): JobView => {
      const base = {
        name: job.name,
        stage: job.stage,
        when: job.when,
        allowFailure: job.allow_failure,
        needs: normalizeNeeds(job.needs),
        hasLocation: this.index.getLocation(job.name) !== undefined,
      };
      if (overlay) {
        return { ...base, status: overlay[job.name] };
      }
      const latest = this.history.latestFor(job.name);
      return { ...base, status: latest?.status, lastRunId: latest?.id };
    };

    return this.index
      .byStage()
      .map((g) => ({
        stage: g.stage,
        jobs: g.jobs.filter((j) => this.filter.isVisible(j)).map(toView),
      }))
      .filter((g) => g.jobs.length > 0);
  }

  /** Breadcrumb trail for the active route. */
  private crumbs(runs: readonly RunRecord[]): { label: string; route: Route }[] {
    const home = { label: "Home", route: { name: "home" } as Route };
    const pipelines = {
      label: "Pipelines",
      route: { name: "pipelines" } as Route,
    };
    const jobs = { label: "Jobs", route: { name: "jobs" } as Route };
    switch (this.route.name) {
      case "home":
        return [home];
      case "jobs":
        return [home, jobs];
      case "pipelines":
        return [home, pipelines];
      case "pipeline": {
        const runId = this.route.runId;
        const r = runs.find((x) => x.id === runId && x.kind === "pipeline");
        return [
          home,
          pipelines,
          { label: r ? `Pipeline ${runTag(r)}` : "Pipeline", route: this.route },
        ];
      }
      case "jobLog": {
        const job = this.route.job;
        const runId = this.route.runId;
        const parent = runs.find((x) => x.id === runId);
        if (parent?.kind === "pipeline") {
          return [
            home,
            pipelines,
            {
              label: `Pipeline ${runTag(parent)}`,
              route: { name: "pipeline", runId: parent.id },
            },
            { label: job, route: this.route },
          ];
        }
        return [home, jobs, { label: job, route: this.route }];
      }
    }
  }

  /** Project the live data into a serializable payload for the webview. */
  private async postState(): Promise<void> {
    if (!this.panel) {
      return;
    }
    const runs = this.history.all();

    // A route that points at a run that no longer exists falls back gracefully.
    if (this.route.name === "pipeline") {
      const exists = runs.some(
        (r) => r.id === (this.route as { runId: string }).runId,
      );
      if (!exists) {
        this.route = { name: "pipelines" };
      }
    } else if (this.route.name === "jobLog") {
      const exists = runs.some(
        (r) => r.id === (this.route as { runId: string }).runId,
      );
      if (!exists) {
        this.route = { name: "pipelines" };
      }
    }

    const base = {
      type: "state" as const,
      route: this.route,
      crumbs: this.crumbs(runs),
      root: path.basename(this.getRoot()),
      error: this.index.error ?? null,
      filters: {
        hideNever: this.filter.isHidingNever,
        hideSkipped: this.filter.isHidingSkipped,
        hasSkipConfig: this.filter.hasSkipConfig,
      },
    };

    let payload: Record<string, unknown> = {};
    switch (this.route.name) {
      case "jobs":
        payload = {
          stages: this.buildStages(),
          jobHistory: runs.filter((r) => r.kind !== "pipeline"),
        };
        break;
      case "pipelines":
        payload = {
          pipelines: runs
            .filter((r) => r.kind === "pipeline")
            .map((r) => ({
              id: r.id,
              label: r.label,
              tag: runTag(r),
              kind: r.kind,
              target: r.target,
              status: r.status,
              startTime: r.startTime,
              endTime: r.endTime ?? null,
            })),
        };
        break;
      case "pipeline": {
        const rec = runs.find(
          (r) => r.id === (this.route as { runId: string }).runId,
        );
        const overlay = this.runManager.pipelineStatuses(this.route.runId);
        payload = {
          detail: rec
            ? {
                runId: rec.id,
                label: rec.label,
                tag: runTag(rec),
                status: rec.status,
                startTime: rec.startTime,
                endTime: rec.endTime ?? null,
                hasLive: overlay !== undefined,
                stages: this.buildStages(overlay ?? {}),
              }
            : null,
        };
        break;
      }
      case "jobLog": {
        const rec = runs.find(
          (r) => r.id === (this.route as { runId: string }).runId,
        );
        const overlay = this.runManager.pipelineStatuses(this.route.runId);
        const status =
          overlay?.[this.route.job] ??
          (rec && rec.kind !== "pipeline" && rec.target === this.route.job
            ? rec.status
            : undefined);
        payload = {
          jobLog: {
            runId: this.route.runId,
            job: this.route.job,
            status,
            isPipelineJob: rec?.kind === "pipeline",
            text:
              (await this.runManager.jobLogText(
                this.route.runId,
                this.route.job,
              )) ?? "",
          },
        };
        break;
      }
    }

    this.panel.title =
      this.route.name === "home" ? "GitLab CI" : `GitLab CI — ${titleFor(this.route)}`;
    void this.panel.webview.postMessage({ ...base, ...payload });
  }

  private html(webview: vscode.Webview): string {
    const n = nonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${n}'`,
      `img-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GitLab CI</title>
<style>${STYLES}</style>
</head>
<body>
  <div id="app"></div>
<script nonce="${n}">${SCRIPT}</script>
</body>
</html>`;
  }
}

/** Short, human title fragment for a route (used in the panel tab title). */
function titleFor(route: Route): string {
  switch (route.name) {
    case "jobs":
      return "Jobs";
    case "pipelines":
      return "Pipelines";
    case "pipeline":
      return "Pipeline";
    case "jobLog":
      return route.job;
    default:
      return "";
  }
}

/* The styles and script are kept as plain strings (no bundler templating) so
 * the webview stays a single self-contained document. */

const STYLES = `
:root {
  --pass: #2da160;
  --fail: #dd2b0e;
  --run: #1f75cb;
  --manual: #9e5cf7;
  --skip: var(--vscode-descriptionForeground);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
#app { display: flex; flex-direction: column; min-height: 100vh; }

/* Top bar: breadcrumb + project chip + global actions. */
.topbar {
  position: sticky; top: 0; z-index: 7;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 10px 16px;
  background: var(--vscode-editor-background);
  border-bottom: 1px solid var(--vscode-panel-border);
}
.crumbs { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1 1 auto; }
.crumb { cursor: pointer; color: var(--vscode-textLink-foreground); white-space: nowrap; }
.crumb.current { color: var(--vscode-foreground); cursor: default; font-weight: 600; }
.crumb-sep { color: var(--vscode-descriptionForeground); }
.root {
  font-size: 12px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  padding: 1px 8px; border-radius: 10px; white-space: nowrap;
}
.topbar-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.content { padding: 16px; flex: 1 1 auto; }

.btn {
  font: inherit; cursor: pointer;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #fff);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px; padding: 4px 10px;
}
.btn:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
.btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: transparent;
}
.btn.primary:hover { background: var(--vscode-button-hoverBackground); }
.btn.ghost { background: transparent; }
.btn.danger { color: var(--fail); }
.btn.danger:hover { background: rgba(221,43,14,.12); }
.btn.tiny { padding: 2px 8px; font-size: 11px; }
.btn:disabled { opacity: .5; cursor: default; }
.toggle { font-size: 12px; color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 4px; cursor: pointer; }

.error {
  margin-bottom: 12px; padding: 10px 12px; border-radius: 6px;
  background: rgba(221,43,14,.12); border: 1px solid var(--fail);
  color: var(--vscode-foreground); white-space: pre-wrap;
  font-family: var(--vscode-editor-font-family); font-size: 12px;
}

/* Home hub */
.hub { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 8px; }
.hub-card {
  flex: 1 1 260px; max-width: 360px; cursor: pointer;
  background: var(--vscode-sideBar-background, rgba(127,127,127,.06));
  border: 1px solid var(--vscode-panel-border); border-radius: 10px;
  padding: 20px; display: flex; flex-direction: column; gap: 8px;
}
.hub-card:hover { border-color: var(--manual); }
.hub-card .hub-icon { font-size: 28px; }
.hub-card h2 { margin: 0; font-size: 16px; }
.hub-card p { margin: 0; color: var(--vscode-descriptionForeground); font-size: 12px; }

/* Section headers shared by views */
.view-head {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  margin-bottom: 12px;
}
.view-head h2 { font-size: 15px; margin: 0; }
.view-head .spacer { flex: 1 1 auto; }
.subhead { font-size: 13px; margin: 20px 0 8px; }

/* Board */
.board {
  display: flex; gap: 16px; overflow-x: auto; align-items: flex-start;
  position: relative; padding-bottom: 8px;
}
.dep-svg { position: absolute; top: 0; left: 0; z-index: 6; pointer-events: none; overflow: visible; }
.dep-line { fill: none; stroke: var(--manual); stroke-width: 2; opacity: .85; }
.dep-arrow { fill: var(--manual); }
.card.dep-source { border-color: var(--manual); box-shadow: 0 0 0 1px var(--manual); }
.card.dep-target { border-left-color: var(--manual); box-shadow: 0 0 0 1px var(--manual); }
.stage {
  flex: 0 0 240px; min-width: 240px;
  background: var(--vscode-sideBar-background, rgba(127,127,127,.06));
  border: 1px solid var(--vscode-panel-border); border-radius: 8px;
  display: flex; flex-direction: column;
}
.stage-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border);
}
.stage-head .name { font-weight: 600; text-transform: lowercase; }
.stage-head .count { font-size: 11px; color: var(--vscode-descriptionForeground); }
.stage-body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.card {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-left: 3px solid var(--vscode-panel-border);
  border-radius: 6px; padding: 8px 10px;
}
.card.clickable { cursor: pointer; }
.card.clickable:hover { border-color: var(--run); }
.card.passed { border-left-color: var(--pass); }
.card.failed { border-left-color: var(--fail); }
.card.running { border-left-color: var(--run); }
.card.canceled { border-left-color: var(--skip); }
.card.manual { border-left-color: var(--manual); }
.card.never { opacity: .6; }
.card-top { display: flex; align-items: center; gap: 8px; }
.card-top .icon { flex: none; font-size: 13px; line-height: 1; }
.card-top .jobname { font-weight: 500; word-break: break-all; flex: 1 1 auto; }
.spin { display: inline-block; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.badges { display: flex; gap: 4px; flex-wrap: wrap; margin: 6px 0 2px; }
.badge {
  font-size: 10px; text-transform: uppercase; letter-spacing: .02em;
  padding: 1px 6px; border-radius: 8px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
}
.badge.manual { background: var(--manual); color: #fff; }
.badge.never { background: transparent; border: 1px solid var(--skip); color: var(--skip); }
.badge.warn { background: #c99a00; color: #000; }
.card-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.card-actions .btn { flex: 0 1 auto; min-width: 0; }
.icon-pass { color: var(--pass); }
.icon-fail { color: var(--fail); }
.icon-run { color: var(--run); }
.icon-skip { color: var(--skip); }

/* Pipeline detail header */
.detail-head {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 12px 14px; margin-bottom: 16px; border-radius: 8px;
  background: var(--vscode-sideBar-background, rgba(127,127,127,.06));
  border: 1px solid var(--vscode-panel-border);
}
.detail-head .status-pill {
  font-weight: 600; padding: 2px 10px; border-radius: 10px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
}
.detail-head .status-pill.passed { background: var(--pass); color: #fff; }
.detail-head .status-pill.failed { background: var(--fail); color: #fff; }
.detail-head .status-pill.running { background: var(--run); color: #fff; }
.detail-head .meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
.detail-head .spacer { flex: 1 1 auto; }

/* Run lists (jobs history + pipelines) */
.runlist { display: flex; flex-direction: column; }
.runrow {
  display: grid; grid-template-columns: 18px 1fr auto auto auto; gap: 12px;
  align-items: center; padding: 8px 4px; border-bottom: 1px solid var(--vscode-panel-border);
  font-size: 12px;
}
.runrow.clickable { cursor: pointer; }
.runrow:hover { background: var(--vscode-list-hoverBackground); }
.runrow .rlabel { font-weight: 500; }
.runrow .rkind { font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: 6px; text-transform: uppercase; }
.runrow .meta { color: var(--vscode-descriptionForeground); white-space: nowrap; }
.ractions { display: flex; gap: 6px; justify-content: flex-end; }
.empty { color: var(--vscode-descriptionForeground); padding: 16px 4px; font-style: italic; }

/* Inline job log viewer */
.joblog-head {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px;
}
.log-pane {
  background: #1e1e1e; color: #d4d4d4;
  border: 1px solid var(--vscode-panel-border); border-radius: 6px;
  padding: 10px 12px; margin: 0;
  font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
  white-space: pre-wrap; word-break: break-word;
  max-height: 70vh; overflow: auto;
}
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
const ICONS = { passed: "✔", failed: "✖", running: "●", canceled: "○" };
const ICON_CLASS = { passed: "icon-pass", failed: "icon-fail", running: "icon-run", canceled: "icon-skip" };

let current = null;
let liveTimers = false;

// Job-name -> card element, plus the lazily-created connector overlay.
const cardByName = new Map();
let depSvg = null;
const SVG_NS = "http://www.w3.org/2000/svg";

function nav(route) { vscode.postMessage({ type: "navigate", route: route }); }
function post(type, extra) { vscode.postMessage(Object.assign({ type: type }, extra || {})); }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function btn(label, cls, onClick, title) {
  const b = el("button", "btn " + (cls || ""), label);
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}
function fmtDuration(ms) {
  if (ms == null) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  return m + "m " + (s % 60) + "s";
}
function fmtAgo(ts) {
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}
function statusIcon(status, extraCls) {
  const span = el("span", "icon " + (ICON_CLASS[status] || "icon-skip") + (extraCls ? " " + extraCls : ""), ICONS[status] || "○");
  if (status === "running") span.classList.add("spin");
  return span;
}
function kindText(kind) {
  return kind === "pipeline" ? "pipeline" : kind === "stage" ? "stage" : kind === "job-needs" ? "job + needs" : "job";
}

/* --- Dependency connectors (unchanged behavior) --- */
function ensureDepSvg(board) {
  if (depSvg && depSvg.parentNode === board) return depSvg;
  depSvg = document.createElementNS(SVG_NS, "svg");
  depSvg.setAttribute("class", "dep-svg");
  depSvg.innerHTML =
    '<defs><marker id="dep-arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">' +
    '<path class="dep-arrow" d="M0,0 L7,3 L0,6 Z"/></marker></defs>';
  board.appendChild(depSvg);
  return depSvg;
}
function clearDeps() {
  if (depSvg) depSvg.querySelectorAll("path.dep-line").forEach((p) => p.remove());
  document.querySelectorAll(".card.dep-source, .card.dep-target").forEach((c) => c.classList.remove("dep-source", "dep-target"));
}
function showDeps(job) {
  const board = document.getElementById("board");
  const src = cardByName.get(job.name);
  if (!board || !src) return;
  ensureDepSvg(board);
  clearDeps();
  depSvg.setAttribute("width", board.scrollWidth);
  depSvg.setAttribute("height", board.scrollHeight);
  const bRect = board.getBoundingClientRect();
  const toContent = (rect) => ({
    left: rect.left - bRect.left + board.scrollLeft,
    right: rect.right - bRect.left + board.scrollLeft,
    midY: rect.top + rect.height / 2 - bRect.top + board.scrollTop,
    cx: rect.left + rect.width / 2,
  });
  src.classList.add("dep-source");
  const s = toContent(src.getBoundingClientRect());
  for (const need of job.needs) {
    const tgt = cardByName.get(need);
    if (!tgt) continue;
    tgt.classList.add("dep-target");
    const t = toContent(tgt.getBoundingClientRect());
    let sx, tx, dirS, dirT;
    if (t.cx < s.cx) { sx = s.left; dirS = -1; tx = t.right; dirT = 1; }
    else { sx = s.right; dirS = 1; tx = t.left; dirT = -1; }
    const dx = Math.max(30, Math.abs(tx - sx) * 0.5);
    const d = "M " + sx + " " + s.midY + " C " + (sx + dirS * dx) + " " + s.midY +
      ", " + (tx + dirT * dx) + " " + t.midY + ", " + tx + " " + t.midY;
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", "dep-line");
    path.setAttribute("d", d);
    path.setAttribute("marker-end", "url(#dep-arrow)");
    depSvg.appendChild(path);
  }
}

/* --- Board + cards --- */
function jobStatusClass(job) {
  if (job.status === "running") return "running";
  if (job.status === "passed") return "passed";
  if (job.status === "failed") return "failed";
  if (job.status === "canceled") return "canceled";
  if (job.when === "never") return "never";
  if (job.when === "manual") return "manual";
  return "";
}
function jobIcon(job) {
  if (job.status && ICONS[job.status]) {
    const span = el("span", "icon " + (ICON_CLASS[job.status] || ""), ICONS[job.status]);
    if (job.status === "running") span.classList.add("spin");
    return span;
  }
  if (job.when === "never") return el("span", "icon icon-skip", "⊘");
  if (job.when === "manual") return el("span", "icon", "▸");
  return el("span", "icon icon-skip", "○");
}
function renderBoard(stages, mode, runId) {
  const board = el("main", "board");
  board.id = "board";
  cardByName.clear();
  depSvg = null;
  if (!stages.length) {
    board.appendChild(el("div", "empty", "No jobs to show. Refresh, or adjust the filters."));
    return board;
  }
  for (const stage of stages) {
    const col = el("div", "stage");
    const head = el("div", "stage-head");
    head.appendChild(el("span", "name", stage.stage));
    const right = el("div");
    right.appendChild(el("span", "count", stage.jobs.length + (stage.jobs.length === 1 ? " job" : " jobs")));
    head.appendChild(right);
    col.appendChild(head);
    const body = el("div", "stage-body");
    for (const job of stage.jobs) body.appendChild(renderCard(job, mode, runId));
    col.appendChild(body);
    board.appendChild(col);
  }
  return board;
}
function renderCard(job, mode, runId) {
  const card = el("div", "card " + jobStatusClass(job));
  card.dataset.job = job.name;
  cardByName.set(job.name, card);
  if (job.needs && job.needs.length) {
    card.addEventListener("mouseenter", () => showDeps(job));
    card.addEventListener("mouseleave", clearDeps);
  }
  // In a pipeline run the whole card opens that job's log.
  if (mode === "pipeline") {
    card.classList.add("clickable");
    card.addEventListener("click", () => nav({ name: "jobLog", runId: runId, job: job.name }));
  }
  const top = el("div", "card-top");
  top.appendChild(jobIcon(job));
  top.appendChild(el("span", "jobname", job.name));
  card.appendChild(top);

  const badges = el("div", "badges");
  if (job.when === "manual") badges.appendChild(el("span", "badge manual", "manual"));
  if (job.when === "never") badges.appendChild(el("span", "badge never", "never"));
  if (job.allowFailure) badges.appendChild(el("span", "badge warn", "allow failure"));
  if (job.needs && job.needs.length) badges.appendChild(el("span", "badge", "needs " + job.needs.length));
  if (badges.childNodes.length) card.appendChild(badges);

  const actions = el("div", "card-actions");
  if (mode === "jobs") {
    const isRunning = job.status === "running";
    const run = btn(isRunning ? "Running…" : "▶ Run", "primary tiny", (e) => { e.stopPropagation(); post("run", { name: job.name }); });
    run.disabled = isRunning;
    actions.appendChild(run);
    actions.appendChild(btn("+ needs", "tiny", (e) => { e.stopPropagation(); post("runNeeds", { name: job.name }); }, "Run with needs"));
    if (job.hasLocation) actions.appendChild(btn("Definition", "ghost tiny", (e) => { e.stopPropagation(); post("goto", { name: job.name }); }));
    if (job.lastRunId) actions.appendChild(btn("Log", "ghost tiny", (e) => { e.stopPropagation(); post("showLog", { id: job.lastRunId }); }, "Show this job's last run output"));
  } else if (mode === "pipeline") {
    actions.appendChild(btn("View log", "ghost tiny", (e) => { e.stopPropagation(); nav({ name: "jobLog", runId: runId, job: job.name }); }));
    if (job.hasLocation) actions.appendChild(btn("Definition", "ghost tiny", (e) => { e.stopPropagation(); post("goto", { name: job.name }); }));
  }
  if (actions.childNodes.length) card.appendChild(actions);
  return card;
}

/* --- Top bar --- */
function renderTopbar(state) {
  const bar = el("header", "topbar");
  const crumbs = el("div", "crumbs");
  (state.crumbs || []).forEach((c, i) => {
    if (i > 0) crumbs.appendChild(el("span", "crumb-sep", "▸"));
    const last = i === state.crumbs.length - 1;
    const node = el("span", "crumb" + (last ? " current" : ""), c.label);
    if (!last) node.addEventListener("click", () => nav(c.route));
    crumbs.appendChild(node);
  });
  bar.appendChild(crumbs);
  if (state.root) bar.appendChild(el("span", "root", state.root));
  const actions = el("div", "topbar-actions");
  actions.appendChild(btn("⟳ Refresh", "ghost tiny", () => post("refresh"), "Re-list jobs"));
  actions.appendChild(btn("Preview", "ghost tiny", () => post("preview"), "Expand the pipeline"));
  actions.appendChild(btn("Validate", "ghost tiny", () => post("validate"), "Validate dependency chain"));
  bar.appendChild(actions);
  return bar;
}

/* --- Views --- */
function renderHome(state) {
  const c = el("div", "content");
  if (state.error) c.appendChild(errorBanner(state.error));
  const hub = el("div", "hub");

  const jobsCard = el("div", "hub-card");
  jobsCard.appendChild(el("div", "hub-icon", "▶"));
  jobsCard.appendChild(el("h2", null, "Test Jobs"));
  jobsCard.appendChild(el("p", null, "Browse the CI jobs in this project and trigger them one at a time. See the history of every job you've run locally."));
  jobsCard.addEventListener("click", () => nav({ name: "jobs" }));
  hub.appendChild(jobsCard);

  const pipeCard = el("div", "hub-card");
  pipeCard.appendChild(el("div", "hub-icon", "⚙"));
  pipeCard.appendChild(el("h2", null, "Pipelines"));
  pipeCard.appendChild(el("p", null, "Run the full pipeline and watch each job live. Browse every pipeline that has run locally and inspect any job's output."));
  pipeCard.addEventListener("click", () => nav({ name: "pipelines" }));
  hub.appendChild(pipeCard);

  c.appendChild(hub);
  return c;
}

function errorBanner(text) {
  return el("div", "error", text);
}

function renderJobs(state) {
  const c = el("div", "content");
  if (state.error) c.appendChild(errorBanner(state.error));
  const head = el("div", "view-head");
  head.appendChild(el("h2", null, "Jobs"));
  head.appendChild(el("span", "spacer"));
  const never = el("label", "toggle");
  const neverCb = el("input"); neverCb.type = "checkbox"; neverCb.checked = state.filters.hideNever;
  neverCb.addEventListener("change", () => post("toggleNever"));
  never.appendChild(neverCb); never.appendChild(document.createTextNode(" Hide never"));
  head.appendChild(never);
  if (state.filters.hasSkipConfig) {
    const skip = el("label", "toggle");
    const skipCb = el("input"); skipCb.type = "checkbox"; skipCb.checked = state.filters.hideSkipped;
    skipCb.addEventListener("change", () => post("toggleSkipped"));
    skip.appendChild(skipCb); skip.appendChild(document.createTextNode(" Hide skipped"));
    head.appendChild(skip);
  }
  c.appendChild(head);
  c.appendChild(renderBoard(state.stages || [], "jobs"));

  const sub = el("div", "view-head");
  sub.appendChild(el("h3", "subhead", "Job run history"));
  sub.appendChild(el("span", "spacer"));
  sub.appendChild(btn("Clear", "ghost tiny", () => post("clearJobs")));
  c.appendChild(sub);
  c.appendChild(renderRunList(state.jobHistory || [], "job"));
  return c;
}

function renderPipelines(state) {
  const c = el("div", "content");
  const head = el("div", "view-head");
  head.appendChild(el("h2", null, "Pipelines"));
  head.appendChild(el("span", "spacer"));
  head.appendChild(btn("▶ Run pipeline", "primary", () => post("runPipeline"), "Run every job in order, like a real pipeline"));
  if ((state.pipelines || []).length) head.appendChild(btn("Clear all", "ghost danger", () => post("clearPipelines"), "Remove all pipeline runs and their saved logs"));
  c.appendChild(head);
  c.appendChild(renderRunList(state.pipelines || [], "pipeline"));
  return c;
}

// One reusable list for both job-history and pipeline rows.
function renderRunList(rows, kind) {
  const list = el("div", "runlist");
  if (!rows.length) {
    list.appendChild(el("div", "empty", kind === "pipeline"
      ? "No pipelines have run yet. Click “Run pipeline” to start one."
      : "No runs yet. Trigger a job to start one."));
    return list;
  }
  for (const r of rows) {
    const row = el("div", "runrow" + (kind === "pipeline" ? " clickable" : ""));
    if (kind === "pipeline") row.addEventListener("click", () => nav({ name: "pipeline", runId: r.id }));
    row.appendChild(statusIcon(r.status));
    const label = el("div");
    if (kind === "pipeline") {
      label.appendChild(el("span", "rlabel", "Pipeline " + (r.tag || "")));
    } else {
      label.appendChild(el("span", "rlabel", r.label));
      label.appendChild(el("span", "rkind", kindText(r.kind)));
    }
    row.appendChild(label);
    row.appendChild(el("span", "meta", fmtAgo(r.startTime)));
    const dur = r.endTime ? fmtDuration(r.endTime - r.startTime) : fmtDuration(Date.now() - r.startTime);
    const durSpan = el("span", "meta", dur);
    if (r.status === "running") { durSpan.classList.add("live-dur"); durSpan.dataset.start = String(r.startTime); }
    row.appendChild(durSpan);
    const actions = el("div", "ractions");
    if (kind === "pipeline") actions.appendChild(btn("Open", "ghost tiny", (e) => { e.stopPropagation(); nav({ name: "pipeline", runId: r.id }); }));
    actions.appendChild(btn("Log", "ghost tiny", (e) => { e.stopPropagation(); post("showLog", { id: r.id }); }, "Show captured output"));
    if (r.status === "running") {
      actions.appendChild(btn("Cancel", "ghost tiny", (e) => { e.stopPropagation(); post("cancel", { id: r.id }); }));
    } else {
      actions.appendChild(btn("Re-run", "ghost tiny", (e) => { e.stopPropagation(); post("rerun", { target: r.target, kind: r.kind }); }));
      if (kind === "pipeline") actions.appendChild(btn("Delete", "ghost tiny danger", (e) => { e.stopPropagation(); post("deletePipeline", { id: r.id }); }, "Remove this pipeline run and its saved logs"));
    }
    row.appendChild(actions);
    list.appendChild(row);
  }
  return list;
}

function renderPipelineDetail(state) {
  const c = el("div", "content");
  const d = state.detail;
  if (!d) {
    c.appendChild(el("div", "empty", "This pipeline run is no longer available."));
    return c;
  }
  let running = 0, passed = 0, failed = 0, pending = 0;
  for (const s of d.stages) for (const j of s.jobs) {
    if (j.status === "running") running++;
    else if (j.status === "passed") passed++;
    else if (j.status === "failed") failed++;
    else pending++;
  }
  const head = el("div", "detail-head");
  head.appendChild(el("span", "status-pill " + d.status, d.status));
  head.appendChild(el("span", "rlabel", "Pipeline " + d.tag));
  const dur = d.endTime ? fmtDuration(d.endTime - d.startTime) : fmtDuration(Date.now() - d.startTime);
  const durSpan = el("span", "meta", "started " + fmtAgo(d.startTime) + " · " + dur);
  if (d.status === "running") { durSpan.classList.add("live-dur"); durSpan.dataset.start = String(d.startTime); durSpan.dataset.prefix = "started " + fmtAgo(d.startTime) + " · "; }
  head.appendChild(durSpan);
  head.appendChild(el("span", "meta", running + " running · " + passed + " passed · " + failed + " failed · " + pending + " pending"));
  head.appendChild(el("span", "spacer"));
  if (d.status === "running") head.appendChild(btn("Cancel", "ghost", () => post("cancel", { id: d.runId })));
  else head.appendChild(btn("↻ Re-run", "ghost", () => post("rerun", { target: "pipeline", kind: "pipeline" })));
  c.appendChild(head);

  if (!d.hasLive && d.status !== "running") {
    c.appendChild(el("div", "empty", "No per-job detail was captured for this run."));
  }
  c.appendChild(renderBoard(d.stages || [], "pipeline", d.runId));
  return c;
}

function renderJobLog(state) {
  const c = el("div", "content");
  const j = state.jobLog;
  const head = el("div", "joblog-head");
  if (j.status) head.appendChild(statusIcon(j.status));
  head.appendChild(el("h2", null, j.job));
  if (j.status) head.appendChild(el("span", "meta", j.status));
  head.appendChild(el("span", "spacer"));
  if (j.isPipelineJob) head.appendChild(btn("Show in Output", "ghost tiny", () => post("showJobLog", { runId: j.runId, job: j.job })));
  else head.appendChild(btn("Show in Output", "ghost tiny", () => post("showLog", { id: j.runId })));
  c.appendChild(head);
  const pane = el("pre", "log-pane");
  pane.id = "logPane";
  pane.textContent = j.text && j.text.length ? j.text : "No captured output for this job yet.";
  c.appendChild(pane);
  return c;
}

/* --- Render dispatch --- */
function render() {
  if (!current) return;
  const app = document.getElementById("app");
  app.innerHTML = "";
  app.appendChild(renderTopbar(current));
  let view;
  switch (current.route.name) {
    case "home": view = renderHome(current); break;
    case "jobs": view = renderJobs(current); break;
    case "pipelines": view = renderPipelines(current); break;
    case "pipeline": view = renderPipelineDetail(current); break;
    case "jobLog": view = renderJobLog(current); break;
    default: view = renderHome(current);
  }
  app.appendChild(view);
  // Keep a long live log scrolled to the bottom.
  const pane = document.getElementById("logPane");
  if (pane) pane.scrollTop = pane.scrollHeight;
}

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg.type !== "state") return;
  current = msg;
  liveTimers = !!(
    (msg.pipelines && msg.pipelines.some((r) => r.status === "running")) ||
    (msg.jobHistory && msg.jobHistory.some((r) => r.status === "running")) ||
    (msg.detail && msg.detail.status === "running")
  );
  render();
});

// Tick running-duration counters once a second without a full re-render.
setInterval(() => {
  if (!liveTimers) return;
  document.querySelectorAll(".live-dur[data-start]").forEach((node) => {
    const start = Number(node.dataset.start);
    const s = Math.round((Date.now() - start) / 1000);
    const dur = s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
    node.textContent = (node.dataset.prefix || "") + dur;
  });
}, 1000);

vscode.postMessage({ type: "ready" });
`;
