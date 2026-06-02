import * as vscode from "vscode";
import * as path from "node:path";
import { JobIndex } from "./jobIndex";
import { JobFilter } from "./filter";
import { RunHistory } from "./history";
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

/** Serializable view of one job for the webview. */
interface JobView {
  name: string;
  stage: string;
  when: string;
  allowFailure: boolean;
  needs: string[];
  hasLocation: boolean;
  status?: string;
  lastRunId?: string;
  /** When set, this card's status/log come from a pipeline run's live state. */
  pipelineRunId?: string;
}

/**
 * The editor-area "Pipeline" panel: a GitLab-styled view of the pipeline with
 * stages as columns of job cards (each carrying its latest run status), plus a
 * live run-history section. It owns no state — it projects {@link JobIndex},
 * {@link JobFilter} and {@link RunHistory} into HTML and routes user actions
 * back through the existing `glci.*` commands.
 */
export class Dashboard {
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /** A past pipeline run the user clicked "Overview" on (a live run wins over this). */
  private focusedPipelineRunId?: string;

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

  /** Create the panel, or reveal it if already open. */
  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "glci.pipeline",
      "GitLab CI: Pipeline",
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
      (msg) => this.onMessage(msg),
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

  private onMessage(msg: { type: string; [k: string]: unknown }): void {
    switch (msg.type) {
      case "ready":
        this.postState();
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
      case "runPipeline":
        vscode.commands.executeCommand("glci.runPipeline");
        return;
      case "openPipelineRun":
        if (typeof msg.id === "string") {
          this.focusedPipelineRunId = msg.id;
          this.postState();
        }
        return;
      case "exitPipelineOverview":
        this.focusedPipelineRunId = undefined;
        this.postState();
        return;
      case "showJobLog":
        if (typeof msg.runId === "string" && typeof msg.job === "string") {
          this.runManager.showJobLog(msg.runId, msg.job);
        }
        return;
      case "goto":
        vscode.commands.executeCommand("glci.goToDefinition", msg.name);
        return;
      case "rerun":
        // History rows carry their target + kind so re-run reproduces them.
        if (msg.kind === "pipeline") {
          vscode.commands.executeCommand("glci.runPipeline");
        } else if (msg.kind === "stage") {
          vscode.commands.executeCommand("glci.runStage", { stage: msg.target });
        } else if (msg.kind === "job-needs") {
          vscode.commands.executeCommand("glci.runJobWithNeeds", msg.target);
        } else {
          vscode.commands.executeCommand("glci.runJob", msg.target);
        }
        return;
      case "cancel":
        vscode.commands.executeCommand("glci.cancelRun", msg.id);
        return;
      case "showLog":
        vscode.commands.executeCommand("glci.showRunLog", msg.id);
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
      case "toggleNever":
        vscode.commands.executeCommand("glci.toggleHideNever");
        return;
      case "toggleSkipped":
        vscode.commands.executeCommand("glci.toggleHideSkipped");
        return;
    }
  }

  /** Project the live data into a serializable payload for the webview. */
  private postState(): void {
    if (!this.panel) {
      return;
    }
    // A *running* pipeline auto-takes the board (so progress shows without a
    // click); otherwise honor a run the user explicitly opened via "Overview".
    const runs = this.history.all();
    const liveRun = runs.find(
      (r) => r.kind === "pipeline" && r.status === "running",
    );
    const focusRun =
      liveRun ??
      (this.focusedPipelineRunId
        ? runs.find(
            (r) =>
              r.id === this.focusedPipelineRunId && r.kind === "pipeline",
          )
        : undefined);
    const overlay = focusRun
      ? this.runManager.pipelineStatuses(focusRun.id)
      : undefined;

    const toView = (job: GlciJob): JobView => {
      if (overlay && focusRun) {
        // In overview mode the card reflects this pipeline run's per-job state;
        // jobs not yet started have no entry (shown as pending).
        const status = overlay[job.name];
        return {
          name: job.name,
          stage: job.stage,
          when: job.when,
          allowFailure: job.allow_failure,
          needs: normalizeNeeds(job.needs),
          hasLocation: this.index.getLocation(job.name) !== undefined,
          status,
          pipelineRunId: status !== undefined ? focusRun.id : undefined,
        };
      }
      return {
        name: job.name,
        stage: job.stage,
        when: job.when,
        allowFailure: job.allow_failure,
        needs: normalizeNeeds(job.needs),
        hasLocation: this.index.getLocation(job.name) !== undefined,
        status: this.history.latestFor(job.name)?.status,
        lastRunId: this.history.latestFor(job.name)?.id,
      };
    };

    const stages = this.index
      .byStage()
      .map((g) => ({
        stage: g.stage,
        jobs: g.jobs.filter((j) => this.filter.isVisible(j)).map(toView),
      }))
      .filter((g) => g.jobs.length > 0);

    void this.panel.webview.postMessage({
      type: "state",
      root: path.basename(this.getRoot()),
      error: this.index.error ?? null,
      filters: {
        hideNever: this.filter.isHidingNever,
        hideSkipped: this.filter.isHidingSkipped,
        hasSkipConfig: this.filter.hasSkipConfig,
      },
      focus: focusRun
        ? {
            runId: focusRun.id,
            status: focusRun.status,
            startTime: focusRun.startTime,
            endTime: focusRun.endTime ?? null,
          }
        : null,
      stages,
      history: runs,
    });
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
<title>GitLab CI: Pipeline</title>
<style>${STYLES}</style>
</head>
<body>
  <header class="toolbar">
    <div class="title">
      <span class="dot brand"></span>
      <h1>Pipeline</h1>
      <span class="root" id="root"></span>
    </div>
    <div class="actions">
      <button class="btn primary" data-act="runPipeline" title="Run every job in order, like a real pipeline">▶ Run pipeline</button>
      <button class="btn" data-act="refresh" title="Re-list jobs">⟳ Refresh</button>
      <button class="btn" data-act="preview" title="Expand the pipeline">Preview</button>
      <button class="btn" data-act="validate" title="Validate dependency chain">Validate</button>
      <label class="toggle"><input type="checkbox" id="hideNever"> Hide never</label>
      <label class="toggle" id="hideSkippedWrap"><input type="checkbox" id="hideSkipped"> Hide skipped</label>
    </div>
  </header>

  <div id="error" class="error" hidden></div>

  <div id="focusBar" class="focusbar" hidden></div>

  <main id="board" class="board"></main>

  <section class="history">
    <div class="history-head">
      <h2>Run history</h2>
      <button class="btn ghost" data-act="clearHistory">Clear</button>
    </div>
    <div id="history" class="history-list"></div>
  </section>

<script nonce="${n}">${SCRIPT}</script>
</body>
</html>`;
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
.toolbar {
  position: sticky; top: 0; z-index: 5;
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 10px 16px;
  background: var(--vscode-editor-background);
  border-bottom: 1px solid var(--vscode-panel-border);
}
.title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.title h1 { font-size: 14px; font-weight: 600; margin: 0; }
.title .root {
  font-size: 12px; color: var(--vscode-descriptionForeground);
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  padding: 1px 8px; border-radius: 10px; white-space: nowrap;
}
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
.dot.brand { background: var(--manual); }
.actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
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
.btn.tiny { padding: 2px 8px; font-size: 11px; }
.toggle { font-size: 12px; color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 4px; cursor: pointer; }
.error {
  margin: 12px 16px; padding: 10px 12px; border-radius: 6px;
  background: rgba(221,43,14,.12); border: 1px solid var(--fail);
  color: var(--vscode-foreground); white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: 12px;
}
.focusbar {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  margin: 12px 16px 0; padding: 8px 12px; border-radius: 6px;
  background: rgba(31,117,203,.12); border: 1px solid var(--run);
  font-size: 12px;
}
.focusbar .focus-label { font-weight: 600; }
.focusbar .focus-counts { color: var(--vscode-descriptionForeground); }
.focusbar .spacer { flex: 1 1 auto; }
.board {
  display: flex; gap: 16px; padding: 16px; overflow-x: auto; align-items: flex-start;
  position: relative;
}
/* Dependency connectors: an absolute overlay sized to the board's scroll area,
 * drawn on top of the cards (stage backgrounds are opaque, so behind won't do).
 * pointer-events:none keeps hover/clicks flowing through to the cards. */
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
.history { border-top: 1px solid var(--vscode-panel-border); margin-top: 8px; }
.history-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px 6px; }
.history-head h2 { font-size: 13px; margin: 0; }
.history-list { padding: 0 16px 20px; display: flex; flex-direction: column; }
.hrow {
  display: grid; grid-template-columns: 18px 1fr auto auto auto; gap: 12px;
  align-items: center; padding: 7px 4px; border-bottom: 1px solid var(--vscode-panel-border);
  font-size: 12px;
}
.hrow:hover { background: var(--vscode-list-hoverBackground); }
.hrow .hlabel { font-weight: 500; }
.hrow .hkind { font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: 6px; text-transform: uppercase; }
.hrow .meta { color: var(--vscode-descriptionForeground); white-space: nowrap; }
.hactions { display: flex; gap: 6px; justify-content: flex-end; }
.empty { color: var(--vscode-descriptionForeground); padding: 16px 4px; font-style: italic; }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
const ICONS = { passed: "✔", failed: "✖", running: "●", canceled: "○" };
const ICON_CLASS = { passed: "icon-pass", failed: "icon-fail", running: "icon-run", canceled: "icon-skip" };

let liveTimers = false;

// Job-name -> card element, plus the lazily-created connector overlay.
const cardByName = new Map();
let depSvg = null;
const SVG_NS = "http://www.w3.org/2000/svg";

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
  if (depSvg) {
    // Keep <defs>, drop only the drawn paths.
    depSvg.querySelectorAll("path.dep-line").forEach((p) => p.remove());
  }
  document
    .querySelectorAll(".card.dep-source, .card.dep-target")
    .forEach((c) => c.classList.remove("dep-source", "dep-target"));
}

// Draw a connector from the hovered job to each job it needs. Coordinates are in
// the board's content space (rect minus board origin plus scroll offset) so the
// overlay tracks the cards even when the board is scrolled horizontally.
function showDeps(job) {
  const board = document.getElementById("board");
  const src = cardByName.get(job.name);
  if (!src) return;
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

    // Leave from the source edge facing the target; aim at the facing target edge.
    let sx, tx, dirS, dirT;
    if (t.cx < s.cx) { sx = s.left; dirS = -1; tx = t.right; dirT = 1; }
    else { sx = s.right; dirS = 1; tx = t.left; dirT = -1; }
    const dx = Math.max(30, Math.abs(tx - sx) * 0.5);
    const d = "M " + sx + " " + s.midY +
      " C " + (sx + dirS * dx) + " " + s.midY +
      ", " + (tx + dirT * dx) + " " + t.midY +
      ", " + tx + " " + t.midY;

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", "dep-line");
    path.setAttribute("d", d);
    path.setAttribute("marker-end", "url(#dep-arrow)");
    depSvg.appendChild(path);
  }
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
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
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

function renderBoard(stages) {
  const board = document.getElementById("board");
  board.innerHTML = "";
  // The overlay lives inside #board, so innerHTML="" drops it; rebuild the index.
  cardByName.clear();
  depSvg = null;
  if (!stages.length) {
    board.appendChild(el("div", "empty", "No jobs to show. Refresh, or adjust the filters above."));
    return;
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
    for (const job of stage.jobs) {
      body.appendChild(renderCard(job));
    }
    col.appendChild(body);
    board.appendChild(col);
  }
}

function renderCard(job) {
  const card = el("div", "card " + jobStatusClass(job));
  card.dataset.job = job.name;
  cardByName.set(job.name, card);
  // Hovering a job with needs traces connectors to the jobs it depends on.
  if (job.needs && job.needs.length) {
    card.addEventListener("mouseenter", () => showDeps(job));
    card.addEventListener("mouseleave", clearDeps);
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
  const isRunning = job.status === "running";
  const run = el("button", "btn primary tiny", isRunning ? "Running…" : "▶ Run");
  run.disabled = isRunning;
  run.addEventListener("click", () => vscode.postMessage({ type: "run", name: job.name }));
  actions.appendChild(run);

  const needs = el("button", "btn tiny", "+ needs");
  needs.title = "Run with needs";
  needs.addEventListener("click", () => vscode.postMessage({ type: "runNeeds", name: job.name }));
  actions.appendChild(needs);

  if (job.hasLocation) {
    const goto = el("button", "btn ghost tiny", "Definition");
    goto.addEventListener("click", () => vscode.postMessage({ type: "goto", name: job.name }));
    actions.appendChild(goto);
  }
  if (job.pipelineRunId) {
    const log = el("button", "btn ghost tiny", "Log");
    log.title = "Show this job's output from the pipeline run";
    log.addEventListener("click", () =>
      vscode.postMessage({ type: "showJobLog", runId: job.pipelineRunId, job: job.name }));
    actions.appendChild(log);
  } else if (job.lastRunId) {
    const log = el("button", "btn ghost tiny", "Log");
    log.title = "Show this job's last run output";
    log.addEventListener("click", () => vscode.postMessage({ type: "showLog", id: job.lastRunId }));
    actions.appendChild(log);
  }
  card.appendChild(actions);
  return card;
}

function renderHistory(history) {
  const list = document.getElementById("history");
  list.innerHTML = "";
  if (!history.length) {
    list.appendChild(el("div", "empty", "No runs yet. Click Run on a job to start one."));
    return;
  }
  for (const r of history) {
    const row = el("div", "hrow");
    const icon = el("span", "icon " + (ICON_CLASS[r.status] || ""), ICONS[r.status] || "○");
    if (r.status === "running") icon.classList.add("spin");
    row.appendChild(icon);

    const label = el("div");
    label.appendChild(el("span", "hlabel", r.label));
    const kindText = r.kind === "pipeline" ? "pipeline" : r.kind === "stage" ? "stage" : r.kind === "job-needs" ? "job + needs" : "job";
    label.appendChild(el("span", "hkind", kindText));
    row.appendChild(label);

    row.appendChild(el("span", "meta", fmtAgo(r.startTime)));
    const dur = r.endTime ? fmtDuration(r.endTime - r.startTime) : fmtDuration(Date.now() - r.startTime);
    const durSpan = el("span", "meta", dur);
    if (r.status === "running") durSpan.dataset.start = String(r.startTime);
    row.appendChild(durSpan);

    const actions = el("div", "hactions");
    if (r.kind === "pipeline") {
      const overview = el("button", "btn ghost tiny", "Overview");
      overview.title = "Show this pipeline run on the board";
      overview.addEventListener("click", () => vscode.postMessage({ type: "openPipelineRun", id: r.id }));
      actions.appendChild(overview);
    }
    const log = el("button", "btn ghost tiny", "Log");
    log.title = "Show this run's captured output";
    log.addEventListener("click", () => vscode.postMessage({ type: "showLog", id: r.id }));
    actions.appendChild(log);

    if (r.status === "running") {
      const cancel = el("button", "btn ghost tiny", "Cancel");
      cancel.addEventListener("click", () => vscode.postMessage({ type: "cancel", id: r.id }));
      actions.appendChild(cancel);
    } else {
      const rerun = el("button", "btn ghost tiny", "Re-run");
      rerun.addEventListener("click", () =>
        vscode.postMessage({ type: "rerun", target: r.target, kind: r.kind }));
      actions.appendChild(rerun);
    }
    row.appendChild(actions);
    list.appendChild(row);
  }
}

// The banner shown when the board is scoped to a single pipeline run. Live job
// counts are derived from the (already-overridden) card statuses in msg.stages.
function renderFocus(focus, stages) {
  const bar = document.getElementById("focusBar");
  bar.innerHTML = "";
  if (!focus) { bar.hidden = true; return; }
  bar.hidden = false;

  let running = 0, passed = 0, failed = 0, pending = 0;
  for (const s of stages) for (const j of s.jobs) {
    if (j.status === "running") running++;
    else if (j.status === "passed") passed++;
    else if (j.status === "failed") failed++;
    else pending++;
  }

  const verb = focus.status === "running" ? "started" : "ran";
  bar.appendChild(el("span", "focus-label", "Pipeline run · " + focus.status + " · " + verb + " " + fmtAgo(focus.startTime)));
  bar.appendChild(el("span", "focus-counts",
    running + " running · " + passed + " passed · " + failed + " failed · " + pending + " pending"));
  bar.appendChild(el("span", "spacer"));
  const exit = el("button", "btn ghost tiny", "✕ Exit overview");
  exit.addEventListener("click", () => vscode.postMessage({ type: "exitPipelineOverview" }));
  bar.appendChild(exit);
}

function bindToolbar() {
  document.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", () => vscode.postMessage({ type: b.dataset.act })));
  document.getElementById("hideNever").addEventListener("change", () =>
    vscode.postMessage({ type: "toggleNever" }));
  document.getElementById("hideSkipped").addEventListener("change", () =>
    vscode.postMessage({ type: "toggleSkipped" }));
}

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg.type !== "state") return;
  document.getElementById("root").textContent = msg.root || "";
  const err = document.getElementById("error");
  if (msg.error) { err.hidden = false; err.textContent = msg.error; }
  else { err.hidden = true; }
  document.getElementById("hideNever").checked = msg.filters.hideNever;
  document.getElementById("hideSkipped").checked = msg.filters.hideSkipped;
  document.getElementById("hideSkippedWrap").style.display = msg.filters.hasSkipConfig ? "" : "none";
  renderFocus(msg.focus, msg.stages);
  renderBoard(msg.stages);
  renderHistory(msg.history);
  liveTimers = msg.history.some((r) => r.status === "running");
});

// Tick running-duration counters once a second without a full re-render.
setInterval(() => {
  if (!liveTimers) return;
  document.querySelectorAll(".meta[data-start]").forEach((node) => {
    const start = Number(node.dataset.start);
    const s = Math.round((Date.now() - start) / 1000);
    node.textContent = s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
  });
}, 1000);

bindToolbar();
vscode.postMessage({ type: "ready" });
`;
