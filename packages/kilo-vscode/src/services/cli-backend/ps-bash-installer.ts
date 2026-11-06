import * as fs from "fs"
import * as path from "path"
import type * as vscode from "vscode"
import { exec } from "../../util/process"

/**
 * Bundled ps-bash release.
 *
 * The bash tool spawns this shell on Windows so POSIX syntax (`ls -la`, `grep -r`,
 * `curl -d '{...}'`) runs as written. Windows PowerShell 5.1 strips embedded
 * double quotes when handing arguments to native executables, which corrupts
 * inline JSON bodies; ps-bash runs commands through the PowerShell SDK instead
 * of rebuilding a command line, so the quotes survive.
 */
const VERSION = "0.14.0"
const ZIP = `ps-bash-v${VERSION}-win-x64.zip`
const EXE = "ps-bash.exe"

let inflight: Promise<string | undefined> | undefined

/** Resolve the installed ps-bash executable, extracting the bundled archive on first use. */
export async function ensurePsBash(context: vscode.ExtensionContext): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined
  if (!inflight) inflight = install(context)
  return inflight
}

async function install(context: vscode.ExtensionContext): Promise<string | undefined> {
  const zip = path.join(context.extensionPath, "bin", "ps-bash", ZIP)
  if (!fs.existsSync(zip)) {
    console.warn(`[TestAgent] ps-bash bundle missing at ${zip}; bash tool falls back to PowerShell`)
    return undefined
  }

  const root = path.join(context.globalStorageUri.fsPath, "ps-bash")
  const target = path.join(root, VERSION)
  const exe = path.join(target, EXE)
  if (fs.existsSync(exe)) return exe

  const tmp = path.join(root, `.tmp-${process.pid}-${Date.now()}`)
  try {
    fs.mkdirSync(tmp, { recursive: true })
    await extract(zip, tmp)
    if (!fs.existsSync(path.join(tmp, EXE))) throw new Error(`${EXE} not found in archive`)
    fs.rmSync(target, { recursive: true, force: true })
    place(tmp, target)
    console.log(`[TestAgent] ps-bash installed at ${exe}`)
    return exe
  } catch (err) {
    console.error("[TestAgent] ps-bash install failed:", err)
    fs.rmSync(tmp, { recursive: true, force: true })
    return undefined
  }
}

async function extract(zip: string, dest: string) {
  const command = `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath '${escape(zip)}' -DestinationPath '${escape(dest)}' -Force`
  await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command])
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
