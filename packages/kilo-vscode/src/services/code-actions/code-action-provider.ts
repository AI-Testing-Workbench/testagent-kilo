import * as vscode from "vscode"

export class KiloCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite],
  }

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (range.isEmpty) return []

    const actions: vscode.CodeAction[] = []

    const add = new vscode.CodeAction("Add to TestAgent", vscode.CodeActionKind.RefactorRewrite)
    add.command = { command: "testagent.new.addToContext", title: "Add to TestAgent" }
    actions.push(add)

    const hasDiagnostics = context.diagnostics.length > 0

    if (hasDiagnostics) {
      const fix = new vscode.CodeAction("Fix with TestAgent", vscode.CodeActionKind.QuickFix)
      fix.command = { command: "testagent.new.fixCode", title: "Fix with TestAgent" }
      fix.isPreferred = true
      actions.push(fix)
    }

    if (!hasDiagnostics) {
      const explain = new vscode.CodeAction("Explain with TestAgent", vscode.CodeActionKind.RefactorRewrite)
      explain.command = { command: "testagent.new.explainCode", title: "Explain with TestAgent" }
      actions.push(explain)

      const improve = new vscode.CodeAction("Improve with TestAgent", vscode.CodeActionKind.RefactorRewrite)
      improve.command = { command: "testagent.new.improveCode", title: "Improve with TestAgent" }
      actions.push(improve)
    }

    return actions
  }
}
