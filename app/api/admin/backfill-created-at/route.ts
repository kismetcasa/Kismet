import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { verifyAdminSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'
import { recordAdminAction } from '@/lib/adminAudit'
import { inprocessUrl } from '@/lib/inprocess'
import {
  getUserCollections,
  getCollectionMeta,
  setCollectionCreatedAt,
} from '@/lib/kv'

/**
 * Admin-gated one-time backfill for collection creation dates.
 *
 * Background: the collection page used to source `created_at` from inprocess's
 * singular `/collection` endpoint, which was removed upstream (now 404s), so
 * the "created <date>" chip went blank for every existing collection. New
 * collections now carry a deploy-time KV stamp (see addTrackedCollection), but
 * ones deployed before that shipped have no stamp. This route seeds it from the
 * one place the real date is still readable: inprocess's plural `/collections`
 * list, whose rows carry { address, created_at }.
 *
 * Two upstream quirks shape the implementation:
 *  - the `address` query param is IGNORED — the list returns the newest ~100
 *    rows regardless — so we pull one page and build an address→date map rather
 *    than fetch per collection. Collections older than that window aren't in the
 *    response and are reported as `noSource` (backfill them from chain instead).
 *  - the row's address field is `address`, not `contractAddress`.
 *
 * GET  = read-only preview (what WOULD change). Safe to hit in a browser.
 * POST = execute. Body: { address?, force?, dryRun? }. `address` targets one
 *        collection (default: all curated); `force` overwrites an existing
 *        stamp; `dryRun` mirrors GET. Idempotent: an existing stamp is skipped
 *        unless force is set.
 */

interface BackfillBody {
  address?: string
  force?: boolean
  dryRun?: boolean
}

interface Plan {
  set: string[]
  skipped: string[]
  noRecord: string[]
  noSource: string[]
}

// Pull the newest page of the plural list and map lowercased address → ms epoch.
async function fetchCreatedAtMap(): Promise<Map<string, number>> {
  const url = inprocessUrl('/collections', { chain_id: '8453' })
  const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' })
  if (!res.ok) throw new Error(`inprocess /collections ${res.status}`)
  const data = (await res.json()) as { collections?: { address?: string; created_at?: string }[] }
  const rows = Array.isArray(data?.collections) ? data.collections : []
  const map = new Map<string, number>()
  for (const r of rows) {
    if (!r.address || !r.created_at) continue
    const ms = Date.parse(r.created_at)
    if (Number.isFinite(ms)) map.set(r.address.toLowerCase(), ms)
  }
  return map
}

async function buildPlan(
  targets: string[],
  createdAtMap: Map<string, number>,
  force: boolean,
  write: boolean,
): Promise<Plan> {
  const plan: Plan = { set: [], skipped: [], noRecord: [], noSource: [] }
  for (const addr of targets) {
    const ms = createdAtMap.get(addr)
    if (ms == null) {
      plan.noSource.push(addr)
      continue
    }
    const label = `${addr} -> ${new Date(ms).toISOString()}`
    if (write) {
      const outcome = await setCollectionCreatedAt(addr, ms, force)
      if (outcome === 'set') plan.set.push(label)
      else if (outcome === 'skipped') plan.skipped.push(addr)
      else plan.noRecord.push(addr)
    } else {
      // Preview: mirror setCollectionCreatedAt's decision without writing.
      const existing = await getCollectionMeta(addr)
      if (!existing) plan.noRecord.push(addr)
      else if (existing.createdAt && !force) plan.skipped.push(addr)
      else plan.set.push(label)
    }
  }
  return plan
}

async function run(opts: { address?: string; force: boolean; write: boolean }) {
  if (opts.address && !isAddress(opts.address)) {
    return errorResponse(400, 'Invalid address')
  }
  let createdAtMap: Map<string, number>
  try {
    createdAtMap = await fetchCreatedAtMap()
  } catch (err) {
    return errorResponse(
      502,
      `Could not read inprocess collections: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const targets = opts.address
    ? [opts.address.toLowerCase()]
    : (await getUserCollections()).map((a) => a.toLowerCase())

  const plan = await buildPlan(targets, createdAtMap, opts.force, opts.write)
  return NextResponse.json({
    ok: true,
    dryRun: !opts.write,
    counts: {
      set: plan.set.length,
      skipped: plan.skipped.length,
      noRecord: plan.noRecord.length,
      noSource: plan.noSource.length,
    },
    ...plan,
  })
}

export async function GET(req: NextRequest) {
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)
  const { searchParams } = new URL(req.url)
  return run({
    address: searchParams.get('address') ?? undefined,
    force: searchParams.get('force') === '1',
    write: false,
  })
}

export async function POST(req: NextRequest) {
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)
  const body = (await req.json().catch(() => null)) as BackfillBody | null
  const write = !body?.dryRun
  const res = await run({
    address: body?.address,
    force: !!body?.force,
    write,
  })
  // Audit only real writes — the GET handler and dryRun POSTs mutate nothing.
  if (write) {
    await recordAdminAction('backfill-created-at.run', {
      actor: auth.signer,
      ...(body?.address ? { target: body.address.toLowerCase() } : {}),
      meta: { force: !!body?.force },
    })
  }
  return res
}
