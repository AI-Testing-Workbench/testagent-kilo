// testagent_change - new file
import * as fs from "node:fs/promises"
import { randomUUID } from "node:crypto"

export class CloudFileError extends Error {
  constructor(
    message: string,
    readonly code: "write_failed" | "cleanup_failed",
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = "CloudFileError"
  }
}

export async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = await temporary(file, text)
  try {
    await fs.rename(temp, file)
  } catch (err) {
    throw new CloudFileError("无法以原子方式写入本地工作区码云仓库", "write_failed", err)
  } finally {
    await remove(temp)
  }
}

export async function createAtomic(file: string, text: string): Promise<boolean> {
  const temp = await temporary(file, text)
  try {
    return await fs.link(temp, file).then(
      () => true,
      (err: NodeJS.ErrnoException) => {
        if (err.code === "EEXIST") return false
        throw new CloudFileError("无法初始化本地工作区码云仓库状态文件", "write_failed", err)
      },
    )
  } finally {
    await remove(temp)
  }
}

async function temporary(file: string, text: string): Promise<string> {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, text, { flag: "wx" })
    return temp
  } catch (err) {
    await remove(temp)
    throw new CloudFileError("无法写入本地工作区码云仓库临时文件", "write_failed", err)
  }
}

async function remove(file: string): Promise<void> {
  await fs.rm(file, { force: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw new CloudFileError("无法清理本地工作区码云仓库临时文件", "cleanup_failed", err)
  })
}
