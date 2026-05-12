// Shared cache for /api/collections?address={address}. The endpoint returns
// the rich shape for platform-created (curator-blessed) collections and a
// stub for everything else, so `name === null` means "don't render the chip".
// Cards on the same feed often share a collection — without this they each
// fire their own lookup.

interface ChipMeta {
  name: string | null
  image: string | null
}

const cache = new Map<string, ChipMeta & { ts: number }>()
const TTL = 5 * 60 * 1000

export async function fetchCollectionChip(address: string): Promise<ChipMeta> {
  const key = address.toLowerCase()
  const cached = cache.get(key)
  if (cached && Date.now() - cached.ts < TTL) {
    return { name: cached.name, image: cached.image }
  }
  try {
    const res = await fetch(`/api/collections?address=${address}`)
    if (res.ok) {
      const data = await res.json()
      const name: string | null = data.metadata?.name ?? data.name ?? null
      const image: string | null = data.metadata?.image ?? null
      cache.set(key, { name, image, ts: Date.now() })
      return { name, image }
    }
  } catch {
    // Transient failure — fall through without caching so the next render retries.
  }
  return { name: null, image: null }
}
