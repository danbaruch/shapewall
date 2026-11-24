import { useState } from 'react'
import { Plus } from 'lucide-react'
import { FAQ } from '../faq-data.js'
import { DURATION, EASE, SPRING, m } from './motion.jsx'

export { FAQ }

// The answer settles in each time its question opens. The prerendered answer is plain and visible inside <details>,
// so it reads (and finds in page) without JavaScript.
function Item({ item }) {
  const [opened, setOpened] = useState(0)
  return (
    <details className="group py-1" onToggle={(event) => event.currentTarget.open && setOpened((count) => count + 1)}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-4 text-[16.5px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
        {item.q}
        <Plus
          className="size-5 shrink-0 text-faint transition-transform duration-200 ease-[cubic-bezier(0.2,0,0,1)] group-open:rotate-45"
          aria-hidden="true"
        />
      </summary>
      <m.p
        key={opened}
        className="pb-5 text-[15.5px] leading-7 text-slate"
        initial={opened ? { opacity: 0, y: -4 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ opacity: { duration: DURATION.base, ease: EASE.standard }, y: SPRING }}
      >
        {item.a}
      </m.p>
    </details>
  )
}

export function Faq({ items = FAQ }) {
  return (
    <div className="divide-y divide-line border-y border-line">
      {items.map((item) => (
        <Item key={item.q} item={item} />
      ))}
    </div>
  )
}
