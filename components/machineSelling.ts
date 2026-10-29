import { formatSaleWindowLabel } from '@/lib/inprocess'
import type { Selling } from '@/lib/experience/selling'

/**
 * How a card shows whether its machine sells a play, from the verdict its own
 * page acts on (lib/experience/selling), so the play list and a creator's
 * profile say the same thing as the button they lead to.
 */
export interface CardSelling {
  /** The card's status label. */
  label: 'live' | 'soon' | 'unavailable' | 'sold out' | 'closed' | 'in review'
  /** It sells a play now: the play or pull button and the price line. */
  open: boolean
  /** A quieter cover: it can no longer be had. */
  quiet: boolean
  /** Why it is not selling, in a few words; null while it is. */
  why: string | null
}

/** "opens Oct 30" or "ended Oct 20": the sale's date in the page's words. */
function saleDate(state: 'scheduled' | 'ended', at: number | undefined): string | null {
  if (at === undefined) return null
  const label = formatSaleWindowLabel({ state, atSec: at }, { withTime: false })
  return label ? label.charAt(0).toLowerCase() + label.slice(1) : null
}

export function cardSelling(selling: Selling, kind: 'capsule' | 'reveal'): CardSelling {
  if (selling.open) return { label: 'live', open: true, quiet: false, why: null }
  const not = (label: CardSelling['label'], quiet: boolean, why: string): CardSelling => ({ label, open: false, quiet, why })
  switch (selling.reason) {
    case 'season closed':
      return not('closed', true, kind === 'capsule' ? 'capsule · season over' : 'reveal machine')
    case 'sale ended':
      return not('closed', true, saleDate('ended', selling.at) ?? 'sale ended')
    case 'not for sale':
      return not('closed', true, 'not for sale')
    case 'sold out':
      return not('sold out', true, 'every capsule sold')
    case 'nothing left to win':
      return not('sold out', true, 'nothing left to win')
    case 'not open yet':
      return not('soon', false, saleDate('scheduled', selling.at) ?? 'not open yet')
    case 'nothing on sale right now':
      return selling.waiting ? not('soon', false, 'nothing on sale right now') : not('sold out', true, 'nothing on sale right now')
    case 'price unavailable':
      return not('unavailable', false, 'price unavailable just now')
    case 'checking what’s left':
      return not('unavailable', false, 'checking what’s left')
    case 'in review':
      return not('in review', false, 'waiting for a curator')
  }
}

/** The order a visitor reads them in: what they can play now, then what opens
 *  soon, then what can't be read just now, then what can no longer be had. */
export const CARD_ORDER: Record<CardSelling['label'], number> = {
  live: 0,
  soon: 1,
  unavailable: 2,
  'in review': 3,
  'sold out': 4,
  closed: 5,
}
