import * as vscode from "vscode"
import type { KiloProvider } from "../../KiloProvider"
import type { AgentManagerProvider } from "../../agent-manager/AgentManagerProvider"
import { getEditorContext } from "./editor-utils"
import { createPrompt } from "./support-prompt"

export function registerCodeActions(
  context: vscode.ExtensionContext,
  provider: KiloProvider,
  agentManager?: AgentManagerProvider,
): void {
  const target = () => (agentManager?.isActive() ? agentManager : provider)

  context.subscriptions.push(
    vscode.commands.registerCommand("testagent.new.explainCode", () => {
      const ctx = getEditorContext()
      if (!ctx) return
      const prompt = createPrompt("EXPLAIN", {
        filePath: ctx.filePath,
        startLine: String(ctx.startLine),
        endLine: String(ctx.endLine),
        selectedText: ctx.selectedText,
        userInput: "",
      })
      provider.postMessage({ type: "triggerTask", text: prompt })
    }),

    vscode.commands.registerCommand("testagent.new.fixCode", () => {
      const ctx = getEditorContext()
      if (!ctx) return
      const prompt = createPrompt("FIX", {
        filePath: ctx.filePath,
        startLine: String(ctx.startLine),
        endLine: String(ctx.endLine),
        selectedText: ctx.selectedText,
        diagnostics: ctx.diagnostics,
        userInput: "",
      })
      provider.postMessage({ type: "triggerTask", text: prompt })
    }),

    vscode.commands.registerCommand("testagent.new.improveCode", () => {
      const ctx = getEditorContext()
      if (!ctx) return
      const prompt = createPrompt("IMPROVE", {
        filePath: ctx.filePath,
        startLine: String(ctx.startLine),
        endLine: String(ctx.endLine),
        selectedText: ctx.selectedText,
        userInput: "",
      })
      provider.postMessage({ type: "triggerTask", text: prompt })
    }),

    vscode.commands.registerCommand("testagent.new.addToContext", () => {
      const ctx = getEditorContext()
      if (!ctx) return
      target().postMessage({
        type: "appendCodeContext",
        context: {
          id: `${ctx.filePath}:${ctx.startLine}-${ctx.endLine}:${Date.now()}`,
          file: ctx.filePath,
          start: ctx.startLine,
          end: ctx.endLine,
          text: ctx.selectedText,
        },
      })
    }),

    vscode.commands.registerCommand("testagent.new.focusChatInput", () => {
      target().postMessage({ type: "action", action: "focusInput" })
    }),

    vscode.commands.registerCommand("testagent.new.customAddToContext", async () => {
      const userInput = await vscode.window.showInputBox({
        prompt: "输入要添加到 TestAgent 的内容",
        placeHolder: "输入你想讨论的内容...",
      })

      if (!userInput) return

      target().postMessage({
        type: "appendChatBoxMessage",
        text: userInput,
      })
    }),
  )
}
