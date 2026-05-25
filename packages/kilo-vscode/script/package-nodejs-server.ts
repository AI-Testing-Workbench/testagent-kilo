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

// testagent_change - check if node_modules already exists (from cache)
const nodeModulesPath = join(TARGET, "node_modules")
const hasNodeModules = existsSync(nodeModulesPath)

if (hasNodeModules) {
  console.log("✅ node_modules found (from cache), skipping installation")
  console.log("Step 3: Verifying cached dependencies...")
} else {
  console.log("📥 node_modules not found, installing dependencies...")

  // testagent_change start - install platform-specific binaries based on target
  console.log("Step 3.1: Installing base dependencies...")
  await $`cd ${TARGET} && npm install --omit=dev --omit=optional`

  // testagent_change - map VS Code target to node-pty platform names
  const platformMap: Record<string, string[]> = {
    "linux-x64": ["linux-x64"],
    "linux-arm64": ["linux-arm64"],
    "alpine-x64": ["linux-x64"], // Alpine uses linux binaries
    "alpine-arm64": ["linux-arm64"],
    "darwin-x64": ["darwin-x64"],
    "darwin-arm64": ["darwin-arm64"],
    "win32-x64": ["win32-x64"],
  }

  const platforms = targetPlatform ? platformMap[targetPlatform] || [] : Object.values(platformMap).flat()
  const uniquePlatforms = [...new Set(platforms)]

  console.log(`Step 3.2: Manually downloading platform binaries for: ${uniquePlatforms.join(", ")}...`)

  // Download and extract platform-specific packages directly from npm registry
  for (const platform of uniquePlatforms) {
    const packages = [
      { name: `@lydell/node-pty-${platform}`, version: "1.2.0-beta.10" },
      { name: `@parcel/watcher-${platform}`, version: "2.5.0" },
    ]

    for (const pkg of packages) {
      const tarballUrl = `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split("/")[1]}-${pkg.version}.tgz`
      const targetDir = join(TARGET, "node_modules", pkg.name)

      console.log(`  Downloading ${pkg.name}@${pkg.version}...`)

      try {
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
      } catch (err) {
        console.warn(`  ⚠️  Failed to install ${pkg.name}: ${err}`)
      }
    }
  }
}

// Verify critical platform packages were installed
console.log("Step 3.3: Verifying platform binaries...")
const platformMap: Record<string, string[]> = {
  "linux-x64": ["linux-x64"],
  "linux-arm64": ["linux-arm64"],
  "alpine-x64": ["linux-x64"],
  "alpine-arm64": ["linux-arm64"],
  "darwin-x64": ["darwin-x64"],
  "darwin-arm64": ["darwin-arm64"],
  "win32-x64": ["win32-x64"],
}
const platforms = targetPlatform ? platformMap[targetPlatform] || [] : Object.values(platformMap).flat()
const uniquePlatforms = [...new Set(platforms)]

const missing = []
for (const platform of uniquePlatforms) {
  const pkgPath = join(TARGET, "node_modules", `@lydell/node-pty-${platform}`)
  if (!existsSync(pkgPath)) {
    missing.push(platform)
    console.log(`  ✗ node-pty-${platform} NOT FOUND`)
  } else {
    console.log(`  ✓ node-pty-${platform}`)
  }
}

if (missing.length > 0 && targetPlatform) {
  console.error(`\n❌ Error: Missing node-pty binaries for: ${missing.join(", ")}`)
  console.error("   Extension will not work on these platforms!")
  process.exit(1)
} else if (missing.length > 0) {
  console.warn(`\n⚠️  Warning: Missing node-pty binaries for: ${missing.join(", ")}`)
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
