'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import { MomentImage } from './MomentImage'
import { thumbhashToBlurDataURL } from '@/lib/media/thumbhash'
import type { ProfileTheme } from '@/lib/profileTheme'

// Shared blur treatment for the artwork layers (still + live video/gif) so they
// stay visually aligned — the live media fades in over the still at the same
// blur/scale, so drift here would make the backdrop shift as it loads.
const BLUR_STILL: CSSProperties = { filter: 'blur(40px) saturate(1.2)', transform: 'scale(1.15)' }

// Whether the viewer permits an autoplaying backdrop video/gif. Starts false so
// we never autoplay before confirming (no flash of motion for reduced-motion /
// data-saver users); flips true on mount when allowed and tracks live changes
// to the reduced-motion setting. Per the research: fall back to the static
// still under prefers-reduced-motion or Data Saver — and low-power mode just
// makes autoplay fail, which also surfaces the still (BackdropMedia.onError).
function useAllowsVideo(): boolean {
  const [allow, setAllow] = useState(false)
  useEffect(() => {
    // Gate on `no-preference` (not `!reduce`) so this matches the CSS effects,
    // which animate only inside the no-preference query — the two motion paths
    // then agree on every UA, including ones that report neither value (those
    // conservatively get the static still).
    const mq = window.matchMedia('(prefers-reduced-motion: no-preference)')
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } }
    const compute = () => setAllow(mq.matches && !nav.connection?.saveData)
    compute()
    mq.addEventListener('change', compute)
    return () => mq.removeEventListener('change', compute)
  }, [])
  return allow
}

// The V4 animated layer: a dedicated muted/loop/playsinline element — NOT the
// feed-bound InlineVideo (which registers with the decoder coordinator and, in
// detail mode, unmutes + shows controls). Fades in over the still once it's
// actually playing; on error it renders nothing so the still shows through. The
// parent mounts it only when the owner enabled `live` AND the viewer allows
// motion AND the header is on screen, so unmounting off-screen frees the decoder.
function BackdropMedia({ url, kind }: { url: string; kind: 'video' | 'gif' }) {
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  if (failed) return null
  const media: CSSProperties = { opacity: ready ? 0.55 : 0, transition: 'opacity 0.5s ease' }
  return (
    <div className="absolute inset-0" style={BLUR_STILL}>
      {kind === 'gif' ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          className="w-full h-full object-cover"
          style={media}
          onLoad={() => setReady(true)}
          onError={() => setFailed(true)}
        />
      ) : (
        <video
          src={url}
          autoPlay
          muted
          loop
          playsInline
          className="w-full h-full object-cover"
          style={media}
          // Reveal only once actually PLAYING (not merely loadable): if autoplay
          // is blocked (iOS Low Power Mode), onPlaying never fires, so the layer
          // stays hidden and the still shows instead of a frozen first frame.
          onPlaying={() => setReady(true)}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  )
}

// Ambient, content-derived backdrop behind the profile header. A band — not a
// full-viewport fixed layer — because <main> paints an opaque bg, so the
// backdrop must live inside a stacking context above it; the header is the
// natural, modal-free region to isolate. Stacked layers, cheapest first, all
// decorative + pointer-events-none:
//   1. base palette gradient (instant, paints before the image),
//   2. the moment's artwork — a downscaled+blurred still (V3), or, when the
//      owner opted into `live` and the viewer allows it, the animated video/gif
//      (V4) fading in over that still,
//   3. the seeded palette mesh (the painterly signature),
//   4. an optional bloom glow, then a scrim that fades into the page bg.
//
// Ambient motion (bloom / mesh / hue) is owner-opt-in via theme.motion and runs
// only when the VIEWER allows motion (the keyframes live solely in a
// prefers-reduced-motion: no-preference query) AND the header is on screen
// (paused off-screen below). transform/opacity effects are GPU-cheap; hue is a
// filter, kept slow and off the artwork layer.
export function ProfileThemeBackdrop({ theme, inView }: { theme: ProfileTheme; inView: boolean }) {
  const { palette: p, geometry: g, mediaUrl, thumbhash, motion, mediaType, animationUrl } = theme
  // `inView` comes from the parent's single header observer (shared with the
  // avatar glow). Pauses every ambient animation + frees the live video
  // off-screen. Reduced motion is handled separately (CSS for the effects,
  // useAllowsVideo for the media).
  const playState: CSSProperties['animationPlayState'] = inView ? 'running' : 'paused'
  const allowsVideo = useAllowsVideo()
  const playAnimated = !!motion?.live && mediaType !== 'image' && !!animationUrl && allowsVideo && inView

  const mesh = g.mesh
    .map(
      (m) =>
        `radial-gradient(${m.r}% ${m.r}% at ${m.x}% ${m.y}%, ${p.ringStops[m.stop] ?? p.primary}33, transparent 70%)`,
    )
    .join(', ')

  // Backdrop wash: a seeded radial or linear sweep of the dimmed palette. Older
  // themes (no shape) fall back to linear, matching their prior rendering.
  const baseGradient =
    g.shape === 'radial'
      ? `radial-gradient(120% 120% at ${g.cx ?? 50}% ${g.cy ?? 35}%, ${p.bgFrom}, ${p.bgTo})`
      : `linear-gradient(${g.angle}deg, ${p.bgFrom}, ${p.bgTo})`

  // Static art base. Prefer the gateway-resilient still; when there's none (a
  // poster-less gif), fall back to the thumbhash blur so the artwork still shows
  // when the live media is off/blocked. Cached decode, client-safe.
  const thumbhashStill = mediaUrl ? undefined : thumbhashToBlurDataURL(thumbhash)

  // Optional animation strings, attached per layer only when the owner enabled
  // the effect. A reduced-motion viewer never matches the @media block, so these
  // names resolve to no animation (the layers render static).
  const range = motion?.hueRange ?? 20
  const hueAnim = motion?.hue
    ? range >= 360
      ? 'kf-theme-hue-cycle 48s linear infinite'
      : 'kf-theme-hue 24s ease-in-out infinite alternate'
    : null
  const meshAnim = motion?.mesh ? 'kf-theme-mesh 32s ease-in-out infinite alternate' : null
  const bloomAnim = motion?.bloom ? 'kf-theme-bloom 6s ease-in-out infinite' : null
  // Compose a layer's animations (e.g. mesh drift + hue together) and carry the
  // shared in-view play-state. Returns undefined when the layer has no motion.
  const anim = (...parts: (string | null)[]): CSSProperties | undefined => {
    const joined = parts.filter(Boolean).join(', ')
    return joined ? { animation: joined, animationPlayState: playState } : undefined
  }

  // Seeded drift vector (from the geometry angle) + hue oscillation bounds, set
  // on the root so the keyframes resolve them by inheritance. Drift direction
  // varies per moment, so even the motion differs between similar-palette
  // profiles. Only emitted for the effects that are actually on.
  const angleRad = (g.angle * Math.PI) / 180
  const rootVars: Record<string, string> = {}
  if (meshAnim) {
    rootVars['--mesh-dx'] = `${(Math.cos(angleRad) * 2).toFixed(2)}%`
    rootVars['--mesh-dy'] = `${(Math.sin(angleRad) * 2).toFixed(2)}%`
  }
  if (hueAnim && range < 360) {
    rootVars['--hue-from'] = `${Math.round(-range / 2)}deg`
    rootVars['--hue-to'] = `${Math.round(range / 2)}deg`
  }

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute -inset-x-4 top-0 -z-10 overflow-hidden"
      style={{ height: 'min(42vh, 420px)', ...rootVars } as CSSProperties}
    >
      <div className="absolute inset-0" style={{ background: baseGradient, ...anim(hueAnim) }} />
      {mediaUrl ? (
        <div className="absolute inset-0" style={{ ...BLUR_STILL, opacity: 0.55 }}>
          <MomentImage src={mediaUrl} thumbhash={thumbhash} alt="" fill sizes="640px" className="object-cover" />
        </div>
      ) : thumbhashStill ? (
        <div
          className="absolute inset-0"
          style={{ ...BLUR_STILL, opacity: 0.55, backgroundImage: `url(${thumbhashStill})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
        />
      ) : null}
      {playAnimated && animationUrl && <BackdropMedia url={animationUrl} kind={mediaType === 'gif' ? 'gif' : 'video'} />}
      {mesh && <div className="absolute inset-0" style={{ background: mesh, ...anim(meshAnim, hueAnim) }} />}
      {bloomAnim && (
        <div
          className="absolute inset-0"
          style={{ background: `radial-gradient(60% 60% at 50% 35%, ${p.primary}40, transparent 70%)`, ...anim(bloomAnim, hueAnim) }}
        />
      )}
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(to bottom, rgba(13,13,13,0.30), rgba(13,13,13,0.65) 55%, #0d0d0d 100%)' }}
      />
    </div>
  )
}
