import type { MachineCover, MachineFrames, StageFrame } from './types'

const AR_URI = /^ar:\/\/[A-Za-z0-9_-]{43}$/
/** A thumbhash is ~25 bytes; base64 of it is well under this. */
const THUMBHASH = /^[A-Za-z0-9+/=_-]{8,120}$/

/** A cover as a request carries it, or null when it is not one: an `ar://`
 *  upload (the only kind the studio makes) and, optionally, its thumbhash. */
export function parseCover(raw: unknown): MachineCover | null {
  if (!raw || typeof raw !== 'object') return null
  const { uri, thumbhash } = raw as { uri?: unknown; thumbhash?: unknown }
  if (typeof uri !== 'string' || !AR_URI.test(uri)) return null
  if (thumbhash !== undefined && (typeof thumbhash !== 'string' || !THUMBHASH.test(thumbhash))) return null
  return { uri, ...(typeof thumbhash === 'string' ? { thumbhash } : {}) }
}

/** The stages each kind of machine has an artist's frame for. */
const FRAME_STAGES = { capsule: ['dispense', 'open'], reveal: ['open'] } as const

/** A machine's frames as a request carries them, or null when they are not
 *  frames this kind of machine can have. `{}` is none — the platform's own. */
export function parseFrames(raw: unknown, kind: 'capsule' | 'reveal'): MachineFrames | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: MachineFrames = {}
  for (const [stage, value] of Object.entries(raw)) {
    if (!(FRAME_STAGES[kind] as readonly string[]).includes(stage)) return null
    const frame = parseFrame(value)
    if (!frame) return null
    out[stage as keyof MachineFrames] = frame
  }
  return out
}

function parseFrame(raw: unknown): StageFrame | null {
  if (!raw || typeof raw !== 'object') return null
  const { uri, kind, poster, thumbhash } = raw as Record<string, unknown>
  if (typeof uri !== 'string' || !AR_URI.test(uri)) return null
  if (kind !== 'video' && kind !== 'image') return null
  if (typeof poster !== 'string' || !AR_URI.test(poster)) return null
  if (thumbhash !== undefined && (typeof thumbhash !== 'string' || !THUMBHASH.test(thumbhash))) return null
  return { uri, kind, poster, ...(typeof thumbhash === 'string' ? { thumbhash } : {}) }
}

/** The frames a player's stage may play: those the server's screening passed
 *  (lib/experience/frameScreen), without its verdict. Null for none. */
export function playerFrames(frames: MachineFrames | undefined): MachineFrames | null {
  const out: MachineFrames = {}
  for (const [stage, frame] of Object.entries(frames ?? {}) as [keyof MachineFrames, StageFrame][]) {
    if (frame.check?.state !== 'passed') continue
    const { check: _check, ...shown } = frame
    out[stage] = shown
  }
  return Object.keys(out).length > 0 ? out : null
}

/** Where a stage frame's screening stands, as its creator is shown it. */
export interface FrameStatus {
  frame: StageFrame
  state: 'checking' | 'passed' | 'refused'
  reason?: string
}

/** Every frame a machine has, played or not, with its screening — for the
 *  creator's editor, which must keep the frames it does not change. */
export function frameStatus(frames: MachineFrames | undefined): Partial<Record<keyof MachineFrames, FrameStatus>> | null {
  const out: Partial<Record<keyof MachineFrames, FrameStatus>> = {}
  for (const [stage, frame] of Object.entries(frames ?? {}) as [keyof MachineFrames, StageFrame][]) {
    const { check, ...shown } = frame
    out[stage] = !check
      ? { frame: shown, state: 'checking' }
      : check.state === 'passed'
        ? { frame: shown, state: 'passed' }
        : { frame: shown, state: 'refused', reason: check.reason }
  }
  return Object.keys(out).length > 0 ? out : null
}

