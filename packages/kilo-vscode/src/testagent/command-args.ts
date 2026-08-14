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