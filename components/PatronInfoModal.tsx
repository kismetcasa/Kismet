'use client'

import { X, ShieldCheck, Check, Ban, LifeBuoy } from 'lucide-react'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import {
  PATRON_MINT_PASS_RULESET,
  type PatronRulesetTone,
} from '@/lib/patronCollection'

// Per-tone accent + icon for each ruleset section. `valid` reuses the success
// green the share/copy affordance uses; `invalid` the soft red; `contact` the
// brand accent so it reads as "reach out" rather than a warning.
const TONE: Record<
  PatronRulesetTone,
  { icon: typeof Check; className: string }
> = {
  valid: { icon: Check, className: 'text-[#6ee7b7]' },
  invalid: { icon: Ban, className: 'text-[#c87474]' },
  contact: { icon: LifeBuoy, className: 'text-accent' },
}

/**
 * Read-only "Mint Pass Ruleset" modal for the Patron Collection page. Opened
 * from the header Information button (CollectionView). Centered, scrollable
 * card so the full ruleset is reachable on small screens; dismisses on
 * backdrop click, Escape, or the X. Copy lives in PATRON_MINT_PASS_RULESET.
 */
export function PatronInfoModal({ onClose }: { onClose: () => void }) {
  useBodyScrollLock()
  useEscapeKey(onClose)

  const { title, notice, sections } = PATRON_MINT_PASS_RULESET

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center overflow-y-auto p-4 bg-black/80"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md my-auto bg-surface border border-line p-5 sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-mono text-ink uppercase tracking-widest">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-ink transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Anti-phishing notice — first thing a buyer should check. */}
        <div className="flex items-start gap-2.5 border border-accent/40 bg-accent/5 px-3 py-2.5 mb-5">
          <ShieldCheck size={14} className="text-accent flex-shrink-0 mt-0.5" />
          <p className="text-xs font-mono text-dim leading-relaxed">{notice}</p>
        </div>

        <div className="flex flex-col gap-5">
          {sections.map((section) => {
            const { icon: Icon, className } = TONE[section.tone]
            return (
              <section key={section.heading}>
                <h3 className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2.5">
                  {section.heading}
                </h3>
                <ul className="flex flex-col gap-2">
                  {section.items.map((item) => (
                    <li key={item} className="flex items-start gap-2.5">
                      <Icon
                        size={13}
                        className={`${className} flex-shrink-0 mt-0.5`}
                      />
                      <span className="text-xs font-mono text-dim leading-relaxed">
                        {item}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
