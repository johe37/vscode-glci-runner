import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import { Glci } from "./glci";
import { JobIndex } from "./jobIndex";
import { JobFilter } from "./filter";
import { JobCodeLensProvider } from "./codeLens";
import { JobTreeProvider } from "./treeView";

/** Expand a leading `~` and `$HOME`/`${HOME}` to the user's home directory. */
function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p.replace(/\$\{?HOME\}?/g, os.homedir());
}

/**
 * Resolve the project root that gitlab-ci-local runs against. Precedence:
 *  1. `glci.projectRoot` (absolute, `~`-prefixed, or relative to the workspace),
 *  2. the first workspace folder.
 */
function resolveRoot(folder: vscode.WorkspaceFolder): string {
  const configured = vscode.workspace
    .getConfiguration("glci")
    .get<string>("projectRoot")
    ?.trim();
  if (configured) {
    const expanded = expandHome(configured);
    return path.isAbsolute(expanded)
      ? expanded
      : path.join(folder.uri.fsPath, expanded);
  }
  return folder.uri.fsPath;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return; // No workspace — nothing to run against.
  }
  // Resolved lazily so changing `glci.projectRoot` takes effect on refresh.
  const getRoot = () => resolveRoot(folder);

  const glci = new Glci(getRoot);
  const filter = new JobFilter(context.workspaceState, getRoot);
  const index = new JobIndex(glci, getRoot);
  const output = vscode.window.createOutputChannel("GitLab CI Local");
  context.subscriptions.push(filter, index, output);

  await filter.reloadSkipConfig();

  // Tree view. Its description shows the active project root for quick debugging.
  const treeProvider = new JobTreeProvider(index, filter);
  const treeView = vscode.window.createTreeView("glci.jobs", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);
  const updateTreeRoot = () => {
    treeView.description = path.basename(getRoot());
  };
  updateTreeRoot();

  // CodeLens for CI YAML files. The provider returns nothing for non-CI YAML
  // (no keys match the job index), so a broad yaml selector is safe.
  const codeLensProvider = new JobCodeLensProvider(index, filter);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [{ language: "yaml" }, { pattern: "**/*.{yml,yaml}" }],
      codeLensProvider,
    ),
  );

  // Helper: resolve a job name from a command argument that may be a raw string
  // (CodeLens) or a tree node (context menu).
  const jobNameOf = (arg: unknown): string | undefined => {
    if (typeof arg === "string") {
      return arg;
    }
    if (arg && typeof arg === "object" && "job" in arg) {
      return (arg as { job: { name: string } }).job.name;
    }
    return undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("glci.runJob", (arg) => {
      const name = jobNameOf(arg);
      if (name) {
        glci.runJob(name);
      }
    }),
    vscode.commands.registerCommand("glci.runJobWithNeeds", (arg) => {
      const name = jobNameOf(arg);
      if (name) {
        glci.runJob(name, { withNeeds: true });
      }
    }),
    vscode.commands.registerCommand("glci.runStage", (arg) => {
      const stage =
        arg && typeof arg === "object" && "stage" in arg
          ? (arg as { stage: string }).stage
          : undefined;
      if (stage) {
        glci.runStage(stage);
      }
    }),
    vscode.commands.registerCommand("glci.preview", () =>
      glci.runToChannel(output, ["--preview"], "preview"),
    ),
    vscode.commands.registerCommand("glci.validate", () =>
      glci.runToChannel(output, ["--validate-dependency-chain"], "validate"),
    ),
    vscode.commands.registerCommand("glci.refresh", () => refresh()),
    vscode.commands.registerCommand("glci.setProjectRoot", async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(getRoot()),
        openLabel: "Use as GitLab CI project root",
        title: "Select GitLab CI project root",
      });
      if (!picked || picked.length === 0) {
        return;
      }
      await vscode.workspace
        .getConfiguration("glci")
        .update(
          "projectRoot",
          picked[0].fsPath,
          vscode.ConfigurationTarget.Workspace,
        );
      // onDidChangeConfiguration handles the re-registration + refresh.
    }),
    vscode.commands.registerCommand("glci.toggleHideNever", async () => {
      await filter.toggleHideNever();
      vscode.window.setStatusBarMessage(
        `GitLab CI: ${filter.isHidingNever ? "hiding" : "showing"} 'when: never' jobs`,
        3000,
      );
    }),
    vscode.commands.registerCommand("glci.toggleHideSkipped", async () => {
      if (!filter.hasSkipConfig) {
        vscode.window.showInformationMessage(
          "No [skip] list found in .glciconfig.toml.",
        );
        return;
      }
      await filter.toggleHideSkipped();
      vscode.window.setStatusBarMessage(
        `GitLab CI: ${filter.isHidingSkipped ? "hiding" : "showing"} skipped jobs`,
        3000,
      );
    }),
    vscode.commands.registerCommand("glci.goToDefinition", async (arg) => {
      const name = jobNameOf(arg);
      if (!name) {
        return;
      }
      const loc = index.getLocation(name);
      if (!loc) {
        vscode.window.showWarningMessage(
          `Could not find the definition for job "${name}".`,
        );
        return;
      }
      const doc = await vscode.workspace.openTextDocument(loc.uri);
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(loc.range.start, loc.range.start);
      editor.revealRange(loc.range, vscode.TextEditorRevealType.InCenter);
    }),
  );

  // Auto-refresh when any CI file changes. Watchers are based on the resolved
  // root and re-registered whenever the root or globs change.
  let watchers: vscode.FileSystemWatcher[] = [];
  function registerWatchers(): void {
    for (const w of watchers) {
      w.dispose();
    }
    watchers = [];
    const base = vscode.Uri.file(getRoot());
    const globs = vscode.workspace
      .getConfiguration("glci")
      .get<string[]>("ciFileGlobs") ?? [];
    for (const glob of globs) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(base, glob),
      );
      watcher.onDidChange(() => refresh());
      watcher.onDidCreate(() => refresh());
      watcher.onDidDelete(() => refresh());
      watchers.push(watcher);
      context.subscriptions.push(watcher);
    }
  }
  registerWatchers();

  // React to settings changes (project root, globs, etc.) without a reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("glci")) {
        return;
      }
      if (
        e.affectsConfiguration("glci.projectRoot") ||
        e.affectsConfiguration("glci.ciFileGlobs")
      ) {
        registerWatchers();
        updateTreeRoot();
      }
      void refresh();
    }),
  );

  async function refresh(): Promise<void> {
    output.appendLine(`Project root: ${getRoot()}`);
    await filter.reloadSkipConfig();
    await index.refresh();
    updateTreeRoot();
    if (index.error) {
      output.appendLine(`Failed to list jobs: ${index.error}`);
      vscode.window
        .showErrorMessage(
          `GitLab CI: could not list jobs. ${index.error}`,
          "Show Output",
        )
        .then((choice) => {
          if (choice === "Show Output") {
            output.show(true);
          }
        });
    } else {
      output.appendLine(`Listed ${index.getJobs().length} job(s).`);
    }
  }

  // Verify the binary up front; warn (don't block) if missing.
  glci.checkBinary().catch(() => {
    vscode.window
      .showWarningMessage(
        "gitlab-ci-local was not found. Set 'glci.binaryPath' or install it.",
        "Open Settings",
      )
      .then((choice) => {
        if (choice === "Open Settings") {
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "glci.binaryPath",
          );
        }
      });
  });

  await refresh();
}

export function deactivate(): void {
  // Subscriptions are disposed by VSCode via context.subscriptions.
}
