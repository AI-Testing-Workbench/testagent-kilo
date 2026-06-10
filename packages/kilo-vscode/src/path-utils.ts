import * as path from "path"

/**
 * Check whether a file path is absolute.
 *
 * Handles both Unix (`/foo/bar`) and Windows (`C:\foo`, `D:/bar`) conventions.
 * UNC paths (`\\server\share`) are also treated as absolute.
 *
 * Returns false for relative paths, bare filenames, empty strings, and
 * protocol-prefixed strings like `https://…`.
 */
export function isAbsolutePath(filePath: string): boolean {
  if (!filePath) return false
  // Unix absolute
  if (filePath.charCodeAt(0) === 47 /* / */) return true
  // Windows drive letter: C:\ or C:/
  if (
    filePath.length >= 3 &&
    filePath.charCodeAt(1) === 58 /* : */ &&
    (filePath.charCodeAt(2) === 92 /* \ */ || filePath.charCodeAt(2) === 47) /* / */ &&
    ((filePath.charCodeAt(0) >= 65 && filePath.charCodeAt(0) <= 90) /* A-Z */ ||
      (filePath.charCodeAt(0) >= 97 && filePath.charCodeAt(0) <= 122)) /* a-z */
  )
    return true
  // Windows UNC path: \\server\share
  if (filePath.length >= 2 && filePath.charCodeAt(0) === 92 /* \ */ && filePath.charCodeAt(1) === 92 /* \ */)
    return true
  return false
}

function pathStyle(filePath: string) {
  if (/^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\")) return path.win32
  return path.posix
}

export function isManagedSkillLocation(location: string): boolean {
  if (!location) return false

  const style = pathStyle(location)
  const file = style.resolve(location)
  const root = style.parse(file).root
  const dir = style.dirname(file)
  if (style.basename(file) !== "SKILL.md" || dir === root) return false

  const parts = dir.split(/[\\/]+/).filter(Boolean)
  return parts.some((part, i) => {
    const key = part.toLowerCase()
    const next = parts[i + 1]?.toLowerCase()
    if ((key === ".opencode" || key === ".testagent") && (next === "skill" || next === "skills")) return true
    if ((key === ".claude" || key === ".agents") && next === "skills") return true
    if (
      (key === "opencode" || key === "testagent") &&
      (next === "skill" || next === "skills") &&
      parts.some((item) => item.toLowerCase() === ".config")
    )
      return true
    return false
  })
}

export function isManagedPluginLocation(location: string): boolean {
  if (!location) return false

  const style = pathStyle(location)
  const file = style.resolve(location)
  const ext = style.extname(file).toLowerCase()
  if (ext !== ".ts" && ext !== ".js") return false

  const dir = style.dirname(file)
  const key = style.basename(style.dirname(dir)).toLowerCase()
  const parent = style.basename(dir).toLowerCase()
  if ((key === ".opencode" || key === ".testagent") && (parent === "plugin" || parent === "plugins")) return true

  const parts = file.split(/[\\/]+/).filter(Boolean)
  if ((key === "opencode" || key === "testagent") && (parent === "plugin" || parent === "plugins")) {
    return parts.some((item) => item.toLowerCase() === ".config")
  }
  return false
}
