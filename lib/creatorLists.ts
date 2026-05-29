import { redis } from './redis'
import { isAddress } from './address'

const KEY = 'kismetart:creator-lists'

export interface CreatorList {
  slug: string
  name: string
  // Lowercased EOA addresses. Order is preserved from the curator's input
  // so the homepage roster can render in the order they were added.
  addresses: string[]
  // Optional source collection (lowercased). When set, the artists tab shows
  // each listed artist's mint *in this collection* (one card per artist).
  // When absent, the tab falls back to each artist's most recent mint.
  collection?: string
  createdAt: number
  updatedAt: number
}

// Stored shape (slug lives in the hash field, not duplicated in the value).
type StoredList = Omit<CreatorList, 'slug'>

/**
 * Slug derivation from a free-form name: lowercase, replace runs of
 * non-alphanumerics with single hyphens, strip leading/trailing hyphens,
 * cap at 64 chars. Returns null if nothing usable remains (name was all
 * special chars). Callers should reject creation in that case rather
 * than write an empty-slug list.
 */
export function slugify(name: string): string | null {
  const s = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return s.length > 0 ? s : null
}

function parseStored(raw: unknown): StoredList | null {
  if (raw == null) return null
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw as StoredList)
    if (!parsed || typeof parsed !== 'object') return null
    const obj = parsed as Partial<StoredList>
    if (typeof obj.name !== 'string' || !Array.isArray(obj.addresses)) return null
    const collection =
      typeof obj.collection === 'string' && isAddress(obj.collection.toLowerCase())
        ? obj.collection.toLowerCase()
        : undefined
    return {
      name: obj.name,
      addresses: obj.addresses.filter((a): a is string => typeof a === 'string'),
      ...(collection ? { collection } : {}),
      createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : 0,
      updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : 0,
    }
  } catch {
    return null
  }
}

/**
 * Return every creator list. Public — there's no draft/published split;
 * lists are visible the moment they're saved. Order is by createdAt so
 * the dropdown shows the oldest list first (stable identity for the
 * default "first list shown" behaviour). Callers wanting a specific
 * sort can re-order client-side.
 */
export async function getAllCreatorLists(): Promise<CreatorList[]> {
  try {
    const raw = (await redis.hgetall(KEY)) as Record<string, unknown> | null
    if (!raw) return []
    const lists: CreatorList[] = []
    for (const [slug, value] of Object.entries(raw)) {
      const stored = parseStored(value)
      if (stored) lists.push({ slug, ...stored })
    }
    lists.sort((a, b) => a.createdAt - b.createdAt)
    return lists
  } catch {
    return []
  }
}

/**
 * Create or replace a list. Address normalization happens here (lowercase,
 * deduplicate, drop non-EOA strings) so the API route doesn't need to
 * re-validate. Preserves createdAt on update so list identity stays
 * stable; updatedAt always refreshes.
 */
export async function saveCreatorList(input: {
  slug: string
  name: string
  addresses: string[]
  collection?: string
}): Promise<CreatorList> {
  const seen = new Set<string>()
  const addresses: string[] = []
  for (const a of input.addresses) {
    if (typeof a !== 'string') continue
    const lower = a.toLowerCase()
    if (!isAddress(lower) || seen.has(lower)) continue
    seen.add(lower)
    addresses.push(lower)
  }

  // Optional source collection. Invalid / empty → unset (drops any prior one),
  // so clearing the field in the editor reverts the list to the fallback feed.
  const collection =
    typeof input.collection === 'string' && isAddress(input.collection.toLowerCase())
      ? input.collection.toLowerCase()
      : undefined

  // Re-read just this slug to preserve createdAt across updates without
  // pulling the entire hash on every save.
  let existing: CreatorList | null = null
  try {
    const raw = await redis.hget(KEY, input.slug)
    const stored = parseStored(raw)
    if (stored) existing = { slug: input.slug, ...stored }
  } catch {
    // Treat read failure as "no prior entry" — saveCreatorList still
    // writes the new value; only createdAt drifts to now.
  }
  const now = Date.now()
  const next: CreatorList = {
    slug: input.slug,
    name: input.name.trim().slice(0, 80),
    addresses,
    ...(collection ? { collection } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  const stored: StoredList = {
    name: next.name,
    addresses: next.addresses,
    ...(collection ? { collection } : {}),
    createdAt: next.createdAt,
    updatedAt: next.updatedAt,
  }
  await redis.hset(KEY, { [next.slug]: JSON.stringify(stored) })
  return next
}

export async function deleteCreatorList(slug: string): Promise<boolean> {
  try {
    const removed = await redis.hdel(KEY, slug)
    return Number(removed) > 0
  } catch {
    return false
  }
}
