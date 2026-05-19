import type { Moment } from './inprocess'
import { getProfileBatch } from './profile'
import { getCollectionMetaBatch } from './kv'

/**
 * Stitch Kismet KV creator + collection chip metadata into a moment list
 * so MomentCard can skip the per-card /api/profile and /api/collections
 * fetches it would otherwise fire on mount. Two Redis MGETs total — local
 * KV only, no inprocess or Farcaster fan-out, so the cost stays under
 * ~10ms (see the abandoned saleConfig fan-out at app/api/timeline/route.ts
 * for why that ceiling matters). Creators with no KV record fall through
 * to MomentCard's client-side resolver, where the FC pfp + ENS chain
 * still runs.
 */
export async function enrichMomentsWithKismetMeta<T extends Moment>(
  moments: T[],
): Promise<T[]> {
  if (moments.length === 0) return moments

  const creatorAddrs: string[] = []
  const collectionAddrs: string[] = []
  for (const m of moments) {
    if (m.creator?.address) creatorAddrs.push(m.creator.address)
    if (m.address) collectionAddrs.push(m.address)
  }

  const [profiles, collectionMetas] = await Promise.all([
    getProfileBatch(creatorAddrs),
    getCollectionMetaBatch(collectionAddrs),
  ])

  return moments.map((m) => {
    const profile = profiles.get(m.creator?.address?.toLowerCase() ?? '')
    const collMeta = collectionMetas.get(m.address?.toLowerCase() ?? '')
    const overlay = profile && (profile.username || profile.avatarUrl)

    // Preserve identity when nothing overlays — keeps React.memo on
    // MomentCard from busting equality on enrichment passthroughs.
    if (!overlay && !collMeta) return m

    return {
      ...m,
      creator: overlay
        ? {
            ...m.creator,
            username: profile.username ?? m.creator.username,
            avatarUrl: profile.avatarUrl ?? m.creator.avatarUrl,
          }
        : m.creator,
      ...(collMeta && {
        kismetCollection: {
          name: collMeta.name ?? null,
          image: collMeta.image ?? null,
        },
      }),
    }
  })
}
