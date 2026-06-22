import type { Moment } from './inprocess'
import { getProfileBatch } from './profile'
import { getCollectionMetaBatch } from './kv'

// Stitch Kismet KV creator + collection chip metadata so MomentCard
// can skip the per-card /api/profile + /api/collections fetches. Two
// Redis MGETs total; no external fan-out, so cost stays bounded. FC-
// only creators (no KV record) fall through to the client resolver.
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
          // Lets MomentCard suppress the redundant chip name only for the
          // collection's auto-named cover, not for a distinct same-named
          // mint. Already in hand from the batch read — no extra I/O.
          coverTokenId: collMeta.coverTokenId ?? null,
        },
      }),
    }
  })
}
