import { NextResponse } from 'next/server'
import { getAddress, type Address } from 'viem'
import { isValidTokenId } from '@/lib/address'
import { redis, FEATURED_COLLECTIONS_KEY } from '@/lib/redis'
import { serverBaseClient } from '@/lib/rpc'
import { INPROCESS_API, type Moment } from '@/lib/inprocess'
import { fetchEligibleTokens } from '@/lib/saleConfig'
import { getHiddenCollectionsSet } from '@/lib/hiddenCollections'
import { getHiddenMomentsSet } from '@/lib/hiddenMoments'
import { getCollectionMeta } from '@/lib/kv'

// Cache for 30s — sale-config eligibility depends on (now), and inner
// inprocess fetches already cache 60s, so this only batches reads across
// repeat visitors within the window.
export const revalidate = 30

const COLLECTION_PREVIEW_LIMIT = 20 // tokens fetched per featured collection
const ROW_DISPLAY_LIMIT = 20 // moments shown inside the featured collection row
// Cap on featured collections hydrated per request. Bounds per-call cost
// (inprocess fetches + RPC multicalls + total server-time) so latency
// stays predictable as the curated set grows. zrange is featuredAt-desc,
// so entries beyond the cap are silently dropped oldest-first. If the
// featured set ever needs to grow past this, the correct architectural
// move is background pre-warming (a cron writes hydrated rows to KV; this
// endpoint reads from KV), not lifting the cap — the cost model here is
// linear-in-N and the request budget is bounded.
const MAX_HYDRATED_COLLECTIONS = 20

interface HydratedFeaturedCollection {
  contractAddress: string
  name?: string
  metadata?: { name?: string; image?: string; description?: string }
  default_admin?: { address?: string; username?: string }
  moments: Moment[]
  ethEligibleTokenIds: string[]
  ethEligibleTotalWei: string
  usdcEligibleTokenIds: string[]
  usdcEligibleTotalUsdc: string
  featuredAt: number
}

export async function GET() {
  const [raw, hiddenCollections, hiddenMoments] = await Promise.all([
    // Cap at the source so the Redis result + downstream Promise.all fanout
    // are bounded. Hidden-collection filtering can shrink the working set
    // below this; the dropped tail is just newest-N minus those hidden.
    redis.zrange(FEATURED_COLLECTIONS_KEY, 0, MAX_HYDRATED_COLLECTIONS - 1, {
      rev: true,
      withScores: true,
    }) as Promise<(string | number)[]>,
    getHiddenCollectionsSet(),
    getHiddenMomentsSet(),
  ])

  const refs: { address: string; featuredAt: number }[] = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const addr = String(raw[i])
    // Skip collections the creator has hidden — admin curation defers
    // to the creator's choice.
    if (hiddenCollections.has(addr.toLowerCase())) continue
    refs.push({ address: addr, featuredAt: Number(raw[i + 1]) })
  }

  if (refs.length === 0) {
    return NextResponse.json({ collections: [] })
  }

  const client = serverBaseClient()

  const collections = await Promise.all(
    refs.map(async (ref): Promise<HydratedFeaturedCollection | null> => {
      // Trust-boundary validation: refuse a featured entry whose address
      // isn't a well-formed hex address. We normalize to lowercase rather
      // than checksum because the rest of this codebase keys by lowercase
      // (Redis members, hidden-set membership, downstream comparisons), so
      // returning mixed-case here would silently break case-sensitive
      // equality checks in consumers.
      let address: Address
      try {
        address = getAddress(ref.address).toLowerCase() as Address
      } catch {
        console.error('[featured/collections-hydrated] malformed address in KV', ref.address)
        return null
      }
      try {
        const [collRes, tlRes] = await Promise.all([
          fetch(`${INPROCESS_API}/collection/${address}`, {
            headers: { Accept: 'application/json' },
            next: { revalidate: 60 },
          }),
          fetch(
            `${INPROCESS_API}/timeline?collection=${address}&limit=${COLLECTION_PREVIEW_LIMIT}&chain_id=8453`,
            {
              headers: { Accept: 'application/json' },
              next: { revalidate: 60 },
            },
          ),
        ])

        const collection = collRes.ok ? await collRes.json() : {}
        // Inprocess hasn't indexed every freshly-deployed collection — when
        // it returns nothing useful, stitch our KV-stored record (written at
        // create time by the mint-proxy) so the row renders the real name +
        // cover image instead of the address fallback.
        if (!collection.name && !collection.metadata?.name && !collection.metadata?.image) {
          const kv = await getCollectionMeta(ref.address)
          if (kv) {
            collection.name = kv.name
            collection.metadata = {
              name: kv.name,
              image: kv.image,
              description: kv.description,
            }
            if (!collection.default_admin && kv.artist) {
              collection.default_admin = { address: kv.artist }
            }
          }
        }
        const tlData = tlRes.ok ? await tlRes.json() : { moments: [] }
        const allPreviewMoments: Moment[] = Array.isArray(tlData.moments) ? tlData.moments : []
        // Strip individually-hidden moments inside the featured collection
        // so they don't appear in the row's preview grid.
        // Sort ascending by created_at so the grid reads chronologically
        // (oldest minted at top-left, newest at bottom-right). Inprocess
        // doesn't guarantee any particular order on its side, and the
        // /timeline wrapper sorts newest-first by default — neither
        // matches what the featured row wants, so we own the sort here.
        const previewMoments: Moment[] = allPreviewMoments
          .filter((m) => !hiddenMoments.has(`${m.address?.toLowerCase()}:${m.token_id}`))
          .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

        // Filter to ETH- and USDC-eligible tokens in parallel. No `account`
        // here — the per-user "skip already-owned" pass runs client-side at
        // click time. Drop non-decimal token IDs first so BigInt() can't
        // throw on a malformed inprocess response.
        const tokenIds = previewMoments
          .map((m) => String(m.token_id))
          .filter(isValidTokenId)
          .map(BigInt)
        const [ethEligible, usdcEligible] = tokenIds.length > 0
          ? await Promise.all([
              fetchEligibleTokens(client, address, tokenIds, 'eth'),
              fetchEligibleTokens(client, address, tokenIds, 'usdc'),
            ])
          : [[], []]
        const ethEligibleTotalWei = ethEligible
          .reduce((sum, e) => sum + e.pricePerToken, 0n)
          .toString()
        const usdcEligibleTotalUsdc = usdcEligible
          .reduce((sum, e) => sum + e.pricePerToken, 0n)
          .toString()

        return {
          contractAddress: address,
          name: collection.name,
          metadata: collection.metadata,
          default_admin: collection.default_admin,
          moments: previewMoments.slice(0, ROW_DISPLAY_LIMIT),
          ethEligibleTokenIds: ethEligible.map((e) => e.tokenId.toString()),
          ethEligibleTotalWei,
          usdcEligibleTokenIds: usdcEligible.map((e) => e.tokenId.toString()),
          usdcEligibleTotalUsdc,
          featuredAt: ref.featuredAt,
        }
      } catch (err) {
        // Log with the address so partial-feed failures are diagnosable
        // without crashing the whole hydrator response.
        console.error('[featured/collections-hydrated] failed to hydrate', address, err)
        return null
      }
    }),
  )

  return NextResponse.json({
    collections: collections.filter(Boolean) as HydratedFeaturedCollection[],
  })
}
