// testagent_change - new file
/**
 * 渲染进程内存守卫。
 *
 * webview 的 V8 堆顶到上限后会被 Chromium 直接 kill,JS 侧来不及拦截,
 * ErrorBoundary 也捕获不到(进程级终止)。这里只做被动防护,不请求重载:
 * 1. 越过软阈值时通知会话层裁剪不可见数据,把堆降下来;
 * 2. 把用量转发到扩展宿主日志,便于事后确认现场。
 *
 * 不做自动重载 —— 重载会丢失滚动位置、正在进行的流式输出和输入框草稿,
 * 代价高于收益,交给用户自行决定。
 *
 * performance.memory 在未开启 --enable-precise-memory-info 时精度有限,
 * 但用来判断趋势和量级足够。
 */
import { getVSCodeAPI } from "../context/vscode"

const SOFT = 1_200 * 1024 * 1024
const INTERVAL = 5_000

type MemoryInfo = { usedJSHeapSize: number; jsHeapSizeLimit?: number }

type PressureHandler = () => number

function memory(): MemoryInfo | undefined {
  return (performance as unknown as { memory?: MemoryInfo }).memory
}

let handler: PressureHandler | undefined
let timer: ReturnType<typeof setInterval> | undefined
let warned = false
let lastRelief = 0

/**
 * 注册软阈值回调。回调应释放可丢弃的数据并返回释放的字符数,
 * 返回值大于 0 表示这轮压力已缓解,允许下一轮再次触发。
 */
export function onMemoryPressure(fn: PressureHandler) {
  handler = fn
}

function report(source: string, message: string) {
  getVSCodeAPI().postMessage({ type: "webviewCrash", source, message })
}

function check() {
  const info = memory()
  if (!info) return
  const used = info.usedJSHeapSize
  if (used <= SOFT) return

  // 先尝试让会话层释放不可见数据,释放成功就继续跑。
  const freed = handler?.() ?? 0
  if (freed > 0) {
    lastRelief = Date.now()
    report(
      "memory",
      `JS heap ${(used / 1048576).toFixed(0)}MB, released ${(freed / 1048576).toFixed(1)}MB of cached output`,
    )
    return
  }

  // 没有可释放的内容了 —— 只记录一次,提醒用户手动处理。
  if (warned) return
  warned = true
  report("memory", `JS heap ${(used / 1048576).toFixed(0)}MB above soft limit with nothing left to release`)
}

export function startMemoryGuard() {
  if (timer !== undefined) return
  if (!memory()) return
  timer = setInterval(check, INTERVAL)
}

export function stopMemoryGuard() {
  if (timer === undefined) return
  clearInterval(timer)
  timer = undefined
}

/** 测试与诊断用。 */
export function lastReliefAt(): number {
  return lastRelief
}
