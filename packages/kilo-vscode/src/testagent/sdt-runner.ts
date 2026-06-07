// testagent_change - new file
import { spawn } from "../util/process"
import type { ChildProcess } from "child_process"
import * as readline from "readline"
import * as path from "path"
import { TestflowMessageBridge } from "./testflow-bridge"

// Strip ANSI escape codes (colors, cursor moves, etc.) from terminal output
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g
const stripAnsi = (s: string) => s.replace(ANSI_RE, "")

/**
 * 一锤子命令的子命令名集合。这些命令不跑 AI、不发 progress 事件，
 * 而是发 `result` 事件（一个），由 bridge 渲染成结果卡。对应的
 * stdout/stderr 实时日志会被丢弃，避免和卡片内容重复。
 */
const ONE_SHOT_COMMANDS = new Set(["init", "new", "list", "switch", "validate"])

export interface SdtRunnerOpts {
  cmd: string
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
  sessionID: string
  userText: string
  /** Reuse the webview's optimistic message ID to avoid creating a duplicate user message turn. */
  userMessageID?: string
  post: (msg: unknown) => void
}

type JsonLine = Record<string, unknown>

export class SdtRunner {
  private proc: ChildProcess | null = null
  private bridge = new TestflowMessageBridge()
  private running = false

  run(opts: SdtRunnerOpts): void {
    console.log('[TestAgent] SdtRunner.run called:', { cmd: opts.cmd, args: opts.args, cwd: opts.cwd, sessionID: opts.sessionID })
    
    if (this.running) {
      console.log('[TestAgent] SdtRunner already running, aborting')
      return
    }

    console.log('[TestAgent] Starting testflow process...')
    this.running = true
    this.bridge.start({ sessionID: opts.sessionID, userText: opts.userText, userMessageID: opts.userMessageID, post: opts.post })

    // Use bundled testflow binary from extension's bin/ directory
    const extDir = path.resolve(__dirname, '..')
    const testflowBin = path.join(extDir, 'bin', process.platform === 'win32' ? 'testflow.exe' : 'testflow')
    // console.log('[TestAgent] Using bundled testflow binary:', testflowBin)
    // console.log('[TestAgent] Spawning testflow:', { cmd: testflowBin, args: [opts.cmd, ...opts.args], cwd: opts.cwd })

    const testflowResDir = path.join(extDir, 'bin', 'testflow-res')
    this.proc = spawn(testflowBin, [opts.cmd, ...opts.args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, KILO_INTEGRATION: "1", _TESTFLOW_RESOURCES_DIR: testflowResDir },
      stdio: ["pipe", "pipe", "pipe"],
    })

    const isOneShot = ONE_SHOT_COMMANDS.has(opts.cmd)
    const rl = readline.createInterface({ input: this.proc.stdout!, terminal: false })
    rl.on("line", (line) => {
      // console.log('[TestAgent] testflow stdout:', line)
      if (!line.trim()) return
      try {
        const event = JSON.parse(line) as JsonLine
        // console.log('[TestAgent] testflow event:', event.type)
        this.dispatch(event)
      } catch {
        // 一锤子命令的实时日志丢进卡片反而是噪声，忽略；其他命令照旧回流到 chat
        if (!isOneShot) {
          console.log('[TestAgent] testflow non-JSON output:', line)
          this.bridge.onText(stripAnsi(line))
        }
      }
    })

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString().trim())
      if (isOneShot) {
        // 一锤子命令的 stderr 由 cli-entry.ts 的错误路径转成 result 事件，
        // 这里只打 console.log 留痕，不进 chat
        if (text) console.log('[TestAgent] testflow stderr (one-shot):', text)
        return
      }
      console.log('[TestAgent] testflow stderr:', text)
      if (text) this.bridge.onLog("error", text)
    })

    this.proc.on("close", (code) => {
      console.log('[TestAgent] testflow process closed:', code)
      this.bridge.onDone(code ?? 0)
      this.cleanup()
    })

    this.proc.on("error", (err) => {
      console.log('[TestAgent] testflow process error:', err.message)
      this.bridge.onError(err.message)
      this.bridge.onDone(1)
      this.cleanup()
    })
  }

  abort(): void {
    if (!this.proc) return
    try {
      this.proc.kill("SIGTERM")
    } catch {
      // process may have already exited
    }
    this.bridge.onDone(1, "Aborted by user")
    this.cleanup()
  }

  private dispatch(event: JsonLine): void {
    const type = event.type as string
    switch (type) {
      case "result": {
        // 一锤子命令的最终结果：抽出 kind 之外的字段作为 payload
        const { type: _t, ...payload } = event
        void _t
        this.bridge.onResult(payload)
        break
      }
      case "progress":
        this.bridge.onProgress(
          event.task_name as string,
          event.stages as any[],
          event.completed_count as number,
          event.total_count as number,
          event.percent as number,
          event.next_hint as string,
          event.exception_hint as string | null,
        )
        break
      case "text":
        this.bridge.onText(event.text as string)
        break
      case "log":
        if (event.level === 'info') {
          console.info('[TestAgent] testflow info:', event.msg as string)
        } else if (event.level === 'warn') {
          console.warn('[TestAgent] testflow warn:', event.msg as string)
        } else if (event.level === 'error') {
          console.error('[TestAgent] testflow error:', event.msg as string)
        }
        // this.bridge.onLog(event.level as string, event.message as string)
        break
      case "error":
        this.bridge.onError(event.error as string)
        break
      case "done":
        // handled by proc.on("close")
        break
      case "response_part":
        this.bridge.onResponsePart(
          event.sessionID as string,
          event.messageID as string,
          event.sequence as number,
          event.part as any,
        )
        break
      case "new_assistant":
        this.bridge.onNewAssistant()
        break
      default:
        this.bridge.onText(JSON.stringify(event))
    }
  }

  private cleanup(): void {
    this.running = false
    this.proc = null
  }
}
