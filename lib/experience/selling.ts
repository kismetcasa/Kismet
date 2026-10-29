import { getSaleWindow, type SaleWindowInfo } from '../inprocess'
import type { MachineState } from './types'

/**
 * Whether a machine sells a play right now, and if not, why: one rule for the
 * machine's own page and for every card that lists it (the play list, a
 * creator's profile), so no card offers a play its page then refuses.
 *
 * A capsule machine sells only while every one of these holds, checked in
 * this order, and the first that fails names the reason in the words the
 * page's button uses: the machine is on the shelves; its capsule's on-chain
 * sale can be read, has a price, has opened and has not ended; it has
 * capsules left to sell; the chain has just confirmed which artworks are
 * left; and at least one of them can be drawn. A play never asks for more
 * capsules than the machine can honour: no more than the artworks left, nor
 * than the capsules left to sell, either of which a larger mint would break.
 *
 * Pure, so the page runs it on what its payload says and the lists run it on
 * the same reads made in bulk (lib/experience/cards machineMarket).
 */

/** Why a machine is not selling, as its button says it. */
export type NotSelling =
  | 'in review'
  | 'season closed'
  | 'price unavailable'
  | 'not for sale'
  | 'not open yet'
  | 'sale ended'
  | 'sold out'
  | 'checking what’s left'
  | 'nothing left to win'
  | 'nothing on sale right now'

export type Selling =
  | {
      open: true
      /** The largest pull it can honour; null for no limit. */
      maxPull: number | null
    }
  | {
      open: false
      reason: NotSelling
      /** When a capsule's sale opens ('not open yet') or ended ('sale ended'),
       *  in unix seconds. */
      at?: number
      /** A reveal machine with nothing on sale: pieces that join when their
       *  sales open. */
      waiting?: number
    }

const lesser = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b))

export function capsuleSelling(input: {
  state: MachineState
  /** The capsule's on-chain sale; null when there is none or it could not be read. */
  sale: { pricePerToken: string; saleStart: number | string; saleEnd: number | string } | null
  /** False when the sale could not be read, which is not the same as no sale
   *  on a page that must disclose a price before it sells. */
  saleReadable: boolean
  /** Capsules left to sell; null for an open edition. */
  capsulesOutstanding: number | null
  /** Whether the chain just confirmed what is left to draw. */
  standingReadable: boolean
  /** Whether anything at all can be drawn. */
  drawable: boolean
  /** Artworks left to give; null for no limit (a floor piece). */
  prizesRemaining: number | null
  nowSec?: number
}): Selling & { window: SaleWindowInfo | null } {
  const window = getSaleWindow(
    input.sale ? { saleStart: String(input.sale.saleStart), saleEnd: String(input.sale.saleEnd) } : null,
    input.nowSec,
  )
  const maxPull = lesser(input.prizesRemaining, input.capsulesOutstanding)
  const closed = (reason: NotSelling, at?: number | null) => ({
    open: false as const,
    reason,
    ...(at != null ? { at } : {}),
    window,
  })
  if (input.state === 'review') return closed('in review')
  if (input.state !== 'live') return closed('season closed')
  if (!input.saleReadable) return closed('price unavailable')
  let priced = false
  try {
    priced = !!input.sale && BigInt(input.sale.pricePerToken || '0') > 0n
  } catch {
    priced = false
  }
  if (!priced) return closed('not for sale')
  if (window?.state === 'scheduled') return closed('not open yet', window.atSec)
  if (window?.state === 'ended') return closed('sale ended', window.atSec)
  if (input.capsulesOutstanding === 0) return closed('sold out')
  if (!input.standingReadable) return closed('checking what’s left')
  if (!input.drawable || (maxPull !== null && maxPull < 1)) return closed('nothing left to win')
  return { open: true, maxPull, window }
}

/** A reveal machine pulls while it is on the shelves and anything in it is on
 *  sale right now: a pull reveals only what the player can then collect. */
export function revealSelling(input: { state: MachineState; onSale: number; waiting: number }): Selling {
  if (input.state === 'review') return { open: false, reason: 'in review' }
  if (input.state !== 'live') return { open: false, reason: 'season closed' }
  if (input.onSale === 0) return { open: false, reason: 'nothing on sale right now', waiting: input.waiting }
  return { open: true, maxPull: null }
}
