'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import { MomentImage } from './MomentImage'
import { shortAddress } from '@/lib/inprocess'

/**
 * A machine's window: what a player watches between pressing the button and
 * seeing what they got. The same three stages for both kinds of machine:
 *
 *   idle      its cover
 *   dispense  a capsule rocking over the dimmed cover while the wallet and the
 *             draw work (a capsule machine's play; a reveal's pull waits on
 *             nothing)
 *   open      the capsule opening, once, when there is something to show —
 *             skippable, and never started for a viewer who asked for less
 *             motion (the machines check motionAllowed first)
 *
 * The motion is CSS keyed off `data-stage` (app/globals.css). The open's length
 * is set here and handed to the CSS as --stage-open, so the timer that ends it
 * and the animation cannot drift apart.
 */

export type Stage = 'idle' | 'dispense' | 'open'

/** Long enough to read as a capsule opening; the skip covers anyone for whom
 *  it is still a wait. */
export const OPEN_MS = 1200

/** Whether to play the open. Read at the moment of the play, on the same query
 *  as the keyframes, so the two agree on every browser — one that reports
 *  neither preference gets no animation. */
export function motionAllowed(): boolean {
  return window.matchMedia('(prefers-reduced-motion: no-preference)').matches
}

export function MachineStage({
  stage,
  cover,
  onOpened,
}: {
  stage: Stage
  /** The machine's cover; null (or one that will not load) shows the capsule. */
  cover: string | null
  /** Called once the open has played or been skipped. Keep it stable: a new
   *  function restarts the open. */
  onOpened?: () => void
}) {
  // The cover that would not load, so a new one (the creator can change it
  // while the page is open) gets its own chance.
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    if (stage !== 'open' || !onOpened) return
    const t = setTimeout(onOpened, OPEN_MS)
    return () => clearTimeout(t)
  }, [stage, onOpened])

  const shown = cover && cover !== failed ? cover : null
  return (
    <div className="mb-5">
      <div
        data-stage={stage}
        className="relative aspect-square w-full max-w-[15rem] mx-auto overflow-hidden border border-line bg-raised"
        style={{ '--stage-open': `${OPEN_MS}ms` } as CSSProperties}
      >
        {shown && (
          <MomentImage
            src={shown}
            alt=""
            fill
            preferProxy
            sizes="240px"
            className={`object-contain transition-opacity duration-300 ${stage === 'idle' ? '' : 'opacity-30'}`}
            onAllError={() => setFailed(shown)}
          />
        )}
        {(stage !== 'idle' || !shown) && <Capsule />}
      </div>
      {stage === 'open' && (
        <button
          onClick={onOpened}
          className="mt-3 px-3 py-1 text-[10px] font-mono uppercase tracking-widest text-muted hover:text-ink"
        >
          skip
        </button>
      )}
    </div>
  )
}

/** The default capsule: two halves and a seam, in the site's own colours, so a
 *  themed accent carries through. */
function Capsule() {
  return (
    <svg viewBox="0 0 100 100" aria-hidden className="absolute inset-[20%] w-3/5 h-3/5 overflow-visible">
      <circle className="stage-burst fill-accent/30 stroke-accent" strokeWidth="2" cx="50" cy="50" r="44" />
      <g className="stage-lid">
        <path className="fill-accent" d="M10 50a40 40 0 0 1 80 0z" />
        <ellipse className="fill-ink/40" cx="32" cy="29" rx="10" ry="5" transform="rotate(-35 32 29)" />
      </g>
      <g className="stage-base">
        <path className="fill-ink" d="M10 50a40 40 0 0 0 80 0z" />
        <rect className="fill-surface" x="9" y="48.25" width="82" height="3.5" />
      </g>
    </svg>
  )
}

/** The last beat of a play or a collect, in the words a player expects. */
export function CollectedLine({ title, artist }: { title: string; artist: string }) {
  return (
    <p className="text-[11px] font-mono text-muted">
      you&apos;ve collected <span className="text-ink group-hover:underline">{title}</span> by {shortAddress(artist)}
    </p>
  )
}
