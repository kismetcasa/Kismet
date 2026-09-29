'use client'

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { MomentImage } from './MomentImage'
import { shortAddress } from '@/lib/inprocess'
import { proxyUrl, videoGatewayUrls } from '@/lib/media/gateway'
import { useAllowsVideo } from '@/hooks/useAllowsVideo'
import { FRAME_LIMITS, type MachineFrames, type StageFrame } from '@/lib/experience/types'

/**
 * A machine's window: what a player watches between pressing the button and
 * seeing what they got. The same three stages for both kinds of machine:
 *
 *   idle      its cover
 *   dispense  while a capsule machine's wallet and draw work (a reveal's pull
 *             waits on nothing)
 *   open      once, when there is something to show — skippable, and never
 *             started for a viewer who asked for less motion (the machines
 *             check motionAllowed first)
 *
 * A stage plays the artist's own frame when the machine has one, and the
 * platform's capsule when it does not: rocking over the dimmed cover, then
 * popping open. The capsule's motion is CSS keyed off `data-stage`
 * (app/globals.css); its open's length is set here and handed to the CSS as
 * --stage-open, so the timer that ends it and the animation cannot drift apart.
 *
 * The window stays mounted while a win or a reveal is shown (`stage` null,
 * hidden), so an artist's frames have loaded before the next play needs them.
 */

export type Stage = 'idle' | 'dispense' | 'open'

/** Long enough to read as a capsule opening; the skip covers anyone for whom
 *  it is still a wait. An artist's still holds the open as long. */
export const OPEN_MS = 1200

/** The longest an artist's clip may run, and a little over: the bound on an
 *  open whose clip never reports its end. */
const CLIP_BOUND_MS = FRAME_LIMITS.seconds * 1000 + 500

/** Whether to play the open. Read at the moment of the play, on the same query
 *  as the keyframes, so the two agree on every browser — one that reports
 *  neither preference gets no animation. */
export function motionAllowed(): boolean {
  return window.matchMedia('(prefers-reduced-motion: no-preference)').matches
}

export function MachineStage({
  stage,
  cover,
  frames,
  onOpened,
}: {
  /** null while a face is shown over it. */
  stage: Stage | null
  /** The machine's cover; null (or one that will not load) shows the capsule. */
  cover: string | null
  frames?: MachineFrames | null
  /** Called once the open has played or been skipped. Keep it stable: a new
   *  function restarts the open. */
  onOpened?: () => void
}) {
  // The cover that would not load, so a new one (the creator can change it
  // while the page is open) gets its own chance.
  const [failed, setFailed] = useState<string | null>(null)
  const clips = useAllowsVideo()
  const own = stage === 'dispense' ? frames?.dispense : stage === 'open' ? frames?.open : undefined
  useEffect(() => {
    if (stage !== 'open' || !onOpened) return
    // A clip ends the open itself when it finishes; this only bounds it.
    const t = setTimeout(onOpened, own?.kind === 'video' && clips ? CLIP_BOUND_MS : OPEN_MS)
    return () => clearTimeout(t)
  }, [stage, onOpened, own, clips])

  const shown = cover && cover !== failed ? cover : null
  return (
    <div className="mb-5" hidden={stage === null}>
      <div
        data-stage={stage ?? undefined}
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
            className={`object-contain transition-opacity duration-300 ${stage === 'dispense' || stage === 'open' ? 'opacity-30' : ''}`}
            onAllError={() => setFailed(shown)}
          />
        )}
        {frames?.dispense && (
          <Frame
            key={frames.dispense.uri}
            name="dispense"
            frame={frames.dispense}
            active={stage === 'dispense'}
            clips={clips}
            loop
          />
        )}
        {frames?.open && (
          <Frame key={frames.open.uri} name="open" frame={frames.open} active={stage === 'open'} clips={clips} onEnd={onOpened} />
        )}
        {stage !== null && !own && (stage !== 'idle' || !shown) && <Capsule />}
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

/**
 * An artist's frame for one stage. Mounted from the start and kept mounted,
 * hidden until its stage, so it has loaded by the time it plays; muted and
 * inline, as a phone requires to play it unasked. Its still stands in for a
 * clip wherever the clip cannot play — for a viewer who asked for less motion
 * or to save data, and for one whose browser refuses it. An open whose clip
 * cannot play ends at once rather than holding the stage on a still.
 */
function Frame({
  name,
  frame,
  active,
  clips,
  loop,
  onEnd,
}: {
  name: 'dispense' | 'open'
  frame: StageFrame
  active: boolean
  clips: boolean
  loop?: boolean
  onEnd?: () => void
}) {
  const ref = useRef<HTMLVideoElement>(null)
  const urls = useMemo(() => videoGatewayUrls(frame.uri), [frame.uri])
  const [at, setAt] = useState(0)
  const [refused, setRefused] = useState(false)
  const playing = frame.kind === 'video' && clips && !refused && at < urls.length
  const giveUp = () => {
    setRefused(true)
    if (active && !loop) onEnd?.()
  }
  useEffect(() => {
    const v = ref.current
    if (!v || !playing) return
    if (!active) {
      v.pause()
      return
    }
    v.currentTime = 0
    // An AbortError is a pause (the stage moved on) overtaking the play, not a
    // refusal; anything else — autoplay refused, a low-power mode — is one.
    v.play().catch((err: unknown) => {
      if ((err as { name?: string })?.name !== 'AbortError') giveUp()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- giveUp reads this render's props
  }, [active, playing])

  const hidden = active ? '' : 'invisible'
  if (!playing) {
    return (
      <div data-frame={name} className={`absolute inset-0 ${hidden}`}>
        <MomentImage src={frame.kind === 'image' ? frame.uri : frame.poster} alt="" fill preferProxy sizes="240px" className="object-contain" />
      </div>
    )
  }
  return (
    <video
      ref={ref}
      data-frame={name}
      src={urls[at]}
      poster={proxyUrl(frame.poster)}
      muted
      playsInline
      loop={loop}
      preload="auto"
      onEnded={onEnd}
      onError={() => (at + 1 < urls.length ? setAt(at + 1) : giveUp())}
      className={`absolute inset-0 w-full h-full object-contain ${hidden}`}
    />
  )
}

/** The platform's capsule: two halves and a seam, in the site's own colours,
 *  so a themed accent carries through. */
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
