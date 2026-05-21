import { NextResponse } from 'next/server'
import { getAddress, type Address } from 'viem'
import { isValidTokenId } from '@/lib/address'
import { canonicalMediaId } from '@/lib/media/canonicalMediaId'
import { redis, FEATURED_COLLECTIONS_KEY } from '@/lib/redis'
import { serverBaseClient } from '@/lib/rpc'
import { INPROCESS_API, type Moment } from '@/lib/inprocess'
import { fetchEligibleTokens } from '@/lib/saleConfig'
import { getHiddenCollectionsSet } from '@/lib/hiddenCollections'
import { getHiddenMomentsSet } from '@/lib/hiddenMoments'
import { getCollectionMeta } from '@/lib/kv'
import { enrichMomentsWithKismetMeta } from '@/lib/momentEnrichment'

// Cache for 30s — sale-config eligibility depends on (now), and inner
// inprocess fetches already cache 60s, so this only batches reads across
// repeat visitors within the window.
export const revalidate = 30

const COLLECTION_PREVIEW_LIMIT = 20 // tokens fetched per featured collection
// Sized to the 4×2 desktop grid in CollectionRow — keep in sync.
const ROW_DISPLAY_LIMIT = 8
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
  // kismet_thumbhash flows through so the CollectionRow client can
  // dedupe cover-vs-first-mint by image content, not just URL.
  metadata?: { name?: string; image?: string; description?: string; kismet_thumbhash?: string }
  // Token ID minted as the collection cover at deploy time, when the
  // Kismet create-form flow had mint-cover enabled. CollectionRow
  // filters this token out of the mint-card grid so the cover doesn't
  // appear twice in the featured row. Resolved per-collection in two
  // ways: explicit (from CollectionMeta KV for newly-registered
  // collections) or inferred (create-form deploy + token-1-marked-as-
  // created-mint, for collections registered before coverTokenId was
  // persisted). The collection page itself never filters this — only
  // the featured row.
  coverTokenId?: string
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
        // KV lookup runs in parallel with inprocess — needed for (a) the
        // metadata fallback below when inprocess hasn't indexed yet, and
        // (b) coverTokenId resolution further down. Memoized + cached
        // upstream so this is cheap.
        const [collRes, tlRes, kvMeta] = await Promise.all([
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
          getCollectionMeta(ref.address),
        ])

        const collection = collRes.ok ? await collRes.json() : {}
        // Inprocess hasn't indexed every freshly-deployed collection — when
        // it returns nothing useful, stitch our KV-stored record (written at
        // create time by the mint-proxy) so the row renders the real name +
        // cover image instead of the address fallback.
        if (!collection.name && !collection.metadata?.name && !collection.metadata?.image) {
          if (kvMeta) {
            collection.name = kvMeta.name
            collection.metadata = {
              name: kvMeta.name,
              image: kvMeta.image,
              description: kvMeta.description,
              // Pass through so the client can dedupe cover-vs-first-mint
              // by perceptual hash — see CollectionRow.tsx for the rationale.
              ...(kvMeta.kismet_thumbhash ? { kismet_thumbhash: kvMeta.kismet_thumbhash } : {}),
            }
            if (!collection.default_admin && kvMeta.artist) {
              collection.default_admin = { address: kvMeta.artist }
            }
          }
        }

        // coverTokenId from KV ONLY — explicitly persisted at deploy time
        // by /api/collections when the user toggled "mint cover" on. We
        // deliberately do NOT infer from the created-mints set: that set
        // is also populated by every regular MintForm mint via mint-proxy,
        // so "token-1 is in created-mints" can't distinguish a cover-mint
        // from a creator who just happened to mint token #1 normally
        // post-deploy. False-positive there would wrongly hide a regular
        // mint from the featured row. For collections registered before
        // coverTokenId was persisted (e.g. the Kismet Casa Rome 2026
        // case), the URI + thumbhash signals in CollectionRow are the
        // fallback — and they fire deterministically when the cover-mint
        // setupAction reused contractURI as the cover token's tokenURI
        // (CreateCollectionForm.tsx:562), which produces byte-identical
        // metadata JSONs on the two sides of the comparison.
        const coverTokenId: string | undefined = kvMeta?.coverTokenId
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
        // throw on a malformed inprocess response. Eligibility runs against
        // EVERY preview moment (not the visible-only set below) so the
        // cover-mint is still counted in "collect all" totals.
        const tokenIds = previewMoments
          .map((m) => String(m.token_id))
          .filter(isValidTokenId)
          .map(BigInt)
        // Filter the cover-mint OUT of the display list (but not the
        // eligibility list above), so the slice that follows lands on
        // ROW_DISPLAY_LIMIT visible moments. Without this, the cover would
        // consume one of the 8 slice slots and a real mint at the tail
        // (e.g. token #9 of a 9-token collection) would be invisibly
        // dropped. Three OR'd signals — same as the historical client-side
        // logic, just hoisted up so the slice math works.
        const coverMediaId = canonicalMediaId(collection.metadata?.image)
        const coverThumbhash = collection.metadata?.kismet_thumbhash?.trim() || undefined
        const visibleMoments = previewMoments.filter((m) => {
          if (coverTokenId && String(m.token_id) === coverTokenId) return false
          if (coverMediaId && canonicalMediaId(m.metadata?.image) === coverMediaId) return false
          const mt = m.metadata?.kismet_thumbhash?.trim()
          if (coverThumbhash && mt && mt === coverThumbhash) return false
          return true
        })
        // Overlap the Redis MGETs in enrichMomentsWithKismetMeta with
        // the two RPC eligibility calls — they share no state.
        const [ethEligible, usdcEligible, displayMoments] = await Promise.all([
          tokenIds.length > 0 ? fetchEligibleTokens(client, address, tokenIds, 'eth') : [],
          tokenIds.length > 0 ? fetchEligibleTokens(client, address, tokenIds, 'usdc') : [],
          enrichMomentsWithKismetMeta(visibleMoments.slice(0, ROW_DISPLAY_LIMIT)),
        ])
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
          coverTokenId,
          default_admin: collection.default_admin,
          moments: displayMoments,
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
