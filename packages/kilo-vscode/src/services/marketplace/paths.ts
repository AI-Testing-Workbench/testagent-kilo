import * as path from "path"
import * as os from "os"

/**
 * Global config dir: ~/.config/testagent/ (XDG_CONFIG_HOME/testagent)
 * This matches where the CLI reads global config from.
 */
function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdg, "testagent")
}

export class MarketplacePaths {
  /** Project-scope config file: <workspace>/.testagent/testagent.json */
  configPath(scope: "project" | "global", workspace?: string): string {
    // testagent_change: Use testagent.json instead of kilo.json
    if (scope === "project") return path.join(workspace!, ".testagent", "testagent.json")
    return path.join(globalConfigDir(), "testagent.json")
  }

  /** Skill install directory (where the marketplace installer writes to). */
  skillsDir(scope: "project" | "global", workspace?: string): string {
    if (scope === "project") return path.join(workspace!, ".testagent", "skills")
    return path.join(os.homedir(), ".testagent", "skills")
  }
}
