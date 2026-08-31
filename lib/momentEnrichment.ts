import type { Moment } from './inprocess'
import { getProfileBatch } from './profile'
import { getCollectionMetaBatch, getUserCollections } from './kv'
import { getHiddenIdentityClosure } from './addressUnion'

// Stitch Kismet KV creator + collection chip metadata so MomentCard
// can skip the per-card /api/profile + /api/collections fetches. Two
// Redis MGETs total; no external fan-out, so cost stays bounded. FC-
// only creators (no KV record) fall through to the client resolver.
//
// This is the SINGLE choke point every server feed's creator chip flows
// through (timeline + featured hydrator). The hidden-IDENTITY scrub lives
// here rather than in each caller because a per-route strip is easy to place
// wrong: the timeline once stripped creator.username BEFORE this call, and
// the overlay below silently re-populated it (and added the avatar) from the
// raw profile batch. Gating at the overlay itself means no caller can leak a
// hidden creator's name/avatar by forgetting to strip — present and future.
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

  const [profiles, collectionMetas, curatedAddrs, hiddenIdentities] = await Promise.all([
    getProfileBatch(creatorAddrs),
    getCollectionMetaBatch(collectionAddrs),
    getUserCollections(),
    // Sibling-aware admin-hidden identity set. Memoized (60s), so on the hot
    // feed path this is a cached read.
    //
    // Fail policy — this comment previously claimed the opposite, so state it
    // exactly: this read fails OPEN. getHiddenIdentityClosure builds on
    // fetchHiddenProfilesSet, which catches a Redis error and returns an EMPTY
    // set (lib/hidden-profiles), so during an Upstash blip a hidden creator's
    // username and avatar can be overlaid onto feed cards for up to the memo
    // window. That is deliberate and consistent: hidden-PROFILES is identity
    // hiding, which fails open platform-wide so an outage can't 404 every
    // profile page, whereas hidden-MOMENTS/COLLECTIONS is content hiding and
    // fails closed via strictRead. Two policies, split on that line — not an
    // oversight to "fix" here without changing the platform-wide one.
    // (Nor is this memo shared with the timeline route: this call site is the
    // only one on that path.)
    getHiddenIdentityClosure(),
  ])
  // Curator-blessed set (create-form deploys + the collections minted into).
  // Distinguishes a real collection from an individual mint's auto-deploy
  // wrapper — the chip shows the name only for the former. Memoized SMEMBERS,
  // so this adds no per-card I/O.
  const curatedSet = new Set(curatedAddrs.map((a) => a.toLowerCase()))

  return moments.map((m) => {
    const creatorAddr = m.creator?.address?.toLowerCase() ?? ''
    const hidden = creatorAddr !== '' && hiddenIdentities.has(creatorAddr)
    // Hidden identity: never overlay stored identity, and scrub any name/
    // avatar the upstream row already carried. MomentCard falls back to
    // shortAddress on a falsy username — matching every other profile surface.
    const scrub = hidden && !!m.creator && (m.creator.username != null || m.creator.avatarUrl != null)
    const profile = hidden ? undefined : profiles.get(creatorAddr)
    const collMeta = collectionMetas.get(m.address?.toLowerCase() ?? '')
    const overlay = profile && (profile.username || profile.avatarUrl)

    // Preserve identity when nothing overlays/scrubs — keeps React.memo on
    // MomentCard from busting equality on enrichment passthroughs.
    if (!overlay && !collMeta && !scrub) return m

    return {
      ...m,
      creator: scrub
        ? { ...m.creator, username: undefined, avatarUrl: undefined }
        : overlay
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
          // Real collection vs an individual mint's auto-deploy wrapper —
          // the card shows the name only for the former. Reuses the same
          // blessed set the /api/collections?address chip endpoint trusts.
          isCuratedCollection: curatedSet.has(m.address?.toLowerCase() ?? ''),
        },
      }),
    }
  })
}
