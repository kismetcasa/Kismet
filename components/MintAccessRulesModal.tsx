'use client'

import { X } from 'lucide-react'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { MINT_ACCESS_RULES } from '@/lib/patron'

/**
 * Informational modal for the Patron Collection's "Mint Access Rules".
 * Content lives in lib/patron (MINT_ACCESS_RULES) so the copy can be edited in
 * one place. Dismiss via the X, Escape, or a backdrop click — the three feel
 * interchangeable, mirroring the app's other overlays.
 */
export function MintAccessRulesModal({ onClose }: { onClose: () => void }) {
  useEscapeKey(onClose)
  useBodyScrollLock()

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={MINT_ACCESS_RULES.title}
      className="fixed inset-0 z-[60] flex items-start sm:items-center justify-center overflow-y-auto bg-black/80 px-4 py-12"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="relative w-full max-w-lg bg-[#0d0d0d] border border-line">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 className="text-sm font-mono uppercase tracking-widest text-ink">
            {MINT_ACCESS_RULES.title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="p-1.5 text-muted hover:text-ink transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5 flex flex-col gap-5 max-h-[70vh] overflow-y-auto">
          {MINT_ACCESS_RULES.sections.map((section, i) => (
            <section key={i} className="flex flex-col gap-1.5">
              {section.heading && (
                <h3 className="text-[10px] font-mono uppercase tracking-widest text-muted">
                  {section.heading}
                </h3>
              )}
              {section.paragraphs.map((paragraph, j) => (
                <p
                  key={j}
                  className="text-xs font-mono text-dim leading-relaxed"
                >
                  {paragraph}
                </p>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
