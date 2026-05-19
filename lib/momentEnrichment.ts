import type { Moment } from './inprocess'
import { getProfileBatch } from './profile'
import { getCollectionMetaBatch } from './kv'

/**
 * Stitch Kismet KV metadata (creator avatar, collection chip) into a list
 * of moments before returning them to the client. Eliminates two N+1
 * client round trips that MomentCard would otherwise fire on mount:
 * `/api/profile/[address]` per unique creator and
 * `/api/collections?address=…` per unique collection.
 *
 * Cost model: two Redis MGETs total, regardless of N. Same constraint as
 * the saleConfig stitching (see app/api/timeline/route.ts) — we only pull
 * from local KV, never inprocess or Farcaster, so cold-cache server time
 * stays under ~10ms and never stacks onto TTFB the way the abandoned
 * per-moment saleConfig fan-out did.
 *
 * Coverage:
 *   - Creators with a Kismet profile: pre-stitched (username via the
 *     existing field, avatarUrl via the new MomentAdmin.avatarUrl).
 *   - Creators without a Kismet profile (FC-only or fully anonymous):
 *     untouched — MomentCard's fetchCreatorProfile fallback fires and
 *     resolves the FC pfp / ENS on the client.
 *   - Collections with KV meta (curator-blessed): pre-stitched with
 *     {name, image}.
 *   - Auto-deploy wrappers / non-platform contracts: no chip stitched
 *     (no KV record); MomentCard's fetchCollectionChip fallback runs
 *     and resolves null, suppressing the chip.
 */
export async function enrichMomentsWithKismetMeta<T extends Moment>(
  moments: T[],
): Promise<T[]> {
  if (moments.length === 0) return moments

  const creatorAddrs: string[] = []
  const collectionAddrs: string[] = []
  for (const m of moments) {
    const c = m.creator?.address
    if (c) creatorAddrs.push(c)
    if (m.address) collectionAddrs.push(m.address)
  }

  const [profiles, collectionMetas] = await Promise.all([
    getProfileBatch(creatorAddrs),
    getCollectionMetaBatch(collectionAddrs),
  ])

  return moments.map((m) => {
    const creatorKey = m.creator?.address?.toLowerCase()
    const collectionKey = m.address?.toLowerCase()
    const profile = creatorKey ? profiles.get(creatorKey) : undefined
    const collMeta = collectionKey ? collectionMetas.get(collectionKey) : undefined

    // Only build a new creator object when there's actually something to
    // overlay — avoids churning per-moment object identity for moments
    // whose creator isn't in the KV (the common FC-only case). Username
    // from Kismet wins over inprocess's because Kismet is the user's
    // chosen on-platform identity; same precedence as MomentDetailView's
    // existing username resolution chain.
    const enrichedCreator =
      profile && (profile.username || profile.avatarUrl)
        ? {
            ...m.creator,
            username: profile.username ?? m.creator.username,
            avatarUrl: profile.avatarUrl ?? m.creator.avatarUrl,
          }
        : m.creator

    // Always set kismetCollection when we have ANY KV record for the
    // address — even a record with no name/image is information (it
    // confirms the contract is known to Kismet, which the chip uses
    // to decide visibility downstream). When there's no KV record at
    // all, leave the field undefined so the client knows enrichment
    // wasn't attempted vs. attempted-and-empty.
    return {
      ...m,
      creator: enrichedCreator,
      ...(collMeta && {
        kismetCollection: {
          name: collMeta.name ?? null,
          image: collMeta.image ?? null,
        },
      }),
    }
  })
}
