import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { getSessionAddress } from '@/lib/session'
import { checkRateLimit } from '@/lib/ratelimit'
import { deleteScout, getScout, saveScout, type ScoutRecord } from '@/lib/agent/scout/store'
import { freshUsage, type BudgetUsage, type Scout } from '@/lib/agent/scout/engine'

export const runtime = 'nodejs'

/**
 * Per-user Scout config (the budgeted, artist-watching auto-collect agent).
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

  let body: {
    scout?: Partial<Scout>
    usage?: { periodStart?: number; spentThisPeriod?: string; itemsThisPeriod?: number }
    artistLabels?: Record<string, unknown>
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

  const now = Math.floor(Date.now() / 1000)
  const scout: Scout = {
    id: owner.toLowerCase(),
    owner: owner.toLowerCase(),
    name: typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 60) : 'Auto-collect',
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
      mediaTypes: [],
    },
    createdAt: now,
    ...(s.permissionRef ? { permissionRef: String(s.permissionRef) } : {}),
  }

  // Usage: a run reports updated usage (item count + on-chain-reconciled spend);
  // accept it when well-formed (the common path after a run) — and skip the
  // extra read. Otherwise preserve existing usage across config edits (so editing
  // policy mid-period doesn't reset the item count), starting fresh on first
  // create or a new period. The on-chain Spend Permission is the authoritative
  // dollar cap regardless of what's stored here.
  const u = body.usage
  let usage: BudgetUsage
  if (
    u &&
    Number.isInteger(u.periodStart) &&
    Number.isInteger(u.itemsThisPeriod) &&
    (u.itemsThisPeriod as number) >= 0 &&
    isNonNegIntStr(u.spentThisPeriod)
  ) {
    usage = { periodStart: u.periodStart as number, spentThisPeriod: u.spentThisPeriod as string, itemsThisPeriod: u.itemsThisPeriod as number }
  } else {
    const existing = await getScout(owner)
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

  const record: ScoutRecord = { scout, usage, ...(artistLabels ? { artistLabels } : {}) }
  await saveScout(record)
  return NextResponse.json({ scout, usage, artistLabels: artistLabels ?? null })
}

function isPositiveIntStr(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]+$/.test(v) && BigInt(v) > 0n
}

function isNonNegIntStr(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]+$/.test(v)
}
