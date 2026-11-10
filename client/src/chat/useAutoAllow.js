import { useEffect, useMemo, useRef, useState } from 'react'
import { answerPermission } from './stream'
import { autoAllowOption, autoAllowRule, canAutoAllow } from './composerModel.js'

// `allowRules`: the rules by thread (this tab only); `allowForChat`: what the
// permission cards read (AllowForChat context); `revokeRule` for the settings.
export function useAutoAllow({ boardId, run, threadId, threadRef, ownerWrites }) {
  const [allowRules, setAllowRules] = useState({})
  // The cards a rule answered.
  const [autoAnswered, setAutoAnswered] = useState(() => new Set())
  // "Allow for this chat": a rule per thread for the exact same request
  // (composerModel.js), answered here with the card's allow-once option.
  const allowForChat = useMemo(
    () => ({
      can: (card) => canAutoAllow(card, { ownerWrites }),
      add: (card) => {
        if (!canAutoAllow(card, { ownerWrites })) return
        const target = run?.threadId || threadRef.current
        const rule = autoAllowRule(card)
        setAllowRules((current) => {
          const list = current[target] || []
          return list.some((entry) => entry.id === rule.id) ? current : { ...current, [target]: [...list, rule] }
        })
      },
      auto: autoAnswered,
    }),
    [ownerWrites, run?.threadId, autoAnswered, threadRef],
  )
  const answeringAuto = useRef(new Set())
  useEffect(() => {
    if (!run || !ownerWrites) return
    const rules = allowRules[run.threadId] || []
    if (!rules.length) return
    for (const card of run.reply.cards) {
      if (answeringAuto.current.has(card.id)) continue
      const optionId = autoAllowOption(card, rules, { ownerWrites })
      if (!optionId) continue
      answeringAuto.current.add(card.id)
      answerPermission(boardId, run.threadId, card.id, optionId)
        .then(() => setAutoAnswered((current) => new Set(current).add(card.id)))
        .catch(() => answeringAuto.current.delete(card.id))
    }
  }, [run, allowRules, ownerWrites, boardId])
  const revokeRule = (rule) =>
    setAllowRules((current) => ({ ...current, [threadId]: (current[threadId] || []).filter((entry) => entry.id !== rule.id) }))
  return { allowRules, setAllowRules, allowForChat, revokeRule }
}
