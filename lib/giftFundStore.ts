import { redis } from './redis'
import { parseWei } from './giftFund'

/**
 * Redis store for Gift Fund campaigns (see lib/giftFund for the model and
 * rules). Shapes, all namespaced under kismetart:giftfund:
 *
 *   :campaign:{giftTx}      HASH   the campaign record (below)
 *   :by-moment:{c}:{t}      STRING active campaignId for an artwork — ONE
 *                                  active campaign per moment (competing
 *                                  progress bars would split backers), NX-
 *                                  claimed at open, deleted when it resolves
 *   :contribs:{giftTx}      ZSET   member contribTx, score blockTimestampMs
 *   :contrib:{giftTx}:{tx}  HASH   backer, amountWei — the roll's row data
 *   :backers:{giftTx}       SET    distinct backer wallets — SADD's return is
 *                                  the atomic new-backer test for headcount
 *   :claimed:{contribTx}    STRING global NX: one tx backs one campaign, ever
 *
 * The campaign is keyed by the GIFT's txHash — proven unique on-chain, and
 * it is the record the open route verified, so the id itself is the binding
 * between campaign and gift. No TTLs on campaign data (it is the durable
 * record the panel renders); the claim NX key carries one so the keyspace
 * stays bounded.
 */

const CLAIMED_TTL = 90 * 24 * 60 * 60 // matches the collect/credit idempotency horizon

const keyCampaign = (giftTx: string) => `kismetart:giftfund:campaign:${giftTx.toLowerCase()}`
const keyByMoment = (collection: string, tokenId: string) =>
  `kismetart:giftfund:by-moment:${collection.toLowerCase()}:${tokenId}`
const keyContribs = (giftTx: string) => `kismetart:giftfund:contribs:${giftTx.toLowerCase()}`
const keyContrib = (giftTx: string, contribTx: string) =>
  `kismetart:giftfund:contrib:${giftTx.toLowerCase()}:${contribTx.toLowerCase()}`
const keyClaimed = (contribTx: string) => `kismetart:giftfund:claimed:${contribTx.toLowerCase()}`
const keyBackers = (giftTx: string) => `kismetart:giftfund:backers:${giftTx.toLowerCase()}`

export interface GiftFundCampaign {
  giftTx: string
  collection: string
  tokenId: string
  organizer: string
  recipient: string
  /** Frozen at open — sale prices are editable (lib/saleEdit), so re-reading
   *  would move the bar. Decimal wei string. */
  goalWei: string
  raisedWei: string
  backers: number
  note: string
  /** Artwork title snapshot for share copy and notifications — best-effort
   *  at open (meta can lag); empty string when unknown. */
  tokenName: string
  openedAtMs: number
  closesAtMs: number
}

/** Open a campaign. Returns false when the moment already has an active one
 *  (the by-moment slot is NX — first open wins; the loser's error is the
 *  panel's "a fund is already running" state). The caller has already
 *  verified the gift on-chain and derived every field — this is the write
 *  step, not the proof step. */
export async function openCampaign(c: GiftFundCampaign): Promise<boolean> {
  const slot = await redis.set(keyByMoment(c.collection, c.tokenId), c.giftTx.toLowerCase(), {
    nx: true,
  })
  if (slot !== 'OK') return false
  // Wei fields are stored JSON-QUOTED (see ADD_WEI_LUA's note): a bare digit
  // string round-trips through Upstash's read-side JSON.parse as a NUMBER,
  // and wei amounts exceed float precision — the quoted form comes back as
  // the exact string.
  await redis.hset(keyCampaign(c.giftTx), {
    ...c,
    goalWei: JSON.stringify(c.goalWei),
    raisedWei: JSON.stringify(c.raisedWei),
  })
  return true
}

/** Organizer's early close: stop accepting new transfers NOW (the claim
 *  grace still honors transfers that landed before this moment — the two
 *  clocks in lib/giftFund are unchanged, only the window end moves). */
export async function closeCampaign(giftTx: string, nowMs: number): Promise<void> {
  await redis.hset(keyCampaign(giftTx), { closesAtMs: nowMs })
}

export async function getCampaign(giftTx: string): Promise<GiftFundCampaign | null> {
  const h = await redis.hgetall<Record<string, string | number>>(keyCampaign(giftTx))
  if (!h || !h.giftTx) return null
  return {
    giftTx: String(h.giftTx),
    collection: String(h.collection ?? ''),
    tokenId: String(h.tokenId ?? ''),
    organizer: String(h.organizer ?? ''),
    recipient: String(h.recipient ?? ''),
    goalWei: parseWei(h.goalWei).toString(),
    raisedWei: parseWei(h.raisedWei).toString(),
    backers: Number(h.backers ?? 0) || 0,
    note: typeof h.note === 'string' ? h.note : '',
    tokenName: typeof h.tokenName === 'string' ? h.tokenName : '',
    openedAtMs: Number(h.openedAtMs ?? 0) || 0,
    closesAtMs: Number(h.closesAtMs ?? 0) || 0,
  }
}

export async function getActiveCampaignId(
  collection: string,
  tokenId: string,
): Promise<string | null> {
  const v = await redis.get<string>(keyByMoment(collection, tokenId))
  return typeof v === 'string' && v ? v : null
}

/** Release the one-active-per-moment slot once a campaign has resolved
 *  (expired past its claim grace). Best-effort — a lingering slot only
 *  blocks a NEW fund on the same artwork, and the panel surfaces why. */
export async function releaseMomentSlot(collection: string, tokenId: string): Promise<void> {
  await redis.del(keyByMoment(collection, tokenId)).catch(() => {})
}

/** Claim a contribution tx globally — one tx backs one campaign, ever.
 *  NX AFTER verification succeeds (mirror of creditValidityOnce's ordering):
 *  claiming before verifying would let an invalid claim burn the slot for
 *  the real one. The key's VALUE is the claiming campaign, so a caller that
 *  lost the NX race can tell whether the tx belongs to ITS campaign
 *  ('ours' — check the row and finish a half-done record) or to another
 *  ('other' — a hard stop; recording would double-spend the tx). */
export async function claimContributionTx(
  contribTx: string,
  campaignId: string,
): Promise<'claimed' | 'ours' | 'other'> {
  const key = keyClaimed(contribTx)
  const id = campaignId.toLowerCase()
  const claimed = await redis.set(key, id, { nx: true, ex: CLAIMED_TTL })
  if (claimed === 'OK') return 'claimed'
  const owner = await redis.get<string>(key)
  return typeof owner === 'string' && owner.toLowerCase() === id ? 'ours' : 'other'
}

/** Does the durable contribution row exist? The recovery probe for a claim
 *  that returned 'ours': rows are written FIRST in recordContribution, so a
 *  missing row means the record never started and re-running it is safe. */
export async function contributionRecorded(
  giftTx: string,
  contribTx: string,
): Promise<boolean> {
  return (await redis.exists(keyContrib(giftTx, contribTx))) === 1
}

// Atomic wei accumulation. raisedWei is a decimal string that can exceed
// 64-bit integer range, so HINCRBY cannot carry it; a JS read-modify-write
// would let two concurrent claims of DIFFERENT txs (the only concurrency —
// same-tx is NX-serialized upstream) interleave and silently drop one amount
// from the display. Lua string-add of two decimal wei values keeps the
// accumulate atomic without a numeric ceiling. Redis Lua has 53-bit-safe
// number semantics at most, so the addition is done digit-wise on strings.
// The stored form is JSON-QUOTED ("123"): Upstash's read side JSON.parses
// hash fields, and a bare digit string would come back as a precision-lossy
// float (wei exceeds 2^53) — quoted, it comes back as the exact string. The
// script strips quotes on read and re-quotes on write.
const ADD_WEI_LUA = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur then cur = string.gsub(cur, '"', '') end
if not cur or not string.match(cur, '^%d+$') then cur = '0' end
local a, b = cur, ARGV[2]
local ra, rb = a:reverse(), b:reverse()
local out, carry = {}, 0
for i = 1, math.max(#ra, #rb) do
  local da = tonumber(ra:sub(i, i)) or 0
  local db = tonumber(rb:sub(i, i)) or 0
  local sum = da + db + carry
  out[i] = tostring(sum % 10)
  carry = math.floor(sum / 10)
end
if carry > 0 then out[#out + 1] = tostring(carry) end
local res = table.concat(out):reverse():gsub('^0+(%d)', '%1')
redis.call('HSET', KEYS[1], ARGV[1], '"' .. res .. '"')
return res
`

/** Record a verified contribution and bump the campaign's aggregates.
 *  The backers SET is both the dedup and the headcount driver: SADD's
 *  return says whether this wallet is new, atomically — no read-then-write
 *  race on the count. Writes are ordered rows-first so a partial failure
 *  under-reports the aggregates (safe direction, durable rows remain the
 *  source of truth) rather than over-reporting. */
export async function recordContribution(params: {
  giftTx: string
  contribTx: string
  backer: string
  amountWei: bigint
  blockTimestampMs: number
}): Promise<void> {
  const { giftTx, contribTx, backer, amountWei, blockTimestampMs } = params
  await redis.hset(keyContrib(giftTx, contribTx), {
    backer: backer.toLowerCase(),
    // Quoted for the same precision reason as the campaign's wei fields.
    amountWei: JSON.stringify(amountWei.toString()),
  })
  await redis.zadd(keyContribs(giftTx), {
    score: blockTimestampMs,
    member: contribTx.toLowerCase(),
  })
  await redis.eval(ADD_WEI_LUA, [keyCampaign(giftTx)], ['raisedWei', amountWei.toString()])
  const isNew = await redis.sadd(keyBackers(giftTx), backer.toLowerCase())
  if (isNew === 1) {
    await redis.hincrby(keyCampaign(giftTx), 'backers', 1)
  }
}

/** Newest-first contribution rows for the panel's backer roll. Row reads go
 *  out concurrently — each is its own REST round trip, and serializing them
 *  would stack that latency on a per-artwork-view route. */
export async function listContributions(
  giftTx: string,
  limit = 50,
): Promise<{ contribTx: string; backer: string; amountWei: string }[]> {
  const txs = (await redis.zrange(keyContribs(giftTx), 0, limit - 1, { rev: true })) as string[]
  if (!Array.isArray(txs)) return []
  const rows = await Promise.all(
    txs.map((tx) => redis.hgetall<Record<string, string | number>>(keyContrib(giftTx, tx))),
  )
  const out: { contribTx: string; backer: string; amountWei: string }[] = []
  for (let i = 0; i < txs.length; i++) {
    const h = rows[i]
    if (!h) continue
    out.push({
      contribTx: txs[i],
      backer: String(h.backer ?? ''),
      amountWei: parseWei(h.amountWei).toString(),
    })
  }
  return out
}
