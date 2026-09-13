import 'server-only'
import { isBlacklisted } from '../blacklist'
import { isMomentHidden } from '../hiddenMoments'
import type { SnapshotEntry } from './types'

/**
 * The one definition of "this artwork may be dispensed right now".
 *
 * ── Why it is shared ──
 *
 * This filter was written out three times — the play route's freeze, the resume
 * route's freeze, and the public odds payload — and the three had already
 * drifted. The payload applied only two of the three tests, omitting the
 * artist-blacklist one, so the moment any pool artist was blacklisted the
 * published table kept a row that could never be won AND understated every
 * other row's real probability, because the unwinnable weight stayed in the
 * denominator. On a surface whose entire compliance posture is "the odds you
 * are shown are the odds you play", a disclosure that differs from the draw is
 * the defect, not a cosmetic gap.
 *
 * ── Every test fails CLOSED ──
 *
 * A throw or an unreadable value excludes the entry. The worst an exclusion can
 * do is withhold one artwork and cost a redraw; the worst an inclusion can do is
 * dispense something the platform has decided must not be dispensed.
 *
 * The Pass-collection test is the one with teeth: prize delivery is `adminMint`,
 * which emits the same TransferSingle a purchased Pass mint does, and
 * lib/pass-validity credits validity on ANY mint — so a Pass artwork in a pool
 * would turn a machine into a creator-credential vending machine. It is checked
 * here rather than only at publish because the gate's passCollection is a
 * runtime value that can change, and be rotated, after a machine is approved.
 */
export async function isDeliverableEntry(
  e: Pick<SnapshotEntry, 'collection' | 'tokenId' | 'artist'>,
  passCollection: string | null,
): Promise<boolean> {
  if (passCollection && e.collection.toLowerCase() === passCollection) return false
  if (await isMomentHidden(e.collection, e.tokenId).catch(() => true)) return false
  if (await isBlacklisted(e.artist).catch(() => true)) return false
  return true
}

/** The deliverable subset, order preserved — order is load-bearing, since
 *  selection walks cumulative weights in array order. */
export async function filterDeliverable<T extends Pick<SnapshotEntry, 'collection' | 'tokenId' | 'artist'>>(
  entries: T[],
  passCollection: string | null,
): Promise<T[]> {
  const out: T[] = []
  for (const e of entries) {
    if (await isDeliverableEntry(e, passCollection)) out.push(e)
  }
  return out
}
