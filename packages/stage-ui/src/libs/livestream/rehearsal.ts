import type { Snapshot } from './session'

/** Reading time approximates 220 characters per minute, with a pause at each sentence boundary. */
export function readingDuration(text: string) {
  const characters = Array.from(text.replace(/\s/gu, '')).length
  return Math.max(2500, Math.round(characters / 220 * 60_000 + 800))
}

/** Displays elapsed rehearsal time without the machine's timezone. */
export function rehearsalTime(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000)
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

/** Exports the operator brief and actual session events as plain Markdown, without executable HTML. */
export function rehearsalMarkdown(state: Snapshot) {
  const lines = [
    `# ${state.settings.direction}`,
    '',
    `Session: ${state.sessionId}`,
    `Mode: ${state.settings.mode}`,
    `Elapsed: ${rehearsalTime(state.elapsedMs)}`,
    '',
    '## Brief',
    '',
    state.settings.details,
    '',
    '## Transcript',
    '',
  ]
  for (const entry of state.transcript) {
    const speaker = entry.kind === 'comment' ? entry.nickname : entry.kind
    lines.push(`### ${rehearsalTime(entry.elapsedMs)} · ${speaker}${entry.action ? ` · ${entry.action}` : ''}`, '')
    for (const reply of entry.replies)
      lines.push(`> ${reply.nickname}: ${reply.text.replace(/\n/gu, '\n> ')}`, '')
    lines.push(entry.text, '')
    if (entry.kind === 'host' && !entry.completed)
      lines.push('(Interrupted)', '')
  }
  return lines.join('\n')
}
