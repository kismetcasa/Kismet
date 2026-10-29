// Verifies the one rule that decides whether a machine sells a play
// (lib/experience/selling), which the machine page acts on and every card that
// lists the machine shows (components/machineSelling): a card must never offer
// a play its page refuses. What this pins down:
//   1. A capsule machine sells only when it is on the shelves, its sale can be
//      read, is priced, has opened and has not ended, it has capsules left,
//      the chain confirmed its table, and something can be drawn — and the
//      FIRST of those that fails is the reason, in the button's words.
//   2. A pull is never larger than what the machine can honour: the artworks
//      left or the capsules left, whichever is fewer.
//   3. A reveal machine pulls only while live with something on sale, and
//      says how many pieces join when their sales open.
//   4. A card's label, quiet cover and line follow the verdict, and the order
//      a visitor reads them in puts what can be played first.
//
// Run: node --experimental-strip-types --import ./scripts/register-ts-alias.mjs scripts/verify-selling.ts

import { capsuleSelling, revealSelling } from '../lib/experience/selling.ts'
import { CARD_ORDER, cardSelling } from '../components/machineSelling.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const NOW = 1_800_000_000
const OPEN = '18446744073709551615'
type Sale = { pricePerToken: string; saleStart: number | string; saleEnd: number | string }
const SALE: Sale = { pricePerToken: '1000000000000000', saleStart: 0, saleEnd: OPEN }
const selling = {
  state: 'live' as const,
  sale: SALE as Sale | null,
  saleReadable: true,
  capsulesOutstanding: 20 as number | null,
  standingReadable: true,
  drawable: true,
  prizesRemaining: 7 as number | null,
  nowSec: NOW,
}
const verdict = (over: Partial<typeof selling>) => {
  const v = capsuleSelling({ ...selling, ...over })
  return v.open ? `open:${v.maxPull}` : `${v.reason}${'at' in v && v.at !== undefined ? `@${v.at}` : ''}`
}

// ── 1. each gate, and its words ─────────────────────────────────────────────
check('a live machine with an open, priced sale and artworks left sells', verdict({}) === 'open:7', verdict({}))
check('one waiting for a curator is a preview', verdict({ state: 'review' as never }) === 'in review')
check('ended, delisted and draft are closed seasons',
  ['ended', 'delisted', 'draft'].every((state) => verdict({ state: state as never }) === 'season closed'))
check('an unreadable sale is not an open one', verdict({ saleReadable: false }) === 'price unavailable')
check('a sale with no price is not for sale', verdict({ sale: { ...SALE, pricePerToken: '0' } }) === 'not for sale')
check('no sale row, readable, is not for sale', verdict({ sale: null as never }) === 'not for sale')
check('a sale that opens later says when',
  verdict({ sale: { ...SALE, saleStart: NOW + 3600 } }) === `not open yet@${NOW + 3600}`, verdict({ sale: { ...SALE, saleStart: NOW + 3600 } }))
check('a sale whose end has passed has ended, and says when',
  verdict({ sale: { ...SALE, saleEnd: NOW - 60 } }) === `sale ended@${NOW - 60}`)
check('a sale ending later still sells', verdict({ sale: { ...SALE, saleEnd: NOW + 60 } }) === 'open:7')
check('a "0" end is no end at all', verdict({ sale: { ...SALE, saleEnd: '0' } }) === 'open:7')
check('every capsule minted is sold out, even with artworks left', verdict({ capsulesOutstanding: 0 }) === 'sold out')
check('an unconfirmed table waits rather than sells', verdict({ standingReadable: false }) === 'checking what’s left')
check('nothing drawable is nothing left to win', verdict({ drawable: false }) === 'nothing left to win')
check('no artworks left is nothing left to win', verdict({ prizesRemaining: 0 }) === 'nothing left to win')

// ── the first gate that fails is the reason ────────────────────────────────
check('a closed season outranks everything', verdict({ state: 'ended' as never, saleReadable: false, drawable: false }) === 'season closed')
check('an unreadable price outranks an empty table', verdict({ saleReadable: false, drawable: false }) === 'price unavailable')
check('an ended sale outranks a sold-out capsule', verdict({ sale: { ...SALE, saleEnd: NOW - 1 }, capsulesOutstanding: 0 }) === `sale ended@${NOW - 1}`)
check('a sold-out capsule outranks an unconfirmed table', verdict({ capsulesOutstanding: 0, standingReadable: false }) === 'sold out')
check('an unconfirmed table outranks an empty one', verdict({ standingReadable: false, drawable: false }) === 'checking what’s left')

// ── 2. the largest pull it can honour ──────────────────────────────────────
check('no more than the artworks left', verdict({ prizesRemaining: 3, capsulesOutstanding: 10 }) === 'open:3')
check('no more than the capsules left', verdict({ prizesRemaining: 9, capsulesOutstanding: 2 }) === 'open:2')
check('an unlimited lineup is bounded by the capsules', verdict({ prizesRemaining: null, capsulesOutstanding: 4 }) === 'open:4')
check('an open edition with a floor piece has no limit', verdict({ prizesRemaining: null, capsulesOutstanding: null }) === 'open:null')

// ── 3. reveal machines ──────────────────────────────────────────────────────
const r = (over: Partial<{ state: string; onSale: number; waiting: number }>) =>
  revealSelling({ state: 'live', onSale: 3, waiting: 0, ...over } as never)
check('a live reveal machine with pieces on sale pulls', r({}).open === true)
const empty = r({ onSale: 0, waiting: 2 })
check('with nothing on sale it says so, and how many join later',
  !empty.open && empty.reason === 'nothing on sale right now' && empty.waiting === 2, JSON.stringify(empty))
check('a queued reveal machine is a preview', !r({ state: 'review' }).open && (r({ state: 'review' }) as { reason: string }).reason === 'in review')
check('a closed one is a closed season', (r({ state: 'ended' }) as { reason: string }).reason === 'season closed')

// ── 4. what a card shows ────────────────────────────────────────────────────
const card = (over: Partial<typeof selling>, kind: 'capsule' | 'reveal' = 'capsule') => cardSelling(capsuleSelling({ ...selling, ...over }), kind)
check('a selling machine reads live, with its play', card({}).label === 'live' && card({}).open && !card({}).quiet && card({}).why === null)
check('an empty one reads sold out, quiet, saying nothing is left to win',
  card({ drawable: false }).label === 'sold out' && card({ drawable: false }).quiet && card({ drawable: false }).why === 'nothing left to win')
check('a sold-out capsule says every capsule sold', card({ capsulesOutstanding: 0 }).why === 'every capsule sold' && card({ capsulesOutstanding: 0 }).label === 'sold out')
const soon = card({ sale: { ...SALE, saleStart: NOW + 86_400 } })
check('one about to open reads soon, not quiet, with its date', soon.label === 'soon' && !soon.quiet && /^opens /.test(soon.why ?? ''), JSON.stringify(soon))
const ended = card({ sale: { ...SALE, saleEnd: NOW - 86_400 } })
check('one whose sale ended reads closed, with its date', ended.label === 'closed' && ended.quiet && /^ended /.test(ended.why ?? ''), JSON.stringify(ended))
check('a read that failed reads unavailable, not quiet', card({ saleReadable: false }).label === 'unavailable' && !card({ saleReadable: false }).quiet)
check('a closed season keeps the old words', card({ state: 'ended' as never }).why === 'capsule · season over' && card({ state: 'ended' as never }, 'reveal').why === 'reveal machine')
check('a reveal machine waiting on sales reads soon; one with none coming reads sold out',
  cardSelling(revealSelling({ state: 'live', onSale: 0, waiting: 1 }), 'reveal').label === 'soon' &&
    cardSelling(revealSelling({ state: 'live', onSale: 0, waiting: 0 }), 'reveal').label === 'sold out')
const order = ['closed', 'sold out', 'live', 'unavailable', 'soon'].sort((a, b) => CARD_ORDER[a as keyof typeof CARD_ORDER] - CARD_ORDER[b as keyof typeof CARD_ORDER])
check('a visitor reads what they can play first, what can no longer be had last', order.join(',') === 'live,soon,unavailable,sold out,closed', order.join(','))

if (failures > 0) {
  console.error(`\nverify-selling: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nverify-selling: all checks passed')
