import 'server-only'
import { inprocessUrl, resolveUri } from '../inprocess'

/**
 * Artwork titles and cover images for the machine surfaces.
 *
 * ── Why this exists ──
 *
 * An odds table that reads `#4172 by 0x8a3f…c091` is a disclosure a person
 * cannot actually use. The published odds are the one thing a player is
 * supposed to weigh BEFORE paying, and weighing them requires knowing what the
 * artworks are. The same applies to the reveal: a win that resolves to a text
 * link is an anticlimax on the exact beat the whole surface is built around.
 *
 * ── Why it is a separate module and not a route ──
 *
 * These are server-side reads that ride Next's fetch cache (`revalidate: 60`),
 * the same warm cache /api/moment and /api/moments share — so a machine page
 * with twelve prizes costs at most twelve cold reads once a minute, and
 * usually zero. Putting it in the payload the client already fetches beats a
 * second client round trip per row.
 *
 * ── Failure is always soft ──
 *
 * A missing title must never block the odds table, because a machine whose
 * metadata host is down still has to be able to disclose its odds and take a
 * play. Every failure resolves to `null` and the caller falls back to the
 * token id, which is what the surface rendered before this existed.
 */

export interface ArtworkMeta {
  name: string | null
  image: string | null
}

/** Per-request upstream bound. This sits inside a page render, and the fan-out
 *  resolves only when its slowest leg does, so one stalled metadata host must
 *  not hold the whole odds table. Matches /api/moments' own 2.5s ceiling. */
const UPSTREAM_TIMEOUT_MS = 2500

/** Ceiling on one hydration fan-out. MAX_POOL_ENTRIES is 200, which would be an
 *  unreasonable burst against a third party for a single page view; the machine
 *  page renders the whole table, so rows past this simply fall back to their
 *  token id rather than making us hammer upstream. */
const MAX_HYDRATE = 60

export async function fetchArtworkMeta(
  collection: string,
  tokenId: string,
): Promise<ArtworkMeta | null> {
  try {
    const res = await fetch(
      inprocessUrl('/moment', { collectionAddress: collection, tokenId, chainId: '8453' }),
      {
        headers: { Accept: 'application/json' },
        next: { revalidate: 60 },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    )
    if (!res.ok) return null
    const data = (await res.json()) as { metadata?: { name?: string; image?: string } }
    const name = data.metadata?.name?.trim()
    const image = data.metadata?.image
    return {
      name: name ? name.slice(0, 120) : null,
      image: image ? resolveUri(image) : null,
    }
  } catch {
    return null
  }
}

/**
 * Hydrate a set of entries at once, keyed by `collection:tokenId`.
 *
 * Deliberately `Promise.all` over per-entry `fetchArtworkMeta` rather than one
 * batch endpoint: inprocess has no batch metadata route, each leg carries its
 * own timeout so a single slow token cannot pin the rest, and every leg is
 * independently cached — so the second viewer of a machine pays for none of them.
 */
export async function hydrateArtworkMeta(
  entries: { collection: string; tokenId: string }[],
): Promise<Record<string, ArtworkMeta>> {
  const seen = new Set<string>()
  const unique: { collection: string; tokenId: string; key: string }[] = []
  for (const e of entries) {
    const key = `${e.collection.toLowerCase()}:${e.tokenId}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ ...e, key })
    if (unique.length >= MAX_HYDRATE) break
  }

  const out: Record<string, ArtworkMeta> = {}
  await Promise.all(
    unique.map(async ({ collection, tokenId, key }) => {
      const meta = await fetchArtworkMeta(collection, tokenId)
      if (meta && (meta.name || meta.image)) out[key] = meta
    }),
  )
  return out
}
