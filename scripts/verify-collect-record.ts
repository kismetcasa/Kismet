// Verifies the two rules behind "an old piece at the top of latest sales with
// no recent collector in its activity" (2026-09):
//
//   1. lib/activityFold — Kismet-recorded collects fold into the artwork's
//      activity list when In Process has no comment row for the mint (an
//      empty on-chain comment emits no MintComment event; indexer lag), and
//      never duplicate a row it does have.
//   2. lib/collectRecord — a record whose mint predates the idempotency
//      window is a backfill, not a sale event; plus the per-artwork collect
//      log's deterministic member (a re-record is a ZADD no-op) and the
//      comment default every agent mint now carries.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//        --import ./scripts/register-ts-alias.mjs scripts/verify-collect-record.ts

import { foldKismetCollects, KISMET_COLLECT_MATCH_WINDOW_MS } from '../lib/activityFold.ts'
import { COLLECT_IDEMPOTENCY_TTL_SECONDS, isStaleCollectRecord } from '../lib/collectRecord.ts'
import {
  DEFAULT_COLLECT_COMMENT,
  defaultCollectComment,
  isFoldedActivityRow,
  normalizeMomentComments,
  type MomentComment,
} from '../lib/inprocess.ts'
import type { MomentCollectRecord } from '../lib/collected.ts'

// lib/collected instantiates the Upstash client at import (static imports are
// hoisted above any env assignment), so give it a placeholder first and load
// it dynamically — nothing here touches Redis.
process.env.UPSTASH_REDIS_REST_URL ??= 'https://placeholder.upstash.io'
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'placeholder'
const { momentCollectMember } = await import('../lib/collected.ts')

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const TX1 = `0x${'01'.repeat(32)}`
const TX2 = `0x${'02'.repeat(32)}`
const NOW = Date.parse('2026-09-26T12:00:00Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const rec = (over: Partial<MomentCollectRecord> = {}): MomentCollectRecord => ({
  collector: A,
  txHash: TX1,
  amount: 1,
  timestamp: NOW - HOUR,
  ...over,
})
const up = (over: Partial<MomentComment> & Record<string, unknown> = {}): MomentComment => ({
  sender: A,
  comment: DEFAULT_COLLECT_COMMENT,
  timestamp: NOW - HOUR,
  ...over,
})
const none = new Set<string>()

// ── 1. fold: what gets added ──────────────────────────────────────────────────
console.log('fold — Kismet-recorded collects the upstream feed has no row for')
{
  const rows = foldKismetCollects([], [rec()], none)
  check('no upstream row → one folded row', rows.length === 1)
  check('folded row is the collector, stamped kismet-collect, at the record time',
    rows[0]?.sender === A && rows[0]?.kind === 'kismet-collect' && rows[0]?.timestamp === NOW - HOUR,
    JSON.stringify(rows[0]))
  check('a record without a human comment renders the platform label', rows[0]?.comment === DEFAULT_COLLECT_COMMENT)
}
{
  const rows = foldKismetCollects([], [rec({ comment: 'stunning' })], none)
  check("the collector's own comment rides the folded row", rows[0]?.comment === 'stunning')
  const plat = foldKismetCollects([], [rec({ comment: 'collected via Kismet' })], none)
  check('a legacy platform label is normalized to the current one', plat[0]?.comment === DEFAULT_COLLECT_COMMENT)
}
{
  const rows = foldKismetCollects([up()], [rec()], none)
  check('an upstream row from the same sender at the same time → no folded row (never a duplicate)', rows.length === 0)
}
{
  const rows = foldKismetCollects([up({ timestamp: Math.floor((NOW - HOUR - 5 * 60_000) / 1000) })], [rec()], none)
  check('…also when upstream stamps in SECONDS, minutes apart (normalized before comparing)', rows.length === 0)
}
{
  const edge = foldKismetCollects([up({ timestamp: NOW - HOUR - KISMET_COLLECT_MATCH_WINDOW_MS })], [rec()], none)
  const past = foldKismetCollects([up({ timestamp: NOW - HOUR - KISMET_COLLECT_MATCH_WINDOW_MS - 1 })], [rec()], none)
  check('an upstream row exactly one window away still matches', edge.length === 0)
  check('an upstream row just past the window is a different mint → folded row', past.length === 1)
}
{
  const rows = foldKismetCollects([up({ timestamp: NOW - 200 * DAY })], [rec()], none)
  check("the collector's OLD collect (months ago) doesn't hide their new one", rows.length === 1)
}
{
  const rows = foldKismetCollects([up({ commentId: 'c1', comment: 'love it' })], [rec()], none)
  check('a post-collect on-chain comment (commentId set) is not a mint → folded row still added', rows.length === 1)
}
{
  const rows = foldKismetCollects([up({ sender: B })], [rec()], none)
  check('a different sender at the same time is unrelated → folded row', rows.length === 1)
}
{
  const upperCase = up({ sender: A.toUpperCase().replace('0X', '0x') })
  const rows = foldKismetCollects([upperCase], [rec()], none)
  check('sender matching is case-insensitive', rows.length === 0)
}
{
  const airdrop = up({ kind: 'airdrop', comment: 'airdropped on kismet' })
  const rows = foldKismetCollects([airdrop], [rec()], none)
  check('an airdrop row for the same wallet is not a collect → folded row', rows.length === 1)
  const folded = up({ kind: 'kismet-collect' })
  check('a previously folded row is never a match candidate either', foldKismetCollects([folded], [rec()], none).length === 1)
}

// ── 2. fold: one-to-one matching ──────────────────────────────────────────────
console.log('\nfold — one upstream row claims one record, no more')
{
  const two = [rec({ txHash: TX1, timestamp: NOW - HOUR }), rec({ txHash: TX2, timestamp: NOW - 2 * HOUR })]
  check('two mints, upstream indexed neither → two rows', foldKismetCollects([], two, none).length === 2)
  check('two mints, upstream indexed one → exactly one row',
    foldKismetCollects([up({ timestamp: NOW - HOUR })], two, none).length === 1)
  const both = [up({ timestamp: NOW - HOUR }), up({ timestamp: NOW - 2 * HOUR })]
  check('two mints, upstream indexed both → no rows', foldKismetCollects(both, two, none).length === 0)
  const oneRow = foldKismetCollects([up({ timestamp: NOW - 2 * HOUR })], two, none)
  check('the upstream row claims the NEAREST record, so the other mint is the one shown',
    oneRow.length === 1 && oneRow[0].timestamp === NOW - HOUR, JSON.stringify(oneRow))
}
{
  const dup = [rec(), rec()]
  check('a duplicated record (same tx + collector) folds once', foldKismetCollects([], dup, none).length === 1)
}
{
  const hidden = new Set([A])
  check('a hidden collector never resurfaces through the fold', foldKismetCollects([], [rec()], hidden).length === 0)
  const rows = foldKismetCollects([], [rec(), rec({ collector: B, txHash: TX2 })], hidden)
  check('…while the others still fold', rows.length === 1 && rows[0].sender === B)
}
{
  const upstream = [up()]
  foldKismetCollects(upstream, [rec()], none)
  check('the upstream page is not mutated', upstream.length === 1 && upstream[0].sender === A)
}

// ── 2b. fold: page 0 only folds what page 0 can vouch for ────────────────────
console.log('\nfold — a full upstream page bounds the fold to its own horizon')
{
  // Page 0 holds rows down to NOW-3h from OTHER senders; a record older than
  // that would have its upstream row (if any) on page 1, which the fold can't
  // see — folding it risks a duplicate once the viewer loads more.
  const page = [up({ sender: B, timestamp: NOW - HOUR }), up({ sender: B, timestamp: NOW - 3 * HOUR, commentId: 'c9' })]
  const older = rec({ timestamp: NOW - 4 * HOUR })
  const newer = rec({ timestamp: NOW - 2 * HOUR })
  check('page full: a record older than the oldest page-0 row is skipped', foldKismetCollects(page, [older], none, { pageFull: true }).length === 0)
  check('page full: a record inside the page horizon still folds', foldKismetCollects(page, [newer], none, { pageFull: true }).length === 1)
  check('page full: the horizon is the oldest row of ANY kind (a post-collect comment counts)',
    foldKismetCollects(page, [rec({ timestamp: NOW - 3 * HOUR })], none, { pageFull: true }).length === 1)
  check('page not full: upstream is fully known, so the older record folds', foldKismetCollects(page, [older], none, { pageFull: false }).length === 1)
  check('page not full is the default', foldKismetCollects(page, [older], none).length === 1)
  check('an empty full page has no horizon — everything folds', foldKismetCollects([], [older], none, { pageFull: true }).length === 1)
}

// ── 3. the client-side predicate + the normalizer ─────────────────────────────
console.log('\nisFoldedActivityRow / normalizeMomentComments')
check('airdrop rows are folded', isFoldedActivityRow({ kind: 'airdrop' }))
check('kismet-collect rows are folded', isFoldedActivityRow({ kind: 'kismet-collect' }))
check('upstream rows (no kind) are not', !isFoldedActivityRow({}))
check("upstream rows (kind 'collect') are not", !isFoldedActivityRow({ kind: 'collect' }))
{
  const rows = normalizeMomentComments([
    { sender: A, comment: '', timestamp: NOW, kind: 'kismet-collect' },
    { sender: A, comment: '', timestamp: NOW, kind: 'bogus' },
  ])
  check("the normalizer keeps 'kismet-collect' and drops a junk kind",
    rows.length === 2 && rows[0].kind === 'kismet-collect' && rows[1].kind === undefined, JSON.stringify(rows))
}

// ── 4. stale-record rule ──────────────────────────────────────────────────────
console.log('\nisStaleCollectRecord — past the idempotency window a record is a backfill')
const WINDOW = COLLECT_IDEMPOTENCY_TTL_SECONDS * 1000
check('the window is the 30-day idempotency TTL', COLLECT_IDEMPOTENCY_TTL_SECONDS === 30 * 24 * 60 * 60)
check('a mint from an hour ago is fresh', !isStaleCollectRecord(NOW - HOUR, NOW))
check('a mint exactly at the window edge is fresh', !isStaleCollectRecord(NOW - WINDOW, NOW))
check('a mint one ms past the window is stale', isStaleCollectRecord(NOW - WINDOW - 1, NOW))
check('a 141-day-old mint (the reported piece) is stale', isStaleCollectRecord(NOW - 141 * DAY, NOW))
check('a mint "in the future" (clock skew, mock chains) is fresh', !isStaleCollectRecord(NOW + DAY, NOW))
check('an unknown mint time never classifies as stale', !isStaleCollectRecord(NaN, NOW))

// ── 5. the collect log member is deterministic ───────────────────────────────
console.log('\nmomentCollectMember — one member per (tx, collector), whatever the request looked like')
{
  const a = momentCollectMember(rec())
  const b = momentCollectMember({ txHash: TX1.toUpperCase().replace('0X', '0x'), amount: 1, collector: A.toUpperCase().replace('0X', '0x'), timestamp: NOW - HOUR })
  check('case variants of the hash and collector produce the same member', a === b, `${a} vs ${b}`)
  check('a re-record with the same fields is byte-identical (ZADD no-op)', momentCollectMember(rec()) === a)
  const parsed = JSON.parse(a) as Record<string, unknown>
  check('the member carries collector, tx, amount and the mint time', parsed.collector === A && parsed.txHash === TX1 && parsed.amount === 1 && parsed.timestamp === NOW - HOUR)
  check('no volatile fields ride along', Object.keys(parsed).sort().join(',') === 'amount,collector,timestamp,txHash', Object.keys(parsed).join(','))
  const gifted = JSON.parse(momentCollectMember(rec({ giftedBy: B.toUpperCase().replace('0X', '0x'), comment: '  nice  ' }))) as Record<string, unknown>
  check('a gift payer is lowercased and a comment trimmed', gifted.giftedBy === B && gifted.comment === 'nice')
  const blank = JSON.parse(momentCollectMember(rec({ comment: '   ' }))) as Record<string, unknown>
  check('a blank comment is not stored', !('comment' in blank))
  const zero = JSON.parse(momentCollectMember(rec({ amount: 0 }))) as Record<string, unknown>
  check('amount floors at 1', zero.amount === 1)
}

// ── 6. the comment every agent mint carries ──────────────────────────────────
console.log('\ndefaultCollectComment — never an empty on-chain comment')
check('blank → the platform default', defaultCollectComment('') === DEFAULT_COLLECT_COMMENT)
check('whitespace → the platform default', defaultCollectComment('   ') === DEFAULT_COLLECT_COMMENT)
check('absent → the platform default', defaultCollectComment(undefined) === DEFAULT_COLLECT_COMMENT && defaultCollectComment(null) === DEFAULT_COLLECT_COMMENT)
check("a written comment is kept (trimmed)", defaultCollectComment('  great piece ') === 'great piece')

console.log(failures === 0 ? '\nOK — collect record + activity fold' : `\nFAILED — ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
