/** Public, VS Code-free facade for the Agent Manager run protocol. */
import {
  AGENT_MANAGER_API_VERSION,
  MAX_RUN_VARIANTS,
  RunOrchestrator,
  type AgentManagerRunRequest,
  type AgentManagerRunResponse,
  type AgentManagerRunStatus,
  type RunCapabilities,
  type RunEvent,
  type RunError,
  type RunOrchestratorOptions,
} from "./RunOrchestrator"

export { AGENT_MANAGER_API_VERSION, MAX_RUN_VARIANTS }
export type {
  AgentManagerRunRequest,
  AgentManagerRunResponse,
  AgentManagerRunStatus,
  RunCapabilities,
  RunEvent,
  RunError,
  RunOrchestratorOptions,
}

export interface RunStatusArgs {
  runId: string
}

export interface RunEventsArgs {
  runId: string
  afterSeq?: number
}

export interface CancelArgs {
  runId: string
}

export type RunIdArg = string | RunStatusArgs
export type EventsArg = RunEventsArgs | string
export type CancelArg = string | CancelArgs

/**
 * Stable command-facing wrapper. Keeping this facade free of `vscode` makes
 * it usable by tests and by other hosts while extension.ts owns registration.
 */
export class AgentManagerPublicApi {
  readonly orchestrator: RunOrchestrator

  constructor(orchestrator: RunOrchestrator)
  constructor(options?: RunOrchestratorOptions)
  constructor(input: RunOrchestrator | RunOrchestratorOptions = {}) {
    this.orchestrator = input instanceof RunOrchestrator ? input : new RunOrchestrator(input)
  }

  capabilities(): RunCapabilities {
    return this.orchestrator.capabilities()
  }

  run(request: AgentManagerRunRequest): Promise<AgentManagerRunResponse> {
    return this.orchestrator.run(request)
  }

  start(request: AgentManagerRunRequest): Promise<AgentManagerRunResponse> {
    return this.run(request)
  }

  getRunStatus(input: RunIdArg): Promise<AgentManagerRunStatus | undefined> {
    return this.orchestrator.getRunStatus(typeof input === "string" ? input : input.runId)
  }

  getStatus(input: RunIdArg): Promise<AgentManagerRunStatus | undefined> {
    return this.getRunStatus(input)
  }

  getRunEvents(input: EventsArg, afterSeq = 0): Promise<RunEvent[]> {
    if (typeof input === "string") return this.orchestrator.getRunEvents(input, afterSeq)
    return this.orchestrator.getRunEvents(input.runId, input.afterSeq ?? 0)
  }

  getEvents(input: EventsArg, afterSeq = 0): Promise<RunEvent[]> {
    return this.getRunEvents(input, afterSeq)
  }

  cancel(input: CancelArg): Promise<{ accepted: boolean; status?: AgentManagerRunStatus["status"]; error?: RunError }> {
    return this.orchestrator.cancel(typeof input === "string" ? input : input.runId)
  }

  dispose(): void {
    this.orchestrator.dispose()
  }
}

export function createAgentManagerPublicApi(options: RunOrchestratorOptions = {}): AgentManagerPublicApi {
  return new AgentManagerPublicApi(options)
}

export default AgentManagerPublicApi