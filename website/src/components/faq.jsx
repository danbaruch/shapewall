import { Plus } from 'lucide-react'
import { FAQ } from '../faq-data.js'

export { FAQ }

export function Faq({ items = FAQ }) {
  return (
    <div className="divide-y divide-line border-y border-line">
      {items.map((item) => (
        <details key={item.q} className="group py-1">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-4 text-[16.5px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
            {item.q}
            <Plus className="size-5 shrink-0 text-faint transition-transform group-open:rotate-45" aria-hidden="true" />
          </summary>
          <p className="pb-5 text-[15.5px] leading-7 text-slate">{item.a}</p>
        </details>
      ))}
    </div>
  )
}
