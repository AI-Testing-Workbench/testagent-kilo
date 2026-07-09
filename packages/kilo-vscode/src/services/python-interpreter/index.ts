// testagent_change - new file
import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"

interface PythonInterpreterInfo {
  path: string
  version?: string
  envName?: string
  envPath?: string
  timestamp: number
}

/**
 * Python 解释器监听服务
 * 监听 Python 扩展的解释器变更事件，并将信息保存到项目的 .testagent 目录
 */
export class PythonInterpreterService {
  private disposables: vscode.Disposable[] = []
  private lastInterpreterInfo: Map<string, PythonInterpreterInfo> = new Map()

  constructor(private context: vscode.ExtensionContext) {}

  /**
   * 启动服务，开始监听 Python 解释器变更
   */
  async start() {
    console.log("[TestAgent][PythonInterpreter] Service starting...")
    
    // 尝试获取 Python 扩展
    const pythonExtension = vscode.extensions.getExtension("ms-python.python")
    
    if (!pythonExtension) {
      console.log("[TestAgent][PythonInterpreter] Python extension not found, skipping Python interpreter monitoring")
      return
    }

    console.log("[TestAgent][PythonInterpreter] Python extension found, checking activation state...")

    // 确保 Python 扩展已激活
    if (!pythonExtension.isActive) {
      console.log("[TestAgent][PythonInterpreter] Python extension not active, activating...")
      try {
        await pythonExtension.activate()
        console.log("[TestAgent][PythonInterpreter] Python extension activated successfully")
      } catch (error) {
        console.error("[TestAgent][PythonInterpreter] Failed to activate Python extension:", error)
        return
      }
    } else {
      console.log("[TestAgent][PythonInterpreter] Python extension already active")
    }

    // 检查是否为多根工作区
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (workspaceFolders && workspaceFolders.length > 1) {
      console.warn("[TestAgent][PythonInterpreter] TestAgent不支持多根工作区场景的python解释器处理")
      return
    }

    // 初始化工作区的 Python 解释器信息
    console.log("[TestAgent][PythonInterpreter] Initializing Python interpreter info for the first workspace...")
    await this.refreshAllWorkspaces()

    // 监听 Python 解释器变更事件
    // Python 扩展提供了 onDidChangeInterpreter 事件
    try {
      const api = pythonExtension.exports
      
      if (api && typeof api.environments?.onDidChangeActiveEnvironmentPath === "function") {
        // 使用新的 API (Python extension v2023.x+)
        this.disposables.push(
          api.environments.onDidChangeActiveEnvironmentPath(
            (e: any) => {
              console.log("[TestAgent][PythonInterpreter] Python interpreter changed (new API):", e)
              
              // 安全提取事件参数
              let resource: vscode.Uri | undefined
              let interpreterPath: string | undefined
              
              try {
                // 新版 API 可能返回不同结构
                if (typeof e === "object" && e !== null) {
                  resource = e.resource || e.uri
                  interpreterPath = e.path || e.id
                } else if (typeof e === "string") {
                  interpreterPath = e
                }
                
                if (!interpreterPath) {
                  console.warn("[TestAgent][PythonInterpreter] No interpreter path in event, skipping")
                  return
                }
                
                this.handleInterpreterChange(resource, interpreterPath).catch((error) => {
                  console.error("[TestAgent][PythonInterpreter] Error handling interpreter change:", error)
                })
              } catch (error) {
                console.error("[TestAgent][PythonInterpreter] Error processing interpreter change event:", error)
              }
            },
          ),
        )
        console.log("[TestAgent][PythonInterpreter] Python interpreter change listener registered (new API)")
      } else if (api && typeof api.onDidChangePythonInterpreter === "function") {
        // 使用旧的 API
        this.disposables.push(
          api.onDidChangePythonInterpreter(() => {
            console.log("[TestAgent][PythonInterpreter] Python interpreter changed (legacy API)")
            this.refreshAllWorkspaces().catch((error) => {
              console.error("[TestAgent][PythonInterpreter] Error refreshing workspaces:", error)
            })
          }),
        )
        console.log("[TestAgent][PythonInterpreter] Python interpreter change listener registered (legacy API)")
      } else {
        console.warn("[TestAgent][PythonInterpreter] No suitable Python interpreter change API found")
      }
    } catch (error) {
      console.error("[TestAgent][PythonInterpreter] Failed to register Python interpreter listener:", error)
    }
    
    console.log("[TestAgent][PythonInterpreter] Service started successfully")
  }

  /**
   * 刷新所有工作区的 Python 解释器信息
   */
  private async refreshAllWorkspaces() {
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (!workspaceFolders || workspaceFolders.length === 0) {
      console.log("[TestAgent][PythonInterpreter] No workspace folders found")
      return
    }

    // 检查是否为多根工作区
    if (workspaceFolders.length > 1) {
      console.warn("[TestAgent][PythonInterpreter] TestAgent不支持多根工作区场景的python解释器处理")
      return
    }

    // 只处理第一个（唯一的）工作区
    console.log(`[TestAgent][PythonInterpreter] Refreshing Python interpreter for workspace: "${workspaceFolders[0].name}"`)
    await this.updateInterpreterInfoForWorkspace(workspaceFolders[0].uri)
  }

  /**
   * 处理 Python 解释器变更事件
   */
  private async handleInterpreterChange(resource: vscode.Uri | vscode.WorkspaceFolder | undefined, interpreterPath: string) {
    console.log(`[TestAgent][PythonInterpreter] handleInterpreterChange called with interpreterPath="${interpreterPath}"`)
    
    try {
      // 检查是否为多根工作区
      const workspaceFolders = vscode.workspace.workspaceFolders
      if (workspaceFolders && workspaceFolders.length > 1) {
        console.warn("[TestAgent][PythonInterpreter] TestAgent不支持多根工作区场景的python解释器处理")
        return
      }

      // 确定目标工作区
      let workspaceFolder: vscode.WorkspaceFolder | undefined

      if (resource) {
        // WorkspaceFolder 直接使用
        if ("uri" in resource && "name" in resource && "index" in resource) {
          workspaceFolder = resource
          console.log(`[TestAgent][PythonInterpreter] Using provided WorkspaceFolder: "${workspaceFolder.name}"`)
        } 
        // Uri 需要查找对应的 WorkspaceFolder
        else if ("fsPath" in resource) {
          workspaceFolder = vscode.workspace.getWorkspaceFolder(resource as vscode.Uri)
          console.log(workspaceFolder 
            ? `[TestAgent][PythonInterpreter] Found WorkspaceFolder for Uri: "${workspaceFolder.name}"`
            : `[TestAgent][PythonInterpreter] No WorkspaceFolder found for provided Uri`)
        }
      }

      // Fallback 到第一个工作区
      if (!workspaceFolder) {
        workspaceFolder = workspaceFolders?.[0]
        if (workspaceFolder) {
          console.log(`[TestAgent][PythonInterpreter] Using first workspace as fallback: "${workspaceFolder.name}"`)
        }
      }

      if (!workspaceFolder) {
        console.log("[TestAgent][PythonInterpreter] No workspace folder available, skipping interpreter update")
        return
      }

      // 更新解释器配置
      console.log(`[TestAgent][PythonInterpreter] Updating interpreter for workspace "${workspaceFolder.name}"`)
      await this.updateInterpreterInfoForWorkspace(workspaceFolder.uri, interpreterPath)
      console.log(`[TestAgent][PythonInterpreter] Successfully updated interpreter for workspace "${workspaceFolder.name}"`)
    } catch (error) {
      console.error("[TestAgent][PythonInterpreter] Error in handleInterpreterChange:", error)
    }
  }

  /**
   * 更新指定工作区的 Python 解释器信息
   */
  private async updateInterpreterInfoForWorkspace(workspaceUri: vscode.Uri, interpreterPath?: string) {
    console.log("[TestAgent][PythonInterpreter] Updating interpreter info for workspace:", workspaceUri.fsPath)
    
    try {
      const pythonExtension = vscode.extensions.getExtension("ms-python.python")
      if (!pythonExtension?.isActive) {
        console.log("[TestAgent][PythonInterpreter] Python extension not active, skipping update")
        return
      }

      const api = pythonExtension.exports
      if (!api) {
        console.log("[TestAgent][PythonInterpreter] Python extension API not available")
        return
      }

      let pythonPath: string | undefined = interpreterPath

      // 如果没有提供 interpreterPath，尝试获取当前激活的解释器
      if (!pythonPath) {
        console.log("[TestAgent][PythonInterpreter] No interpreter path provided, querying from Python extension...")
        
        if (api.environments?.getActiveEnvironmentPath) {
          // 新 API
          const activeEnv = api.environments.getActiveEnvironmentPath(workspaceUri)
          pythonPath = activeEnv?.path
          console.log("[TestAgent][PythonInterpreter] Got interpreter from new API:", pythonPath)
        } else if (api.settings?.getExecutionDetails) {
          // 旧 API
          const execDetails = api.settings.getExecutionDetails(workspaceUri)
          pythonPath = execDetails?.execCommand?.[0]
          console.log("[TestAgent][PythonInterpreter] Got interpreter from legacy API:", pythonPath)
        }
      } else {
        console.log("[TestAgent][PythonInterpreter] Using provided interpreter path:", pythonPath)
      }

      if (!pythonPath) {
        console.log("[TestAgent][PythonInterpreter] No Python interpreter found for workspace:", workspaceUri.fsPath)
        return
      }

      // 获取解释器详细信息
      let interpreterInfo: PythonInterpreterInfo = {
        path: pythonPath,
        timestamp: Date.now(),
      }

      // 尝试获取更多信息
      if (api.environments?.resolveEnvironment) {
        console.log("[TestAgent][PythonInterpreter] Resolving environment details...")
        try {
          const envDetails = await api.environments.resolveEnvironment(pythonPath)
          if (envDetails) {
            interpreterInfo = {
              path: envDetails.path || pythonPath,
              version: envDetails.version?.major && envDetails.version?.minor
                ? `${envDetails.version.major}.${envDetails.version.minor}.${envDetails.version.micro || 0}`
                : undefined,
              envName: envDetails.environment?.name,
              envPath: envDetails.environment?.folderUri?.fsPath,
              timestamp: Date.now(),
            }
            console.log("[TestAgent][PythonInterpreter] Environment details resolved:", {
              version: interpreterInfo.version,
              envName: interpreterInfo.envName,
              path: interpreterInfo.path,
            })
          }
        } catch (error) {
          console.warn("[TestAgent][PythonInterpreter] Failed to resolve Python environment details:", error)
        }
      }

      // 检查是否有变化
      const workspacePath = workspaceUri.fsPath
      const lastInfo = this.lastInterpreterInfo.get(workspacePath)
      
      if (lastInfo && lastInfo.path === interpreterInfo.path) {
        console.log("[TestAgent][PythonInterpreter] Interpreter path unchanged, skipping update")
        return
      }

      console.log("[TestAgent][PythonInterpreter] Interpreter changed from", lastInfo?.path, "to", interpreterInfo.path)

      // 保存到 .testagent 目录
      await this.saveInterpreterInfo(workspacePath, interpreterInfo)
      
      // 更新缓存
      this.lastInterpreterInfo.set(workspacePath, interpreterInfo)
      
      console.log("[TestAgent][PythonInterpreter] Python interpreter info updated successfully")
    } catch (error) {
      console.error("[TestAgent][PythonInterpreter] Failed to update Python interpreter info:", error)
    }
  }

  /**
   * 将 Python 解释器信息保存到 .testagent 目录
   */
  private async saveInterpreterInfo(workspacePath: string, info: PythonInterpreterInfo) {
    const testagentDir = path.join(workspacePath, ".testagent")
    const configPath = path.join(testagentDir, "python-interpreter.json")

    console.log("[TestAgent][PythonInterpreter] Saving interpreter info to:", configPath)

    try {
      // 确保 .testagent 目录存在
      if (!fs.existsSync(testagentDir)) {
        console.log("[TestAgent][PythonInterpreter] Creating .testagent directory")
        fs.mkdirSync(testagentDir, { recursive: true })
      }

      // 写入配置文件
      fs.writeFileSync(configPath, JSON.stringify(info, null, 2), "utf-8")
      
      console.log("[TestAgent][PythonInterpreter] Python interpreter info saved successfully:", {
        path: info.path,
        version: info.version,
        envName: info.envName,
      })
    } catch (error) {
      console.error("[TestAgent][PythonInterpreter] Failed to save Python interpreter info:", error)
      throw error
    }
  }

  /**
   * 停止服务，清理资源
   */
  dispose() {
    for (const disposable of this.disposables) {
      disposable.dispose()
    }
    this.disposables = []
    this.lastInterpreterInfo.clear()
  }
}