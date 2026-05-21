#!/usr/bin/env bun
/**
 * Package the kilo-vscode extension with Node.js backend.
 *
 * This script:
 * 1. Builds the nodejs-server dist from testagent-core
 * 2. Copies the dist into kilo-vscode/nodejs-server/
 * 3. Installs node_modules for the nodejs-server (node-pty native bindings)
 * 4. Runs the extension build with BACKEND_RUNTIME=testagent-nodejs
 * 5. Packages the VSIX
 *
 * Usage:
 *   bun script/package-nodejs-server.ts [--skip-server-build] [--skip-vsix]
 */

import { $ } from "bun"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { promises as fs } from "node:fs"

const ROOT = join(import.meta.dir, "..")
const TESTAGENT_CORE = join(ROOT, "..", "testagent-core")
const SERVER_PKG = join(TESTAGENT_CORE, "packages", "nodejs-server")
const TARGET = join(ROOT, "nodejs-server")

const skipBuild = process.argv.includes("--skip-server-build")
const skipVsix = process.argv.includes("--skip-vsix")

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

// Step 2: Copy dist to kilo-vscode/nodejs-server/
console.log("Step 2: Copying nodejs-server dist...")
await fs.rm(TARGET, { recursive: true, force: true })
await fs.mkdir(TARGET, { recursive: true })
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

// testagent_change start - only install win32-x64 platform binaries
console.log("Step 3.1: Installing base dependencies...")
await $`cd ${TARGET} && npm install --omit=dev --omit=optional`

console.log("Step 3.2: Manually downloading win32-x64 platform binaries...")
// Download and extract win32-x64 packages directly from npm registry
const packages = [
  { name: "@lydell/node-pty-win32-x64", version: "1.2.0-beta.10" },
  { name: "@parcel/watcher-win32-x64", version: "2.5.0" },
]

for (const pkg of packages) {
  const tarballUrl = `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split("/")[1]}-${pkg.version}.tgz`
  const targetDir = join(TARGET, "node_modules", pkg.name)
  
  console.log(`  Downloading ${pkg.name}@${pkg.version}...`)
  
  // Download tarball
  const response = await fetch(tarballUrl)
  if (!response.ok) {
    throw new Error(`Failed to download ${pkg.name}: ${response.status}`)
  }
  
  const tarballPath = join(TARGET, `${pkg.name.replace("/", "-")}.tgz`)
  await fs.writeFile(tarballPath, Buffer.from(await response.arrayBuffer()))
  
  // Extract tarball
  await fs.mkdir(targetDir, { recursive: true })
  await $`cd ${targetDir} && tar -xzf ${tarballPath} --strip-components=1`
  await fs.unlink(tarballPath)
  
  console.log(`  ✓ Installed ${pkg.name}`)
}

// Verify critical platform packages were installed
console.log("Step 3.3: Verifying platform binaries...")
const requiredPlatforms = ["win32-x64"]
const missing = []
for (const platform of requiredPlatforms) {
  const pkgPath = join(TARGET, "node_modules", `@lydell/node-pty-${platform}`)
  if (!existsSync(pkgPath)) {
    missing.push(platform)
    console.log(`  ✗ node-pty-${platform} NOT FOUND`)
  } else {
    console.log(`  ✓ node-pty-${platform}`)
  }
}

if (missing.length > 0) {
  console.error(`\n❌ Error: Missing node-pty binaries for: ${missing.join(", ")}`)
  console.error("   Extension will not work on these platforms!")
  process.exit(1)
}
// testagent_change end

// Step 4: Build extension with testagent-nodejs backend
if (!skipVsix) {
  console.log("Step 4: Building extension with BACKEND_RUNTIME=testagent-nodejs...")
  await $`cd ${ROOT} && BACKEND_RUNTIME=testagent-nodejs node esbuild.js --production`

  // Step 5: Package VSIX
  console.log("Step 5: Packaging VSIX...")
  await $`cd ${ROOT} && npx @vscode/vsce package --no-dependencies -o testagent-nodejs-tscode.vsix`
}

console.log("\n✅ Node.js Server VSIX build complete!")
console.log(`   Server dir: ${TARGET}`)
if (!skipVsix) {
  console.log(`   VSIX: ${join(ROOT, "testagent-nodejs-tscode.vsix")}`)
}
