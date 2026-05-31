// testagent_change - new file
import { spawn } from "../util/process"
import type { ChildProcess } from "child_process"
import * as readline from "readline"
import * as path from "path"
import { TestflowMessageBridge } from "./testflow-bridge"

// Strip ANSI escape codes (colors, cursor moves, etc.) from terminal output
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g
const stripAnsi = (s: string) => s.replace(ANSI_RE, "")

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
      // Notify via bridge so the error appears inline in the chat
      opts.post({ type: "testflow.error", sessionID: opts.sessionID, error: "Another testflow process is already running" })
      return
    }

    console.log('[TestAgent] Starting testflow process...')
    this.running = true
    this.bridge.start({ sessionID: opts.sessionID, userText: opts.userText, userMessageID: opts.userMessageID, post: opts.post })

    // Use bundled testflow binary from extension's bin/ directory
    const extDir = path.resolve(__dirname, '..')
    const testflowBin = path.join(extDir, 'bin', process.platform === 'win32' ? 'testflow.exe' : 'testflow')
    console.log('[TestAgent] Using bundled testflow binary:', testflowBin)
    console.log('[TestAgent] Spawning testflow:', { cmd: testflowBin, args: [opts.cmd, ...opts.args], cwd: opts.cwd })

    const testflowResDir = path.join(extDir, 'bin', 'testflow-res')
    this.proc = spawn(testflowBin, [opts.cmd, ...opts.args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, KILO_INTEGRATION: "1", _TESTFLOW_RESOURCES_DIR: testflowResDir },
      stdio: ["pipe", "pipe", "pipe"],
    })

    const rl = readline.createInterface({ input: this.proc.stdout!, terminal: false })
    rl.on("line", (line) => {
      console.log('[TestAgent] testflow stdout:', line)
      if (!line.trim()) return
      try {
        const event = JSON.parse(line) as JsonLine
        console.log('[TestAgent] testflow event:', event.type)
        this.dispatch(event)
      } catch {
        console.log('[TestAgent] testflow non-JSON output:', line)
        this.bridge.onText(stripAnsi(line))
      }
    })

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString().trim())
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

  reply(id: string, answers: string[]): void {
    if (!this.proc?.stdin?.writable) return
    this.proc.stdin.write(JSON.stringify({ type: "question_reply", id, answers }) + "\n")
    this.bridge.onQuestionAnswered(id)
  }

  reject(id: string): void {
    if (!this.proc?.stdin?.writable) return
    this.proc.stdin.write(JSON.stringify({ type: "question_reject", id }) + "\n")
    this.bridge.onQuestionAnswered(id)
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

  isRunning(): boolean {
    return this.running
  }

  private dispatch(event: JsonLine): void {
    const type = event.type as string
    switch (type) {
      case "step":
        this.bridge.onStep(
          event.title as string,
          event.status as "start" | "complete" | "exception",
          event.stage_id as string | undefined,
        )
        break
      case "question":
        this.bridge.onQuestion(
          event.id as string,
          event.header as string,
          event.question as string,
          event.options as { label: string; description: string }[],
          event.multiple as boolean | undefined,
        )
        break
      case "agent_start":
        this.bridge.onAgentStart(event.skill as string | undefined, event.prompt as string | undefined)
        break
      case "agent_done":
        this.bridge.onAgentDone()
        break
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
        this.bridge.onLog(event.level as string, event.message as string)
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
