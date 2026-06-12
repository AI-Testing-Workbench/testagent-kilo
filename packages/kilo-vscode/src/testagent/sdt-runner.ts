// testagent_change - new file
import { spawn } from "../util/process"
import type { ChildProcess } from "child_process"
import * as readline from "readline"
import * as path from "path"
import * as os from "os"
import * as fs from "fs"
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

  /**
   * 调用 testflow prepare 命令，获取阶段执行的 prompt 数据。
   * 结果通过临时文件传递，避免 stdout 混杂其他输出。
   */
  async runPrepare(opts: {
    commandType: 'run' | 'next'
    stageId?: string
    args: string[]
    cwd: string
    env: Record<string, string | undefined>
  }): Promise<{
    prompt: string
    agent: string
    description: string
    stageId: string
    taskname: string
    skill: string
    executionTime: string
  }> {
    const extDir = path.resolve(__dirname, '..')
    const testflowBin = path.join(extDir, 'bin', process.platform === 'win32' ? 'testflow.exe' : 'testflow')
    const testflowResDir = path.join(extDir, 'bin', 'testflow-res')

    // 生成临时文件路径用于传递结果
    const tmpFile = path.join(os.tmpdir(), `testflow-prepare-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)

    // 构建 CLI 参数：prepare [stage_id] --command-type=run|next --output=<tmpFile> [其他参数]
    const cliArgs = ['prepare']
    if (opts.stageId) cliArgs.push(opts.stageId)
    cliArgs.push(`--command-type=${opts.commandType}`)
    cliArgs.push(`--output=${tmpFile}`)
    cliArgs.push(...opts.args)

    return new Promise((resolve, reject) => {
      const proc = spawn(testflowBin, cliArgs, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env, KILO_INTEGRATION: '1', _TESTFLOW_RESOURCES_DIR: testflowResDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stderr = ''

      proc.stdout!.on('data', () => { /* 忽略 stdout */ })
      proc.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      proc.on('close', (code) => {
        if (code !== 0) {
          console.error('[TestAgent] testflow prepare failed:', stderr)
          reject(new Error(`testflow prepare exited with code ${code}: ${stderr.trim()}`))
          return
        }

        // 从临时文件读取结果
        try {
          const content = fs.readFileSync(tmpFile, 'utf-8')
          const result = JSON.parse(content)
          const { type: _t, ...data } = result
          void _t
          resolve(data)
        } catch (e) {
          reject(new Error(`Failed to read prepare result from ${tmpFile}: ${(e as Error).message}`))
        } finally {
          // 清理临时文件
          try { fs.unlinkSync(tmpFile) } catch { /* 忽略 */ }
        }
      })

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn testflow prepare: ${err.message}`))
      })
    })
  }

  /**
   * 调用 testflow finalize 命令，执行阶段后置处理。
   */
  async runFinalize(opts: {
    stageId: string
    commandType: 'run' | 'next'
    success: boolean
    error?: string
    executionTime: string
    cwd: string
    env: Record<string, string | undefined>
  }): Promise<void> {
    const extDir = path.resolve(__dirname, '..')
    const testflowBin = path.join(extDir, 'bin', process.platform === 'win32' ? 'testflow.exe' : 'testflow')
    const testflowResDir = path.join(extDir, 'bin', 'testflow-res')

    const cliArgs = [
      'finalize',
      opts.stageId,
      `--command-type=${opts.commandType}`,
      opts.success ? '--success' : `--error=${opts.error || '未知错误'}`,
      `--execution-time=${opts.executionTime}`,
    ]

    return new Promise((resolve, reject) => {
      const proc = spawn(testflowBin, cliArgs, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env, KILO_INTEGRATION: '1', _TESTFLOW_RESOURCES_DIR: testflowResDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      proc.stdout!.on('data', () => { /* 忽略 stdout */ })

      proc.on('close', (code) => {
        if (code !== 0) {
          console.error('[TestAgent] testflow finalize failed:', stderr)
          reject(new Error(`testflow finalize exited with code ${code}: ${stderr.trim()}`))
          return
        }
        console.log('[TestAgent] testflow finalize completed for stage', opts.stageId)
        resolve()
      })

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn testflow finalize: ${err.message}`))
      })
    })
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
