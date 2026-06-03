import * as vscode from "vscode";

const KEY = "glci.runtimeVariables";

/**
 * User-entered CI variables set from the UI, persisted per workspace. They are
 * merged on top of the `glci.variables` setting (UI wins on conflict) and
 * applied to every glci run invocation so `rules:`
 * evaluate the same way a real pipeline would. Editing them is a deliberate,
 * Save-gated action, so changes fire {@link onDidChange} (which re-lists jobs)
 * only when committed, not on every keystroke.
 */
export class RuntimeVariables {
  private vars: Record<string, string>;
  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onChangeEmitter.event;

  constructor(private readonly state: vscode.Memento) {
    this.vars = state.get<Record<string, string>>(KEY, {});
  }

  /** A copy of the current variables. */
  all(): Record<string, string> {
    return { ...this.vars };
  }

  /** Replace the whole set; blank keys are dropped, keys trimmed. */
  set(vars: Record<string, string>): void {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) {
      const key = k.trim();
      if (key) {
        clean[key] = v;
      }
    }
    this.vars = clean;
    void this.persist();
  }

  clear(): void {
    this.vars = {};
    void this.persist();
  }

  private async persist(): Promise<void> {
    await this.state.update(KEY, this.vars);
    this.onChangeEmitter.fire();
  }

  dispose(): void {
    this.onChangeEmitter.dispose();
  }
}
