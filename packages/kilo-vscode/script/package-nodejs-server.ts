#!/usr/bin/env bun
/**
 * Package the kilo-vscode extension with Node.js backend.
 *
 * This script:
 * 1. Builds the nodejs-server dist from testagent-core
 * 2. Copies the dist into kilo-vscode/nodejs-server/ (keeping node_modules cache)
 * 3. Installs node_modules for the nodejs-server (skipped when cache is valid)
 * 4. Runs the extension build with BACKEND_RUNTIME=testagent-nodejs
 * 5. Packages the VSIX
 *
 * Usage:
 *   bun script/package-nodejs-server.ts [--skip-server-build] [--skip-vsix]
 *                                       [--target=<platform>] [--force-deps]
 *
 * Native binaries are cached in ~/.cache/testagent-vsix/tarballs and reused
 * across builds. Use --force-deps to wipe node_modules and re-install.
 */

import { $ } from "bun"
import { join } from "node:path"
import { homedir } from "node:os"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { promises as fs } from "node:fs"

const ROOT = join(import.meta.dir, "..")
const TESTAGENT_CORE = join(ROOT, "..", "testagent-core")
const SERVER_PKG = join(TESTAGENT_CORE, "packages", "nodejs-server")
const TARGET = join(ROOT, "nodejs-server")

const skipBuild = process.argv.includes("--skip-server-build")
const skipVsix = process.argv.includes("--skip-vsix")
const forceDeps = process.argv.includes("--force-deps")

// testagent_change - support target platform argument
const targetArg = process.argv.find((arg: string) => arg.startsWith("--target="))
const targetPlatform = targetArg ? targetArg.split("=")[1] : undefined

// Step 1: Build nodejs-server
if (!skipBuild) {
  console.log("Step 1: Building nodejs-server...")
  await $`cd ${SERVER_PKG} && OPENCODE_CHANNEL=latest bun run build`
} else {
  console.log("Step 1: Skipping server build (--skip-server-build)")
}

const serverDist = join(SERVER_PKG, "dist")
if (!existsSync(serverDist)) {
  console.error(`Error: nodejs-server dist not found at ${serverDist}`)
  console.error("Run without --skip-server-build to build it first")
  process.exit(1)
}

// Step 2: Copy dist to kilo-vscode/nodejs-server/, keeping node_modules as cache
console.log("Step 2: Copying nodejs-server dist...")
await fs.mkdir(TARGET, { recursive: true })
if (forceDeps) await fs.rm(join(TARGET, "node_modules"), { recursive: true, force: true })
for (const entry of await fs.readdir(TARGET)) {
  if (entry === "node_modules" && !forceDeps) continue
  await fs.rm(join(TARGET, entry), { recursive: true, force: true })
}
await fs.cp(serverDist, TARGET, { recursive: true })

// // Step 2.5: Copy Bun binary for runtime switching
// console.log("Step 2.5: Copying Bun binary for runtime switching...")
// const bunBinDir = join(ROOT, "bin")
// await fs.mkdir(bunBinDir, { recursive: true })

// const platform = process.platform
// const arch = process.arch
// const bunBinary = platform === "win32" ? "testagent.exe" : "testagent"

// // Determine the correct CLI dist directory based on platform
// let cliPlatformDir: string
// if (platform === "darwin") {
//   cliPlatformDir = arch === "arm64" ? "@kilocode/cli-darwin-arm64" : "@kilocode/cli-darwin-x64"
// } else if (platform === "linux") {
//   cliPlatformDir = arch === "arm64" ? "@kilocode/cli-linux-arm64" : "@kilocode/cli-linux-x64"
// } else if (platform === "win32") {
//   cliPlatformDir = arch === "arm64" ? "@kilocode/cli-windows-arm64" : "@kilocode/cli-windows-x64"
// } else {
//   console.warn(`  ⚠️ Unsupported platform: ${platform}, skipping Bun binary...`)
//   cliPlatformDir = ""
// }

// if (cliPlatformDir) {
//   const cliDistDir = process.env.CLI_DIST_DIR || join(TESTAGENT_CORE, "dist")
//   const bunSource = join(cliDistDir, cliPlatformDir, "bin", bunBinary)
//   const bunTarget = join(bunBinDir, bunBinary)

//   if (existsSync(bunSource)) {
//     await fs.copyFile(bunSource, bunTarget)
//     if (platform !== "win32") {
//       await fs.chmod(bunTarget, 0o755)
//     }
//     console.log(`  ✓ Copied ${bunBinary} to bin/ for runtime switching`)
//   } else {
//     console.warn(`  ⚠️ Bun binary not found at ${bunSource}, runtime switching will not work`)
//   }
// }

// Step 3: Install dependencies (for native node-pty bindings)
console.log("Step 3: Installing nodejs-server dependencies...")

// testagent_change start - incremental native binary cache with correct platform names
const NATIVE: Record<string, { pty: string; parcel: string; jieba: string }> = {
  "linux-x64": { pty: "linux-x64", parcel: "linux-x64-glibc", jieba: "linux-x64-gnu" },
  "linux-arm64": { pty: "linux-arm64", parcel: "linux-arm64-glibc", jieba: "linux-arm64-gnu" },
  "alpine-x64": { pty: "linux-x64", parcel: "linux-x64-musl", jieba: "linux-x64-musl" },
  "alpine-arm64": { pty: "linux-arm64", parcel: "linux-arm64-musl", jieba: "linux-arm64-musl" },
  "darwin-x64": { pty: "darwin-x64", parcel: "darwin-x64", jieba: "darwin-x64" },
  "darwin-arm64": { pty: "darwin-arm64", parcel: "darwin-arm64", jieba: "darwin-arm64" },
  "win32-x64": { pty: "win32-x64", parcel: "win32-x64", jieba: "win32-x64-msvc" },
  "win32-arm64": { pty: "win32-arm64", parcel: "win32-arm64", jieba: "win32-arm64-msvc" },
}

if (targetPlatform && !NATIVE[targetPlatform]) {
  console.error(`Error: unknown --target=${targetPlatform}`)
  console.error(`Supported targets: ${Object.keys(NATIVE).join(", ")}`)
  process.exit(1)
}

const scopes = {
  pty: "@lydell/node-pty",
  parcel: "@parcel/watcher",
  jieba: "@node-rs/jieba",
}

const serverPkg = JSON.parse(await fs.readFile(join(SERVER_PKG, "package.json"), "utf8"))
const depHash = createHash("sha256")
  .update(JSON.stringify(serverPkg.dependencies) + JSON.stringify(serverPkg.optionalDependencies))
  .digest("hex")
  .slice(0, 16)

const root = join(TARGET, "node_modules")
const stampPath = join(root, ".native-stamp.json")

async function resolve(scope: string) {
  const placed = join(root, scope, "package.json")
  if (existsSync(placed)) return String(JSON.parse(await fs.readFile(placed, "utf8")).version)
  return String(serverPkg.dependencies[scope]).replace(/^[\^~>= ]+/, "")
}

async function needed() {
  const keys = targetPlatform ? [targetPlatform] : Object.keys(NATIVE)
  const out: { name: string; version: string }[] = []
  const seen = new Set<string>()
  for (const kind of Object.keys(scopes) as (keyof typeof scopes)[]) {
    const version = await resolve(scopes[kind])
    for (const key of keys) {
      const name = `${scopes[kind]}-${NATIVE[key][kind]}`
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ name, version })
    }
  }
  return out
}

let stamp: { npm?: string; bins?: string } | undefined
if (existsSync(root) && existsSync(stampPath)) {
  stamp = JSON.parse(await fs.readFile(stampPath, "utf8"))
}

const stale = !existsSync(root) || !stamp || stamp.npm !== depHash
if (stale) {
  console.log("Step 3.1: Installing base dependencies...")
  await fs.rm(root, { recursive: true, force: true })
  await $`cd ${TARGET} && npm install --omit=dev --omit=optional`
} else {
  console.log("Step 3.1: ✅ node_modules cache valid (npm), checking native binaries...")
}

const pkgs = await needed()
const bins = pkgs.map((pkg) => `${pkg.name}@${pkg.version}`).sort().join("\n")
const cached = !stale && stamp?.bins === bins && pkgs.every((pkg) => existsSync(join(root, pkg.name)))

if (cached) {
  console.log("Step 3.2: ✅ Native binaries cached, skipping download")
} else {
  // Prune stale platform dirs from previous --target builds so they don't bloat the VSIX
  const keep = new Set(pkgs.map((pkg) => pkg.name))
  for (const scope of Object.values(scopes)) {
    const dir = join(root, scope.split("/")[0])
    if (!existsSync(dir)) continue
    for (const entry of await fs.readdir(dir)) {
      const name = `${scope.split("/")[0]}/${entry}`
      if (name === scope || keep.has(name)) continue
      await fs.rm(join(dir, entry), { recursive: true, force: true })
    }
  }

  const cacheDir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "testagent-vsix", "tarballs")

  async function untar(tgz: string, dir: string) {
    await fs.mkdir(dir, { recursive: true })
    try {
      await $`tar -xzf ${tgz} -C ${dir} --strip-components=1`
    } catch (err) {
      await fs.rm(tgz, { force: true })
      throw err
    }
  }

  async function pull(pkg: { name: string; version: string }) {
    try {
      const short = pkg.name.split("/")[1]
      const tgz = join(cacheDir, `${short}@${pkg.version}.tgz`)
      const dir = join(root, pkg.name)
      if (existsSync(tgz)) {
        try {
          await untar(tgz, dir)
          console.log(`  ✓ Installed ${pkg.name}@${pkg.version} (cached)`)
          return
        } catch {
          console.warn(`  ⚠️  Cached tarball for ${pkg.name} is corrupt, re-downloading`)
        }
      }
      const res = await fetch(`https://registry.npmjs.org/${pkg.name}/-/${short}-${pkg.version}.tgz`)
      if (!res.ok) throw new Error(`Failed to download ${pkg.name}: ${res.status}`)
      await fs.mkdir(cacheDir, { recursive: true })
      await fs.writeFile(`${tgz}.tmp`, Buffer.from(await res.arrayBuffer()))
      await fs.rename(`${tgz}.tmp`, tgz)
      await untar(tgz, dir)
      console.log(`  ✓ Installed ${pkg.name}@${pkg.version}`)
    } catch (err) {
      console.warn(`  ⚠️  Failed to install ${pkg.name}: ${err}`)
    }
  }

  console.log(`Step 3.2: Fetching platform binaries for ${targetPlatform || "all targets"} (${pkgs.length} packages, in parallel)...`)
  await Promise.all(pkgs.map(pull))

  if (pkgs.every((pkg) => existsSync(join(root, pkg.name)))) {
    await fs.writeFile(stampPath, JSON.stringify({ npm: depHash, bins }))
  }
}

// Verify critical platform packages were installed
console.log("Step 3.3: Verifying platform binaries...")
const missing = pkgs.filter((pkg) => !existsSync(join(root, pkg.name)))
for (const pkg of pkgs) {
  if (missing.includes(pkg)) {
    console.log(`  ✗ ${pkg.name} NOT FOUND`)
  } else {
    console.log(`  ✓ ${pkg.name}`)
  }
}

if (missing.length > 0 && targetPlatform) {
  console.error(`\n❌ Error: Missing platform binaries: ${missing.map((pkg) => pkg.name).join(", ")}`)
  console.error("   Extension will not work on these platforms!")
  process.exit(1)
}
if (missing.length > 0) {
  console.warn(`\n⚠️  Warning: Missing binaries: ${missing.map((pkg) => pkg.name).join(", ")}`)
  console.warn("   Extension may not work on these platforms!")
}
// testagent_change end

// Step 4: Build extension with testagent-nodejs backend
if (!skipVsix) {
  console.log("Step 4: Building extension with BACKEND_RUNTIME=testagent-nodejs...")
  await $`cd ${ROOT} && BACKEND_RUNTIME=testagent-nodejs node esbuild.js --production`

  // Step 5: Package VSIX
  console.log("Step 5: Packaging VSIX...")
  // testagent_change - support target platform for VSIX naming
  const vsixName = targetPlatform
    ? `testagent-nodejs-tscode-${targetPlatform}.vsix`
    : "testagent-nodejs-tscode.vsix"

  // Build vsce command with proper argument handling
  if (targetPlatform) {
    await $`cd ${ROOT} && npx @vscode/vsce package --no-dependencies --target ${targetPlatform} -o ${vsixName}`
  } else {
    await $`cd ${ROOT} && npx @vscode/vsce package --no-dependencies -o ${vsixName}`
  }
}

console.log("\n✅ Node.js Server VSIX build complete!")
console.log(`   Server dir: ${TARGET}`)
if (!skipVsix) {
  const vsixName = targetPlatform
    ? `testagent-nodejs-tscode-${targetPlatform}.vsix`
    : "testagent-nodejs-tscode.vsix"
  console.log(`   VSIX: ${join(ROOT, vsixName)}`)
}
