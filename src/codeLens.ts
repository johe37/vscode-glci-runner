import * as vscode from "vscode";
import { parseDocument, LineCounter, isMap, isScalar } from "yaml";
import { JobIndex } from "./jobIndex";
import { JobFilter } from "./filter";
import { GlciJob } from "./glci";

/**
 * Emits inline play buttons above each runnable job definition in a CI YAML
 * file. Job identity and metadata come from {@link JobIndex}; the source line is
 * parsed from the document itself so lenses land on the right key.
 */
export class JobCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onChangeEmitter.event;

  constructor(
    private readonly index: JobIndex,
    private readonly filter: JobFilter,
  ) {
    index.onDidChange(() => this.onChangeEmitter.fire());
    filter.onDidChange(() => this.onChangeEmitter.fire());
  }

  provideCodeLenses(
    document: vscode.TextDocument,
  ): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const lineCounter = new LineCounter();
    let doc;
    try {
      doc = parseDocument(document.getText(), { lineCounter });
    } catch {
      return lenses;
    }
    if (!isMap(doc.contents)) {
      return lenses;
    }

    for (const item of doc.contents.items) {
      const keyNode = item.key;
      if (!isScalar(keyNode) || typeof keyNode.value !== "string") {
        continue;
      }
      const job = this.index.getJob(keyNode.value);
      if (!job || !this.filter.isVisible(job)) {
        continue;
      }
      const offset = keyNode.range?.[0];
      if (offset === undefined) {
        continue;
      }
      const { line } = lineCounter.linePos(offset);
      const range = new vscode.Range(line - 1, 0, line - 1, 0);

      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(play) Run",
          command: "glci.runJob",
          arguments: [job.name],
        }),
        new vscode.CodeLens(range, {
          title: "$(run-all) Run with needs",
          command: "glci.runJobWithNeeds",
          arguments: [job.name],
        }),
        new vscode.CodeLens(range, {
          title: describe(job),
          command: "",
        }),
      );
    }
    return lenses;
  }
}

function describe(job: GlciJob): string {
  const parts = [`stage: ${job.stage}`, `when: ${job.when}`];
  if (job.allow_failure) {
    parts.push("allow_failure");
  }
  return parts.join(" · ");
}
