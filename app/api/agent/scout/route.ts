import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { getSessionAddress } from '@/lib/session'
import { checkRateLimit } from '@/lib/ratelimit'
import { serverBaseClient } from '@/lib/rpc'
import { deleteScout, getScout, saveScout, type ScoutRecord } from '@/lib/agent/scout/store'
import { freshUsage, type BudgetUsage, type Scout } from '@/lib/agent/scout/engine'
import type { StoredSpendPermission } from '@/lib/agent/scout/serverExecutor'

export const runtime = 'nodejs'

/**
 * Per-user Scout config (the budgeted, artist-watching Agent Collect engine).
 * Owner-only: the address is the authenticated session, never the request body,
 * so nobody can read or write another user's scout. The on-chain Spend
 * Permission is the real budget cap; this only stores the Kismet-side policy +
 * lifecycle + item-count usage. Smart-wallet-only in practice — an EOA can't
 * grant the Spend Permission a scout needs, so it never has one to run.
 */

const MAX_CREATORS = 50

export async function GET(req: NextRequest) {
  const owner = await getSessionAddress(req)
  if (!owner) return errorResponse(401, 'Sign in to continue')
  const record = await getScout(owner)
  return NextResponse.json({
    scout: record?.scout ?? null,
    usage: record?.usage ?? null,
    artistLabels: record?.artistLabels ?? null,
    // The owner's own bounded permission (signature included — they granted it),
    // so the panel can show live status + revoke. `away` = unattended opted in.
    permission: record?.permission ?? null,
    away: record?.away ?? false,
  })
}

export async function DELETE(req: NextRequest) {
  const owner = await getSessionAddress(req)
  if (!owner) return errorResponse(401, 'Sign in to continue')
  await deleteScout(owner)
  return NextResponse.json({ ok: true })
}

export async function PUT(req: NextRequest) {
  const owner = await getSessionAddress(req)
  if (!owner) return errorResponse(401, 'Sign in to continue')
  if (!(await checkRateLimit(`agent-scout:${owner.toLowerCase()}`, 30, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  // Smart-wallet only (defense-in-depth behind the client eligibility gate): a
  // scout needs a Spend Permission an EOA can't grant. Smart accounts (and
  // ERC-7702-delegated EOAs) have code; plain EOAs return '0x'. Note: a
  // counterfactual/undeployed Base Account also returns '0x' and is rejected
  // until its first on-chain tx — acceptable for v1. Fail-open on RPC error so
  // a flaky read can't block a legitimate user.
  try {
    const code = await serverBaseClient().getCode({ address: owner as `0x${string}` })
    if (!code || code === '0x') {
      return errorResponse(403, 'Agent Collect requires a Base Account (smart wallet)')
    }
  } catch {
    /* fail-open: don't block on a transient RPC error */
  }

  let body: {
    scout?: Partial<Scout>
    usage?: { periodStart?: number; spentThisPeriod?: string; itemsThisPeriod?: number }
    artistLabels?: Record<string, unknown>
    /** Phase 2: the granted Spend Permission + the unattended opt-in. */
    permission?: StoredSpendPermission
    away?: boolean
  }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return errorResponse(400, 'Invalid JSON')
  }
  const s = body.scout
  if (!s) return errorResponse(400, 'Missing scout')

  // Validate policy: watched artists are required and must be addresses.
  const creators = Array.isArray(s.policy?.creators)
    ? s.policy!.creators.map((c) => String(c).toLowerCase()).filter((c) => isAddress(c))
    : []
  if (creators.length === 0) return errorResponse(400, 'Add at least one artist to watch')
  if (creators.length > MAX_CREATORS) return errorResponse(400, `At most ${MAX_CREATORS} artists`)

  // Validate budget snapshot (mirrors the on-chain Spend Permission the client
  // granted). Amounts are base-unit decimal strings.
  const b = s.budget
  if (!b || (b.currency !== 'usdc' && b.currency !== 'eth')) return errorResponse(400, 'Invalid budget currency')
  if (!isPositiveIntStr(b.allowance)) return errorResponse(400, 'Invalid allowance')
  if (!Number.isInteger(b.periodSeconds) || b.periodSeconds < 1) return errorResponse(400, 'Invalid period')
  if (!Number.isInteger(b.start) || !Number.isInteger(b.end) || b.end <= b.start) return errorResponse(400, 'Invalid window')

  const p = s.policy!
  if (!isPositiveIntStr(p.maxItemPrice)) return errorResponse(400, 'Invalid max item price')
  if (!Number.isInteger(p.maxItemsPerPeriod) || p.maxItemsPerPeriod < 1) return errorResponse(400, 'Invalid items per period')

  // Editions per drop (optional; default 1 = one of each new drop). Capped at 10
  // to bound per-drop spend — the dollar budget is the authoritative cap anyway.
  const maxEditionsPerDrop = p.maxEditionsPerDrop == null ? 1 : p.maxEditionsPerDrop
  if (!Number.isInteger(maxEditionsPerDrop) || maxEditionsPerDrop < 1 || maxEditionsPerDrop > 10) {
    return errorResponse(400, 'Invalid editions per drop (1–10)')
  }

  const now = Math.floor(Date.now() / 1000)
  const scout: Scout = {
    id: owner.toLowerCase(),
    owner: owner.toLowerCase(),
    name: typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 60) : 'Agent Collect',
    mode: s.mode === 'propose' ? 'propose' : 'auto',
    status: s.status === 'paused' ? 'paused' : 'active',
    budget: {
      currency: b.currency,
      allowance: b.allowance,
      periodSeconds: b.periodSeconds,
      start: b.start,
      end: b.end,
    },
    policy: {
      collections: [],
      creators,
      blockedCollections: [],
      blockedCreators: [],
      maxItemPrice: p.maxItemPrice,
      maxItemsPerPeriod: p.maxItemsPerPeriod,
      maxEditionsPerDrop,
      mediaTypes: [],
    },
    createdAt: now,
  }

  // Usage: a run reports updated usage (item count + on-chain-reconciled spend);
  // accept it when well-formed (the common path after a run). Otherwise preserve
  // existing usage across config edits (so editing policy mid-period doesn't
  // reset the item count), starting fresh on first create or a new period. The
  // on-chain Spend Permission is the authoritative dollar cap regardless.
  const existing = await getScout(owner)
  const u = body.usage
  let usage: BudgetUsage
  if (
    u &&
    Number.isInteger(u.periodStart) &&
    Number.isInteger(u.itemsThisPeriod) &&
    (u.itemsThisPeriod as number) >= 0 &&
    isNonNegIntStr(u.spentThisPeriod)
  ) {
    // Anti-spoof: the item count must not DECREASE within the same period (a
    // client can't reset its self-imposed item cap mid-period; legit rollover
    // advances periodStart). The dollar cap is enforced on-chain regardless.
    let items = u.itemsThisPeriod as number
    if (existing && existing.usage.periodStart === u.periodStart && items < existing.usage.itemsThisPeriod) {
      items = existing.usage.itemsThisPeriod
    }
    usage = { periodStart: u.periodStart as number, spentThisPeriod: u.spentThisPeriod as string, itemsThisPeriod: items }
  } else {
    usage = existing && existing.usage.periodStart >= scout.budget.start ? existing.usage : freshUsage(scout.budget, now)
  }

  // Display-only labels: keep only entries whose key is a watched creator, with
  // a short string value. Falls back to the existing labels on a usage-only PUT.
  const creatorSet = new Set<string>(creators)
  let artistLabels: Record<string, string> | undefined
  if (body.artistLabels && typeof body.artistLabels === 'object') {
    artistLabels = {}
    for (const [k, v] of Object.entries(body.artistLabels)) {
      const addr = k.toLowerCase()
      if (creatorSet.has(addr) && typeof v === 'string' && v.trim()) artistLabels[addr] = v.trim().slice(0, 40)
    }
  }

  // Phase 2: preserve the granted permission + away opt-in across usage-only PUTs;
  // a fresh config save re-sends both.
  const permission = body.permission ?? existing?.permission

  // Validate any incoming permission: account must match the authenticated session
  // owner and the spender must be Kismet's configured spender — so a user can't
  // store a permission that would drain a different account or target a foreign spender.
  if (body.permission) {
    const pd = body.permission.permission
    if (!pd?.account || pd.account.toLowerCase() !== owner.toLowerCase()) {
      return errorResponse(400, 'Permission account does not match your address')
    }
    const configuredSpender = process.env.NEXT_PUBLIC_SCOUT_SPENDER_ADDRESS
    if (configuredSpender && pd.spender?.toLowerCase() !== configuredSpender.toLowerCase()) {
      return errorResponse(400, 'Permission spender does not match the configured spender')
    }
  }

  const away = typeof body.away === 'boolean' ? body.away : (existing?.away ?? false)

  // If a budget change replaced the permission, stash the OLD one so the next run
  // silently revokes it from the spender (revokeAsSpender — no user signature),
  // rather than leaving an orphaned active grant. Carry forward any not-yet-revoked
  // ones, never include the current permission, and cap the queue. A usage-only or
  // pause/resume PUT re-sends no permission, so permKey matches and nothing stashes.
  let supersededPermissions = existing?.supersededPermissions
  const prevPerm = existing?.permission
  if (prevPerm && permission && permKey(prevPerm) !== permKey(permission)) {
    const list = (existing?.supersededPermissions ?? []).filter((x) => permKey(x) !== permKey(permission))
    if (!list.some((x) => permKey(x) === permKey(prevPerm))) list.push(prevPerm)
    supersededPermissions = list.slice(-5)
  }

  const record: ScoutRecord = {
    scout,
    usage,
    ...(artistLabels ? { artistLabels } : {}),
    ...(permission ? { permission } : {}),
    ...(away ? { away: true } : {}),
    ...(supersededPermissions?.length ? { supersededPermissions } : {}),
  }
  await saveScout(record)

  return NextResponse.json({ scout, usage, artistLabels: artistLabels ?? null, permission: permission ?? null, away })
}

function isPositiveIntStr(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]+$/.test(v) && BigInt(v) > 0n
}

function isNonNegIntStr(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]+$/.test(v)
}

/** Stable identity for a stored permission (token+allowance+period+start). A fresh
 *  grant always differs (new start), a reused one matches — so we never stash, and
 *  the run loop never revokes, the permission we're still spending against. */
function permKey(p: StoredSpendPermission): string {
  const d = p.permission
  return `${d.token}:${d.allowance}:${d.period}:${d.start}`.toLowerCase()
}
