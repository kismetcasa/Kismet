/**
 * Why a curator turned a machine down, or took a live one off the shelves —
 * told to its creator with the decision. Without it a creator read only "not
 * approved", with nothing to fix and no way to tell a rights problem from a
 * blurry cover.
 *
 * A preset reason names the ground, so the same problem always gets the same
 * words; the note says what, specifically. That is the shape a statement of
 * reasons takes wherever one is required or done well — the EU Digital
 * Services Act (Art. 17: the ground relied on, the facts, how to seek redress)
 * and Apple's App Review (the guideline broken, the details, then reply or
 * resubmit). Shared by the review queue and the admin route.
 */

export const DECLINE_REASONS = {
  rights: { label: 'not theirs to offer', text: 'it includes work that isn’t yours to offer' },
  content: { label: 'not allowed', text: 'it includes something Kismet doesn’t allow' },
  lineup: { label: 'lineup or odds', text: 'its lineup or odds need work' },
  art: { label: 'cover or frames', text: 'its cover or frames need work' },
  test: { label: 'a test', text: 'it looks like a test' },
  other: { label: 'other', text: '' },
} as const

export type DeclineReason = keyof typeof DECLINE_REASONS

export const DECLINE_NOTE_MAX = 280

/** A reason the queue sent, checked: a preset, and a note — required when the
 *  preset is "other", which says nothing by itself. */
export function parseDecline(input: { reason?: unknown; note?: unknown }): { reason: DeclineReason; note: string } | { error: string } {
  const reason = input.reason
  if (typeof reason !== 'string' || !Object.prototype.hasOwnProperty.call(DECLINE_REASONS, reason)) return { error: 'Say why: pick a reason' }
  const note = typeof input.note === 'string' ? input.note.replace(/\s+/g, ' ').trim() : ''
  if (note.length > DECLINE_NOTE_MAX) return { error: `Keep the note to ${DECLINE_NOTE_MAX} characters` }
  if (reason === 'other' && !note) return { error: 'Say why in the note' }
  return { reason: reason as DeclineReason, note }
}

/** The reason as its creator reads it: the ground, then the specifics. */
export function declineText({ reason, note }: { reason: DeclineReason; note: string }): string {
  const ground = DECLINE_REASONS[reason].text
  return ground && note ? `${ground} — ${note}` : ground || note
}
