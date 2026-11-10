export type Script = {
  text?: string
  reasoning?: string
  tools: Array<{ tool: string; callID: string; input: Record<string, unknown> }>
  reason?: string
}

type Input = {
  type: "text" | "file" | "agent" | "subtask"
  text?: string
  mime?: string
  filename?: string
  url?: string
  name?: string
  prompt?: string
  description?: string
  agent?: string
  command?: string
  model?: { providerID: string; modelID: string }
}

export type Turn = {
  parts: Input[]
  scripts: Script[]
  agent?: string
  model?: { providerID: string; modelID: string }
}

type Part = {
  id: string
  type?: string
  text?: string
  tool?: string
  callID?: string
  reason?: string
  mime?: string
  filename?: string
  url?: string
  name?: string
  prompt?: string
  description?: string
  agent?: string
  command?: string
  synthetic?: boolean
  ignored?: boolean
  model?: { providerID: string; modelID: string }
  state?: { input?: Record<string, unknown> }
}

export type Msg = {
  info: {
    id: string
    role?: string
    agent?: string
    model?: { providerID: string; modelID: string }
  }
  parts: Part[]
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string }

function draft(slice: Part[]): Script {
  const texts: string[] = []
  const thoughts: string[] = []
  const tools: Script["tools"] = []
  const reasons: string[] = []
  for (const part of slice) {
    if (part.type === "text" && part.text) texts.push(part.text)
    if (part.type === "reasoning" && part.text) thoughts.push(part.text)
    if (part.type === "tool" && part.tool) {
      tools.push({
        tool: part.tool,
        callID: part.callID || part.id,
        input: part.state?.input ?? {},
      })
    }
    if (part.type === "step-finish" && part.reason) reasons.push(part.reason)
  }
  return {
    text: texts.join("") || undefined,
    reasoning: thoughts.join("") || undefined,
    tools,
    reason: reasons[0],
  }
}

function pack(parts: Part[]): Script[] {
  return parts
    .reduce<Part[][]>((acc, part) => {
      if (part.type === "step-start") return [...acc, []]
      const last = acc[acc.length - 1]
      if (!last) return acc
      last.push(part)
      return acc
    }, [])
    .map(draft)
}

function role(msg: Msg): "user" | "assistant" {
  if (msg.info.role === "user" || msg.info.role === "assistant") return msg.info.role
  if (msg.parts.some((part) => part.type === "step-start")) return "assistant"
  return "user"
}

function model(msg: Msg) {
  const ref = msg.info.model
  if (!ref?.providerID || !ref.modelID) return
  return { providerID: ref.providerID, modelID: ref.modelID }
}

function inputs(msg: Msg): Input[] {
  return msg.parts.flatMap((part) => {
    if (part.type === "text" && part.text && !part.synthetic && !part.ignored) {
      return [{ type: "text" as const, text: part.text }]
    }
    if (part.type === "file" && part.mime && part.url) {
      return [{ type: "file" as const, mime: part.mime, filename: part.filename, url: part.url }]
    }
    if (part.type === "agent" && part.name) {
      return [{ type: "agent" as const, name: part.name }]
    }
    if (part.type === "subtask" && part.prompt && part.description && part.agent) {
      return [
        {
          type: "subtask" as const,
          prompt: part.prompt,
          description: part.description,
          agent: part.agent,
          command: part.command,
          model: part.model,
        },
      ]
    }
    return []
  })
}

export function plan(
  msgs: Msg[],
  messageId: string,
  partId: string,
  span: "step" | "rest" = "step",
): Result<{ scripts: Script[]; turns: Turn[] }> {
  const idx = msgs.findIndex((item) => item.info.id === messageId)
  if (idx < 0) return { ok: false, error: "Replay message not found" }
  const msg = msgs[idx]
  const at = msg.parts.findIndex((part) => part.id === partId)
  if (at < 0) return { ok: false, error: "Replay step not found" }
  const head = pack(msg.parts.slice(at))
  if (head.length === 0) return { ok: false, error: "Replay step not found" }
  if (span !== "rest") return { ok: true, value: { scripts: [head[0]], turns: [] } }
  const out = msgs.slice(idx + 1).reduce<{ scripts: Script[]; turns: Turn[] }>(
    (acc, item) => {
      const kind = role(item)
      if (kind === "user") {
        const parts = inputs(item)
        if (parts.length === 0) return acc
        return {
          scripts: acc.scripts,
          turns: [...acc.turns, { parts, scripts: [], agent: item.info.agent, model: model(item) }],
        }
      }
      const steps = pack(item.parts)
      if (steps.length === 0) return acc
      const last = acc.turns[acc.turns.length - 1]
      if (!last) return { scripts: [...acc.scripts, ...steps], turns: acc.turns }
      return {
        scripts: acc.scripts,
        turns: [...acc.turns.slice(0, -1), { ...last, scripts: [...last.scripts, ...steps] }],
      }
    },
    { scripts: head, turns: [] },
  )
  return {
    ok: true,
    value: {
      scripts: out.scripts,
      turns: out.turns.filter((item) => item.scripts.length > 0 && item.parts.length > 0),
    },
  }
}
