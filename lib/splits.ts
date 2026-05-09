import { redis } from './redis'
import { isAddress } from './address'

export interface SplitRecipient {
  address: string
  percentAllocation: number
}

interface StoredSplitsResult {
  hasSplits: boolean
  recipients: SplitRecipient[]
}

// SplitMain enforces a smaller cap in practice (gas-bound). 50 is a
// generous safety net that no legitimate UI hits.
export const MAX_SPLITS = 50

const splitsKey = (collection: string, tokenId: string) =>
  `kismetart:splits:${collection.toLowerCase()}:${tokenId}`

// JSON values stay truthy so the distribute flow's `hasSplits` gate
// (a `redis.get` truthy check) keeps working alongside the legacy
// `'1'` flag from older mints.
export async function setStoredSplits(
  collection: string,
  tokenId: string,
  recipients: SplitRecipient[],
): Promise<void> {
  const payload = {
    recipients: recipients.map((r) => ({
      address: r.address.toLowerCase(),
      percentAllocation: r.percentAllocation,
    })),
  }
  await redis.set(splitsKey(collection, tokenId), JSON.stringify(payload))
}

export async function getStoredSplits(
  collection: string,
  tokenId: string,
): Promise<StoredSplitsResult> {
  const raw = await redis.get<unknown>(splitsKey(collection, tokenId))
  return decodeStoredSplits(raw)
}

function decodeStoredSplits(raw: unknown): StoredSplitsResult {
  if (raw === null || raw === undefined) {
    return { hasSplits: false, recipients: [] }
  }
  if (typeof raw === 'string') {
    if (raw === '1') return { hasSplits: true, recipients: [] }
    try {
      const parsed = JSON.parse(raw) as { recipients?: unknown }
      return { hasSplits: true, recipients: validateRecipients(parsed?.recipients) }
    } catch {
      return { hasSplits: true, recipients: [] }
    }
  }
  if (typeof raw === 'object') {
    const obj = raw as { recipients?: unknown }
    return { hasSplits: true, recipients: validateRecipients(obj?.recipients) }
  }
  return { hasSplits: false, recipients: [] }
}

function validateRecipients(input: unknown): SplitRecipient[] {
  if (!Array.isArray(input)) return []
  const out: SplitRecipient[] = []
  for (const e of input) {
    if (!e || typeof e !== 'object') continue
    const obj = e as { address?: unknown; percentAllocation?: unknown }
    if (typeof obj.address !== 'string' || !isAddress(obj.address)) continue
    if (
      typeof obj.percentAllocation !== 'number' ||
      !Number.isFinite(obj.percentAllocation)
    ) {
      continue
    }
    out.push({
      address: obj.address.toLowerCase(),
      percentAllocation: obj.percentAllocation,
    })
  }
  return out
}

type ValidateSplitsResult =
  | { ok: true; splits: SplitRecipient[] }
  | { ok: false; error: string }

interface ValidateOptions {
  // Mint flow rejects fractional allocations (inprocess scales them to
  // SplitMain's 1e6 base); admin backfill accepts fractional precision
  // since off-chain records may carry sub-percent values.
  requireIntegerPercents?: boolean
}

// Returns the normalized recipient array sorted ascending by address
// (SplitMain's required ordering) or an error on the first violation.
export function validateSplitsArray(
  raw: unknown,
  { requireIntegerPercents = true }: ValidateOptions = {},
): ValidateSplitsResult {
  if (!Array.isArray(raw)) return { ok: false, error: 'splits must be an array' }
  if (raw.length < 2) return { ok: false, error: 'splits require at least 2 recipients' }
  if (raw.length > MAX_SPLITS) {
    return { ok: false, error: `splits cannot exceed ${MAX_SPLITS} recipients` }
  }

  const seen = new Set<string>()
  const normalized: SplitRecipient[] = []
  let sum = 0

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: 'invalid splits entry shape' }
    }
    const e = entry as { address?: unknown; percentAllocation?: unknown }
    if (typeof e.address !== 'string' || !isAddress(e.address)) {
      return { ok: false, error: 'invalid splits address' }
    }
    const pct = e.percentAllocation
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0 || pct > 100) {
      return { ok: false, error: 'splits allocation must be 1–100' }
    }
    if (requireIntegerPercents && !Number.isInteger(pct)) {
      return { ok: false, error: 'splits allocation must be a whole number 1–100' }
    }
    const lower = e.address.toLowerCase()
    if (seen.has(lower)) {
      return { ok: false, error: `duplicate splits address ${e.address}` }
    }
    seen.add(lower)
    sum += pct
    normalized.push({ address: e.address, percentAllocation: pct })
  }

  const sumOk = requireIntegerPercents ? sum === 100 : Math.round(sum) === 100
  if (!sumOk) {
    return { ok: false, error: `splits must sum to 100% (got ${sum})` }
  }

  normalized.sort((a, b) =>
    a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
  )
  return { ok: true, splits: normalized }
}
