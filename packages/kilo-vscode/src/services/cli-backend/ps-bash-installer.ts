import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type * as vscode from "vscode"
import { exec } from "../../util/process"

/**
 * On-demand ps-bash installer.
 *
 * ps-bash (https://github.com/standardbeagle/ps-bash) is a POSIX-compatible shell for
 * Windows. Windows PowerShell 5.1 strips embedded double quotes when handing arguments
 * to native executables, which corrupts inline JSON bodies; ps-bash runs commands
 * through the PowerShell SDK instead of rebuilding a command line, so the quotes
 * survive.
 *
 * Unlike ripgrep, ps-bash is never downloaded automatically: the settings UI shows a
 * download button and only fetches the zip when the user clicks it. The archive is
 * mirrored on the intranet (GitHub release path layout) and extracted into ps-bash's
 * own user-state directory (~/.psbash/ps-bash), where host.log already lives, so the
 * install and its runtime state share one profile-independent location. The user then
 * picks the path from the available terminals list; the CLI never defaults to ps-bash.
 */
const VERSION = "0.14.0"
const ZIP = `ps-bash-v${VERSION}-win-x64.zip`
const EXE = "ps-bash.exe"
const URL = `${decodeURIComponent(atob("aHR0cHMlM0ElMkYlMkZ0ZXN0YWdlbnQtcHMtYmFzaC1kb3dubG9hZC5wYWFzdWF0LmNtYmNoaW5hLmNu"))}/standardbeagle/ps-bash/releases/download/v${VERSION}/${ZIP}`

// ps-bash 官方用户态目录：host.log、ai-providers.json、history 都写在这里。
// 安装包放其下 ps-bash/ 子目录避免与状态文件混放；路径不绑定 VS Code profile，
// 扩展升级或切换发行版（tscode/insiders）后配置里的绝对路径依然有效。
const DIR = path.join(os.homedir(), ".psbash")
const ROOT = path.join(DIR, "ps-bash")

let inflight: Promise<string> | undefined

// 与 KiloProvider.getAvailableTerminals 同一份探测列表：扩展宿主的 PATH 可能不含
// WindowsPowerShell 目录（裸 powershell.exe 会 ENOENT），仅装 PS7 的机器回退 pwsh。
const hosts = [
  "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
  "C:/Windows/System32/powershell.exe",
  "C:/Program Files/PowerShell/7/pwsh.exe",
  "C:/Program Files (x86)/PowerShell/7/pwsh.exe",
]

/** PowerShell executable to run download/extract commands, resolved by absolute path. */
function host(): string {
  const found = hosts.find((p) => fs.existsSync(p))
  if (found) return found
  throw new Error("未找到可用的 PowerShell（powershell.exe 或 pwsh.exe）")
}

// 盘符统一转大写，与终端列表里硬编码的系统终端路径（C:/...）保持一致，
// 避免脏检查因大小写差异重复写配置。
function upper(file: string) {
  return file.replace(/^([a-z])/, (m) => m.toUpperCase())
}

/** Installed ps-bash executable under the ps-bash user-state directory. */
export function psBashPath(): string {
  return upper(path.join(ROOT, EXE))
}

export function isInstalled(): boolean {
  return process.platform === "win32" && fs.existsSync(psBashPath())
}

/** Download and install ps-bash on demand. Only triggered by an explicit user click. */
export async function downloadPsBash(context: vscode.ExtensionContext): Promise<string> {
  if (process.platform !== "win32") throw new Error("ps-bash 仅支持 Windows")
  if (inflight) return inflight
  inflight = install(context)
  try {
    return await inflight
  } finally {
    // 下载失败后允许再次点击重试。
    inflight = undefined
  }
}

async function install(context: vscode.ExtensionContext): Promise<string> {
  const exe = psBashPath()
  if (fs.existsSync(exe)) return exe

  // 旧版装在扩展 globalStorage 下，存在则整体迁移，用户无需重新下载。
  const legacy = path.join(context.globalStorageUri.fsPath, "ps-bash")
  if (fs.existsSync(path.join(legacy, EXE))) {
    fs.rmSync(ROOT, { recursive: true, force: true })
    place(legacy, ROOT)
    return exe
  }

  const tmp = path.join(DIR, `.ps-bash-${process.pid}-${Date.now()}`)
  try {
    fs.mkdirSync(tmp, { recursive: true })
    await fetchZip(path.join(tmp, ZIP))
    await extract(path.join(tmp, ZIP), tmp)
    if (!fs.existsSync(path.join(tmp, EXE))) throw new Error(`压缩包中未找到 ${EXE}`)
    fs.rmSync(ROOT, { recursive: true, force: true })
    place(tmp, ROOT)
    return exe
  } catch (err) {
    throw new Error(`ps-bash 安装失败：${err instanceof Error ? err.message : String(err)}`, { cause: err })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export async function fetchZip(zip: string, url = URL): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) }).catch(async (err: unknown) => {
    // 使用 Windows 系统证书和代理重试，避免扩展宿主的网络栈差异影响内网下载。
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12",
      `Invoke-WebRequest -UseBasicParsing -Uri '${escape(url)}' -OutFile '${escape(zip)}' -TimeoutSec 120`,
    ].join("; ")
    try {
      await exec(host(), ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 130_000 })
      if (fs.statSync(zip).size === 0) throw new Error("下载内容为空")
    } catch (fallback) {
      throw new Error(
        `下载地址：${url}；网络请求失败：${detail(err)}；Windows 系统下载失败：${detail(fallback)}。请检查内网/VPN、代理和证书配置。`,
        { cause: fallback },
      )
    }
  })
  if (!res) return
  if (!res.ok) throw new Error(`下载返回 HTTP ${res.status} ${res.statusText}；下载地址：${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength === 0) throw new Error(`下载内容为空；下载地址：${url}`)
  fs.writeFileSync(zip, buf)
}

function detail(err: unknown, depth = 0): string {
  if (!(err instanceof Error)) return String(err)
  const code = "code" in err ? ` [${String(err.code)}]` : ""
  const nested =
    depth < 5
      ? err instanceof AggregateError
        ? err.errors.map((item: unknown) => detail(item, depth + 1)).join("；")
        : err.cause
          ? detail(err.cause, depth + 1)
          : ""
      : ""
  return `${err.message}${code}${nested ? `；${nested}` : ""}`
}

async function extract(zip: string, dest: string) {
  const command = `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath '${escape(zip)}' -DestinationPath '${escape(dest)}' -Force`
  await exec(host(), ["-NoProfile", "-NonInteractive", "-Command", command])
}

function place(source: string, target: string) {
  try {
    fs.renameSync(source, target)
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err
  }
  fs.mkdirSync(target, { recursive: true })
  fs.cpSync(source, target, { recursive: true })
  fs.rmSync(source, { recursive: true, force: true })
}

function escape(value: string) {
  return value.replaceAll("'", "''")
}
