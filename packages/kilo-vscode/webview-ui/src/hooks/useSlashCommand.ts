import { createSignal, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import type { SlashCommandInfo, WebviewMessage, ExtensionMessage } from "../types/messages"
import { useServer } from "../context/server"
import { useSession } from "../context/session"
import { showToast } from "@kilocode/kilo-ui/toast"

export const SLASH_PATTERN = /^\/(\S*)$/

interface VSCodeContext {
  postMessage: (message: WebviewMessage) => void
  onMessage: (handler: (message: ExtensionMessage) => void) => () => void
}

export interface SlashCommandEntry extends SlashCommandInfo {
  action?: () => void
}

export interface SlashCommand {
  results: Accessor<SlashCommandEntry[]>
  index: Accessor<number>
  show: Accessor<boolean>
  commands: Accessor<SlashCommandEntry[]>
  onInput: (val: string, cursor: number) => void
  onKeyDown: (
    e: KeyboardEvent,
    textarea: HTMLTextAreaElement | undefined,
    setText: (text: string) => void,
    onSelect?: () => void,
  ) => boolean
  select: (
    cmd: SlashCommandEntry,
    textarea: HTMLTextAreaElement,
    setText: (text: string) => void,
    onSelect?: () => void,
  ) => void
  setIndex: (index: number) => void
  close: () => void
}

export function useSlashCommand(vscode: VSCodeContext, exclude?: Set<string>): SlashCommand {
  const [server, setServer] = createSignal<SlashCommandInfo[]>([])
  const [query, setQuery] = createSignal<string | null>(null)
  const [index, setIndex] = createSignal(0)
  const [requested, setRequested] = createSignal(false)

  const serverCtx = useServer()
  const sessionCtx = useSession()

  // testagent_change start - /log action triggers BeeEyes tracing extension
  const openBeeEyes = () => {
    const sid = sessionCtx.currentSessionID()
    const uid = serverCtx.userId() ?? ""
    if (!sid) {
      showToast({ variant: "error", title: "暂无会话", description: "请先发送一条消息" })
      return
    }
    vscode.postMessage({ type: "openBeeEyes", userId: uid, sessionId: sid })
  }
  // testagent_change end

  const all: SlashCommandEntry[] = [
    {
      name: "new",
      description: "开始新会话",
      hints: ["clear"],
      action: () => {
        window.dispatchEvent(new CustomEvent("newTaskRequest"))
        window.postMessage({ type: "navigate", view: "newTask" }, "*")
      },
    },
    {
      name: "sessions",
      description: "切换到其他会话",
      hints: ["resume", "continue", "history"],
      action: () => {
        window.postMessage({ type: "navigate", view: "history" }, "*")
      },
    },
    {
      name: "models",
      description: "切换 AI 模型",
      hints: [],
      action: () => {
        window.dispatchEvent(new CustomEvent("openModelPicker"))
      },
    },
    {
      name: "agents",
      description: "切换 Agent 模式",
      hints: ["modes"],
      action: () => {
        window.dispatchEvent(new CustomEvent("openModePicker"))
      },
    },
    {
      name: "help",
      description: "打开帮助文档",
      hints: [],
      action: () => {
        vscode.postMessage({ type: "openExternal", url: "https://tscode-gateway.paasuat.cmbchina.cn/help/testagent" })
      },
    },
    {
      name: "reloadSkills",
      description: "重新加载SKILLS",
      hints: [],
      action: () => {
        vscode.postMessage({ type: "reloadSkills" })
      },
    },
    {
      name: "reloadMCP",
      description: "重新加载MCP",
      hints: [],
      action: () => {
        vscode.postMessage({ type: "reloadMcp" })
      },
    },
    {
      name: "compact",
      description: "总结并压缩当前会话",
      hints: ["smol", "condense"],
      action: () => {
        window.dispatchEvent(new CustomEvent("compactSession"))
      },
    },
    {
      name: "settings",
      description: "打开设置",
      hints: [],
      action: () => {
        vscode.postMessage({ type: "openSettingsPanel" })
      },
    },
    // testagent_change 注释掉
    // {
    //   name: "remote",
    //   description: "切换远程控制",
    //   hints: [],
    //   action: () => {
    //     vscode.postMessage({ type: "toggleRemote" })
    //   },
    // },
    {
      name: "restart",
      description: "重启Server",
      hints: [],
      action: () => {
        vscode.postMessage({ type: "restartServer" })
      },
    },
    // testagent_change start
    {
      name: "log",
      description: "打开观测空间",
      hints: ["trace", "debug"],
      action: openBeeEyes,
    },
    {
      name: "sdt-new",
      description: "启动测试流程 - 创建新任务",
      hints: ["testflow", "new task"],
    },
    {
      name: "sdt-run",
      description: "执行指定任务的某个阶段",
      hints: ["testflow", "run", "stage"],
    },
    {
      name: "sdt-init",
      description: "初始化 TestFlow 框架全局环境",
      hints: ["testflow", "init", "setup"],
    },
    {
      name: "sdt-validate",
      description: "校验流程阶段配置文件的合法性",
      hints: ["testflow", "validate", "check", "config"],
    },
    {
      name: "sdt-switch",
      description: "切换工作空间内的默认工作任务",
      hints: ["testflow", "switch", "task"],
    },
    {
      name: "sdt-list",
      description: "查看当前的任务列表",
      hints: ["testflow", "list", "tasks"],
    },
    // testagent_change end
  ]

  const client = exclude ? all.filter((c) => !exclude.has(c.name)) : all

  const commands = (): SlashCommandEntry[] => {
    const names = new Set(client.map((c) => c.name))
    const filtered = server().filter((c) => !names.has(c.name))
    return [...client, ...filtered]
  }

  const show = () => query() !== null

  const request = () => {
    if (requested()) return
    setRequested(true)
    vscode.postMessage({ type: "requestCommands" })
  }

  const results = () => {
    const q = query()
    if (q === null) return []
    const all = commands()
    if (!q) return all
    const lower = q.toLowerCase()
    return all.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(lower) ||
        cmd.description?.toLowerCase().includes(lower) ||
        cmd.hints.some((h) => h.toLowerCase().includes(lower)),
    )
  }

  const unsubscribe = vscode.onMessage((message) => {
    if (message.type !== "commandsLoaded") return
    setServer(message.commands)
  })

  onCleanup(() => {
    unsubscribe()
  })

  const close = () => {
    setQuery(null)
  }

  const onInput = (val: string, cursor: number) => {
    const before = val.substring(0, cursor)
    const match = before.match(SLASH_PATTERN)
    if (match) {
      request()
      setQuery(match[1])
      setIndex(0)
    } else {
      close()
    }
  }

  const select = (
    cmd: SlashCommandEntry,
    textarea: HTMLTextAreaElement,
    setText: (text: string) => void,
    onSelect?: () => void,
  ) => {
    if (cmd.action) {
      textarea.value = ""
      setText("")
      close()
      onSelect?.()
      cmd.action()
      return
    }
    const text = `/${cmd.name} `
    textarea.value = text
    setText(text)
    const pos = text.length
    textarea.setSelectionRange(pos, pos)
    textarea.focus()
    close()
    onSelect?.()
  }

  const onKeyDown = (
    e: KeyboardEvent,
    textarea: HTMLTextAreaElement | undefined,
    setText: (text: string) => void,
    onSelect?: () => void,
  ): boolean => {
    if (!show()) return false
    if (e.isComposing) return false

    const filtered = results()

    if (e.key === "ArrowDown") {
      e.preventDefault()
      setIndex((i) => Math.min(i + 1, filtered.length - 1))
      return true
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setIndex((i) => Math.max(i - 1, 0))
      return true
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const cmd = filtered[index()]
      if (!cmd) return false
      e.preventDefault()
      if (textarea) select(cmd, textarea, setText, onSelect)
      return true
    }
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      close()
      return true
    }

    return false
  }

  return {
    results,
    index,
    show,
    commands,
    onInput,
    onKeyDown,
    select,
    setIndex,
    close,
  }
}
