import { NextResponse } from 'next/server'
import { createPublicClient, http, type Address } from 'viem'
import { base } from 'viem/chains'
import { redis, FEATURED_COLLECTIONS_KEY } from '@/lib/redis'
import { INPROCESS_API, type Moment } from '@/lib/inprocess'
import { fetchEthEligibleTokens } from '@/lib/saleConfig'

// Cache for 30s — sale-config eligibility depends on (now), and inner
// inprocess fetches already cache 60s, so this only batches reads across
// repeat visitors within the window.
export const revalidate = 30

const COLLECTION_PREVIEW_LIMIT = 20 // tokens fetched per featured collection
const ROW_DISPLAY_LIMIT = 8 // moments shown in horizontal scroll

interface HydratedFeaturedCollection {
  contractAddress: string
  name?: string
  metadata?: { name?: string; image?: string; description?: string }
  default_admin?: { address?: string; username?: string }
  moments: Moment[]
  ethEligibleTokenIds: string[]
  ethEligibleTotalWei: string
  featuredAt: number
}

export async function GET() {
  const raw = (await redis.zrange(FEATURED_COLLECTIONS_KEY, 0, -1, {
    rev: true,
    withScores: true,
  })) as (string | number)[]

  const refs: { address: string; featuredAt: number }[] = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    refs.push({ address: String(raw[i]), featuredAt: Number(raw[i + 1]) })
  }

  if (refs.length === 0) {
    return NextResponse.json({ collections: [] })
  }

  const client = createPublicClient({ chain: base, transport: http() })

  const collections = await Promise.all(
    refs.map(async (ref): Promise<HydratedFeaturedCollection | null> => {
      try {
        const [collRes, tlRes] = await Promise.all([
          fetch(`${INPROCESS_API}/collection/${ref.address}`, {
            headers: { Accept: 'application/json' },
            next: { revalidate: 60 },
          }),
          fetch(
            `${INPROCESS_API}/timeline?collection=${ref.address}&limit=${COLLECTION_PREVIEW_LIMIT}&chain_id=8453`,
            {
              headers: { Accept: 'application/json' },
              next: { revalidate: 60 },
            },
          ),
        ])

        const collection = collRes.ok ? await collRes.json() : {}
        const tlData = tlRes.ok ? await tlRes.json() : { moments: [] }
        const previewMoments: Moment[] = Array.isArray(tlData.moments) ? tlData.moments : []

        // Filter to ETH-eligible tokens. No `account` here — the per-user
        // "skip already-owned" pass runs client-side at click time.
        const tokenIds = previewMoments.map((m) => BigInt(m.token_id))
        const eligible =
          tokenIds.length > 0
            ? await fetchEthEligibleTokens(client, ref.address as Address, tokenIds)
            : []
        const ethEligibleTotalWei = eligible
          .reduce((sum, e) => sum + e.pricePerToken, 0n)
          .toString()

        return {
          contractAddress: ref.address,
          name: collection.name,
          metadata: collection.metadata,
          default_admin: collection.default_admin,
          moments: previewMoments.slice(0, ROW_DISPLAY_LIMIT),
          ethEligibleTokenIds: eligible.map((e) => e.tokenId.toString()),
          ethEligibleTotalWei,
          featuredAt: ref.featuredAt,
        }
      } catch {
        return null
      }
    }),
  )

  return NextResponse.json({
    collections: collections.filter(Boolean) as HydratedFeaturedCollection[],
  })
}
