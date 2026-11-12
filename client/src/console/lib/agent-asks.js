// What a machine running `shapewall agent connect` said it takes from the
// board ({ approvals, auto, base }: its own rules, reported by its terminal
// and enforced there), in words for the person who approves the connection.
// `asks` is null when the terminal did not say (an older shapewall).

const TOKEN = 'Its token can read comments, reply, set agent statuses and take work; it cannot resolve comments or push.'

// { mode: 'read' | 'edits' | 'unknown', lines: [...] }
export function agentAsks(asks) {
  if (!asks || typeof asks !== 'object') {
    return {
      mode: 'unknown',
      lines: [
        "It reads the project on that machine and answers questions in the board's chat, and it reads and answers comments sent to it.",
        'This terminal did not say whether it also takes edits from the board (an older shapewall). Its own output says what it does when it connects.',
        TOKEN,
      ],
    }
  }
  const reads = "Reads the project on that machine and answers questions in the board's chat and comments sent to it."
  if (!['owner', 'admins'].includes(asks.approvals)) {
    return { mode: 'read', lines: [reads, 'Does not change files and runs no commands: that machine refuses both.', TOKEN] }
  }
  const who = asks.approvals === 'owner' ? 'you, the person who connects it' : 'whoever this server lets answer (admins by default)'
  const lines = [
    reads,
    `Edits files when a fix is asked on the board. Each edit is shown on the board and waits for ${who}. A fix is made on a new branch, never in that machine's checkout.`,
  ]
  if (asks.auto)
    lines.push(
      `Asked to allow edits without asking: that stays off until ${asks.approvals === 'owner' ? 'you switch' : 'an admin switches'} it on, on the project's Agents page. Such a fix is not pushed until a person has looked at its whole diff.`,
    )
  lines.push(asks.base ? `A fix starts from the branch ${asks.base}.` : "A fix starts from the commit that machine's checkout is on.")
  lines.push('Never runs a command for the board: that machine refuses them.')
  lines.push(TOKEN)
  return { mode: 'edits', lines }
}

// One sentence for the page that follows the approval.
export function agentAsksDone(asks) {
  const { mode } = agentAsks(asks)
  if (mode === 'edits')
    return `It reads the project and answers, and it makes fixes asked on the board on a branch of their own, each edit allowed by ${
      asks.approvals === 'owner' ? 'you' : 'whoever this server lets answer'
    } first; it runs no commands.`
  if (mode === 'read') return 'It reads the project and answers; it does not change files or run commands.'
  return 'It reads the project and answers; its terminal says whether it also takes edits from the board.'
}
