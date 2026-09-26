import 'server-only'
import type { Address } from 'viem'
import { getBlock, multicall } from 'viem/actions'
import { serverBaseClient } from '../rpc'
import { ERC20_MINTER_SALE_ABI, FPSS_SALE_ABI } from '../saleConfig'
import {
  USDC_BASE,
  ZORA_1155_TOKEN_INFO_ABI,
  ZORA_ERC20_MINTER,
  ZORA_FIXED_PRICE_STRATEGY,
  isOpenEdition,
} from '../zoraMint'
import { entryKey } from './draw'
import { isDeliverableEntry } from './eligibility'
import { optedOutPieces } from './store'
import type { LineupPiece, PoolEntry } from './types'

/**
 * What a reveal machine can show right now.
 *
 * A reveal machine hands out nothing itself. A pull reveals one piece and the
 * player collects it through that piece's own sale, at its own price, paying
 * its own split. So "in the machine" means exactly "collectable right now": a
 * piece drops out the moment its sale ends or its edition sells out, and joins
 * again by itself if its artist reopens it. Nobody toggles anything.
 *
 * The published odds are 1 in N over the pieces this returns as on sale, and a
 * pull picks uniformly from the same list, so the two cannot disagree.
 */


type SaleRow = { saleStart: bigint; saleEnd: bigint; pricePerToken: bigint; currency?: Address }

/**
 * Every piece's standing, in lineup order, from one chain round trip: each
 * piece's ETH sale, USDC sale and edition size in a single multicall, judged
 * against the chain's own clock. Every failure excludes the piece — a pull
 * must never reveal something the player cannot then collect.
 */
export async function readLineup(entries: PoolEntry[], passCollection: string | null): Promise<LineupPiece[]> {
  if (entries.length === 0) return []
  const client = serverBaseClient()

  const [optedOut, deliverable, chainNow, reads] = await Promise.all([
    optedOutPieces(entries).catch(() => null),
    Promise.all(entries.map((e) => isDeliverableEntry(e, passCollection))),
    getBlock(client, { blockTag: 'latest' })
      .then((b) => b.timestamp)
      .catch(() => BigInt(Math.floor(Date.now() / 1000))),
    multicall(client, {
      contracts: entries.flatMap((e) => {
        const collection = e.collection as Address
        const tokenId = BigInt(e.tokenId)
        return [
          { address: ZORA_FIXED_PRICE_STRATEGY, abi: FPSS_SALE_ABI, functionName: 'sale' as const, args: [collection, tokenId] as const },
          { address: ZORA_ERC20_MINTER, abi: ERC20_MINTER_SALE_ABI, functionName: 'sale' as const, args: [collection, tokenId] as const },
          { address: collection, abi: ZORA_1155_TOKEN_INFO_ABI, functionName: 'getTokenInfo' as const, args: [tokenId] as const },
        ]
      }),
      allowFailure: true,
    }).catch(() => null),
  ])

  return entries.map((e, i): LineupPiece => {
    const base = { key: entryKey(e), collection: e.collection, tokenId: e.tokenId, artist: e.artist }
    if (optedOut === null) return { ...base, status: 'unreadable' }
    if (optedOut.has(base.key) || !deliverable[i]) return { ...base, status: 'unavailable' }
    if (!reads) return { ...base, status: 'unreadable' }

    const [eth, usdc, info] = reads.slice(3 * i, 3 * i + 3)
    // The ETH row first, as the collect path resolves it (resolveOnchainSale).
    // A row with saleEnd 0 is unset, not free.
    const ethRow = eth.status === 'success' ? (eth.result as SaleRow) : null
    const usdcRow = usdc.status === 'success' ? (usdc.result as SaleRow) : null
    let sale: { row: SaleRow; currency: 'eth' | 'usdc' } | null = null
    if (ethRow && ethRow.saleEnd !== 0n) sale = { row: ethRow, currency: 'eth' }
    else if (usdcRow && usdcRow.saleEnd !== 0n && usdcRow.currency?.toLowerCase() === USDC_BASE.toLowerCase()) {
      sale = { row: usdcRow, currency: 'usdc' }
    } else if (!ethRow) return { ...base, status: 'unreadable' }
    if (!sale || sale.row.saleStart > chainNow || sale.row.saleEnd <= chainNow) {
      return { ...base, status: 'not-on-sale' }
    }

    // An unreadable edition size is left to the mint, as the collect-all path
    // does: the sale is open, and a sold-out mint reverts before it charges.
    if (info.status === 'success') {
      const { maxSupply, totalMinted } = info.result as { maxSupply: bigint; totalMinted: bigint }
      if (!isOpenEdition(maxSupply) && totalMinted >= maxSupply) return { ...base, status: 'sold-out' }
    }

    return {
      ...base,
      status: 'on-sale',
      sale: {
        pricePerToken: sale.row.pricePerToken.toString(),
        currency: sale.currency,
        saleEnd: Number(sale.row.saleEnd),
      },
    }
  })
}
