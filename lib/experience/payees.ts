import 'server-only'
import { getStoredSplits } from '../splits'

/**
 * Who actually receives a capsule's revenue.
 *
 * ── The defect this exists to close ──
 *
 * A machine's `splitRecipients` used to be taken verbatim from the publish
 * request body. `checkSolvency` then verified that every pool artist appeared
 * in that list and refused the machine otherwise ('artist-not-in-split', whose
 * detail reads "a machine giving away someone's work for free"). But the SAME
 * creator supplied both the pool and the list they were checked against, so the
 * check was circular and therefore vacuous: sending
 * `splitRecipients: [...everyArtistIPooled]` passed unconditionally, no matter
 * who the capsule actually paid. The machine page then told players the machine
 * "pays N recipients" on the strength of that self-certified list.
 *
 * Nothing in the Experience creates a split or sets a fundsRecipient — it never
 * did, and it should not: the capsule is an ordinary token whose payout config
 * was fixed when the creator minted it. So the honest move is not to WRITE the
 * split but to READ it, and hold the pool to what it actually says.
 *
 * ── Where the truth lives ──
 *
 * Kismet records a moment's split recipients at mint time under
 * `kismetart:splits:<collection>:<tokenId>` (lib/splits.setStoredSplits), which
 * is the same record the distribute flow pays out against. That is authoritative
 * for any capsule minted through Kismet, and it names ADDRESSES — unlike the
 * on-chain `fundsRecipient`, which is a SplitWallet whose members cannot be
 * recovered from the address alone.
 *
 * ── Failing closed, deliberately ──
 *
 * Three cases, and only the first two can admit a foreign artist:
 *   - a recorded split with named recipients -> those addresses, exactly;
 *   - no split at all -> the creator keeps 100%, so the creator is the only
 *     payee, and a pool of anyone else's work is correctly refused;
 *   - a split we know exists but whose members were not recorded (the legacy
 *     `'1'` marker) -> UNVERIFIABLE. Refused rather than assumed, because the
 *     alternative is re-asserting the exact unverified claim this module
 *     replaces. The creator can re-publish the capsule's splits to fix it.
 */

export type CapsulePayees =
  | { ok: true; recipients: string[]; source: 'split' | 'creator' }
  | { ok: false; reason: string }

export async function resolveCapsulePayees(params: {
  collection: string
  tokenId: string
  creator: string
}): Promise<CapsulePayees> {
  const creator = params.creator.toLowerCase()

  let stored
  try {
    stored = await getStoredSplits(params.collection, params.tokenId)
  } catch {
    // A Redis blip must not silently downgrade this to "creator keeps
    // everything", which would let a legitimate multi-artist machine publish
    // with an unverified payee set. Refuse; the creator retries.
    return { ok: false, reason: 'could not read the capsule’s payout configuration — try again' }
  }

  if (!stored.hasSplits) {
    return { ok: true, recipients: [creator], source: 'creator' }
  }
  if (stored.recipients.length === 0) {
    return {
      ok: false,
      reason:
        'this capsule has a split, but Kismet has no record of who is in it — re-save the capsule’s splits before using it as a machine',
    }
  }

  const recipients = [...new Set(stored.recipients.map((r) => r.address.toLowerCase()))]
  return { ok: true, recipients, source: 'split' }
}
