import { redis } from './redis'
import { getUserCollections, getCollectionMetaBatch } from './kv'
import { getMomentMetaBatch, setMomentMeta } from './notifications'

// Bump the version suffix if the backfill logic itself ever needs to
// re-run across the fleet (e.g., schema change to MomentMeta).
const DONE_KEY = 'kismetart:backfill:cover-momentmeta:v1'

/**
 * Backfill setMomentMeta for cover-mint moments deployed before
 * /api/collections POST started writing the per-moment KV creator
 * record alongside markCreatedMint.
 *
 * Why: the timeline route's KV stitching reads MomentMeta to override
 * the wrong creator.address inprocess returns for cover mints (the
 * deploy runs through the factory, so inprocess attributes the cover
 * token to the factory or smart-wallet address instead of the artist
 * EOA). Without the stitch, the cover moment doesn't match any
 * creator-keyed filter — artist disappears from the artists tab + their
 * profile feed.
 *
 * Gated by a Redis marker so the first pod to run it across the fleet
 * does the writes; subsequent boots short-circuit on a single GET.
 * Inside a run, idempotent — only writes entries where the key is
 * missing, so a partial-failure retry on the next boot picks up
 * exactly the unfinished work.
 *
 * Once every existing cover-mint has its record, this file can be
 * deleted (the forward fix in /api/collections POST handles all new
 * deploys). Until then, leave it in place — the steady-state cost is
 * a single Redis GET on cold start.
 */
export async function backfillCoverMomentMeta(): Promise<void> {
  const done = await redis.get(DONE_KEY).catch(() => null)
  if (done) return

  const userCreated = await getUserCollections()
  if (userCreated.length === 0) {
    await redis.set(DONE_KEY, '1').catch(() => {})
    return
  }

  const metas = await getCollectionMetaBatch(userCreated)

  // Pair every cover-mint collection with the tokenId that needs a
  // per-moment record. Drop entries missing `artist` (records written
  // before the artist field existed) or `coverTokenId` (no cover-mint
  // at deploy).
  const candidates: { address: string; tokenId: string; creator: string; name: string }[] = []
  for (const [addr, meta] of metas) {
    if (!meta.coverTokenId || !meta.artist) continue
    if (!/^\d+$/.test(meta.coverTokenId)) continue
    candidates.push({
      address: addr,
      tokenId: meta.coverTokenId,
      creator: meta.artist,
      name: meta.name,
    })
  }
  if (candidates.length === 0) {
    await redis.set(DONE_KEY, '1').catch(() => {})
    return
  }

  // MGET to find which ones already have a record; skip those so a
  // manually-corrected entry isn't overwritten with the deploy-time
  // defaults.
  const existing = await getMomentMetaBatch(candidates)
  const missing = candidates.filter((_, i) => !existing[i]?.creator)
  if (missing.length === 0) {
    await redis.set(DONE_KEY, '1').catch(() => {})
    return
  }

  let failed = 0
  await Promise.all(
    missing.map((c) =>
      setMomentMeta(c.address, c.tokenId, { creator: c.creator, name: c.name }).catch(
        (err) => {
          failed++
          console.error('[backfill-cover-momentmeta] write failed', {
            address: c.address,
            tokenId: c.tokenId,
            err: err instanceof Error ? err.message : String(err),
          })
        },
      ),
    ),
  )

  console.log(
    `[backfill-cover-momentmeta] wrote ${missing.length - failed}/${missing.length} entries`,
  )

  // Only mark done if every write succeeded. A partial-failure run
  // leaves the marker unset so the next cold start finishes the
  // remainder; the missing-only filter at the top makes that safe.
  if (failed === 0) {
    await redis.set(DONE_KEY, '1').catch(() => {})
  }
}
