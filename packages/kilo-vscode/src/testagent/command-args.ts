/**
 * YOLO / Goal 模式开关 flag。
 *
 * 由 testflow CLI 的 run / run:next / run:continue 消费（对应 config.yaml 的
 * global.yolo / global.goal，flag 优先）。这些 flag 不带位置参数，必须从位置
 * 参数里单独摘出——否则 "/sdt-run --yolo" 会被当成「指定了名为 --yolo 的阶段」，
 * 交互式的阶段选择面板也不会弹出。
 */
export const SDT_MODE_FLAGS = new Set(["--yolo", "--no-yolo", "--goal", "--no-goal"])

export const parseCommandArgs = (text: string): string[] => {
  const args: string[] = []
  let value = ""
  let quote: "'" | '"' | undefined
  let started = false

  for (const char of text.trim()) {
    if (quote) {
      if (char === quote) {
        quote = undefined
      } else {
        value += char
      }
      started = true
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }

    if (/\s/.test(char)) {
      if (started) args.push(value)
      value = ""
      started = false
      continue
    }

    value += char
    started = true
  }

  if (quote) throw new Error(`Unterminated ${quote} quote in command`)
  if (started) args.push(value)
  return args
}