import type { MomentCollectRecord } from './collected'
import {
  DEFAULT_COLLECT_COMMENT,
  isFoldedActivityRow,
  isPlatformCollectComment,
  normalizeTimestampMs,
  type MomentComment,
} from './inprocess'

/**
 * How far apart (ms) an upstream collect row and a Kismet collect record for
 * the SAME sender may sit and still be read as one mint. Upstream rows come
 * from In Process's indexer, which stamps the MintComment event; Kismet's
 * record carries the mint's block time (or, for a legacy verdict, the record
 * time — seconds to minutes after the block). Generous, so an indexer that
 * stamps late can't produce a duplicate row; the cost is that one collector
 * minting the same piece twice inside the window, with only one of the two
 * indexed upstream, shows one row until the other is indexed.
 */
export const KISMET_COLLECT_MATCH_WINDOW_MS = 6 * 60 * 60 * 1000

/**
 * The activity rows to ADD to page 0 for the collects Kismet recorded that
 * the upstream feed has no row for. Pure — the comments route feeds it the
 * normalized (already hidden-user-filtered) upstream page and the artwork's
 * collect log (lib/collected.getMomentCollects) and merges what comes back.
 *
 * Matching is one-to-one, nearest pair first: within each sender, every
 * (record, upstream MINT-TIME row) pair inside the window is a candidate,
 * the closest pairs are claimed first, and each row and each record is
 * claimed at most once (post-collect comments — `commentId` set — are never
 * candidates: they are not mints). Only a record that claims nothing becomes
 * a row. So a collector who minted twice gets two rows whether upstream
 * indexed both, one, or neither; when it indexed one, the mint it indexed is
 * the one that stays hidden; and a mint whose upstream row exists is never
 * shown twice.
 *
 * The fold only ever sees page 0 of the upstream feed, so it can only dedupe
 * against page 0. When that page is FULL (`pageFull` — the route's hasMore),
 * a record older than the page's oldest row would have its upstream row, if
 * any, on a later page the fold can't see; folding it would show the same
 * mint twice once the viewer loads more. Such records are skipped — page 0
 * folds only what page 0 can vouch for. When the page is not full, upstream
 * is fully known and every unmatched record folds.
 *
 * Hidden collectors are dropped here the way the route drops their upstream
 * rows — the fold must not resurface a moderated identity.
 */
export function foldKismetCollects(
  upstream: MomentComment[],
  records: MomentCollectRecord[],
  hiddenUsers: Set<string>,
  opts: { pageFull?: boolean } = {},
): MomentComment[] {
  // Upstream mint-time rows per sender, as ms instants — and the page's
  // pagination horizon (its oldest upstream row of any kind).
  const candidates = new Map<string, number[]>()
  let oldestUpstream = Infinity
  for (const row of upstream) {
    if (isFoldedActivityRow(row)) continue
    const ts = normalizeTimestampMs(row.timestamp)
    if (!Number.isFinite(ts)) continue
    if (ts < oldestUpstream) oldestUpstream = ts
    if ((row as { commentId?: unknown }).commentId != null) continue
    const sender = row.sender.toLowerCase()
    const list = candidates.get(sender) ?? []
    list.push(ts)
    candidates.set(sender, list)
  }
  const horizon = opts.pageFull && Number.isFinite(oldestUpstream) ? oldestUpstream : -Infinity

  // The records worth considering, per sender, in their given order.
  const bySender = new Map<string, MomentCollectRecord[]>()
  const seenTx = new Set<string>()
  const eligible: MomentCollectRecord[] = []
  for (const record of records) {
    const collector = record.collector.toLowerCase()
    if (hiddenUsers.has(collector)) continue
    if (record.timestamp < horizon) continue
    // The log's members are deterministic per (tx, collector), so a duplicate
    // here would mean two members for one mint — defensive, cheap.
    const txKey = `${record.txHash.toLowerCase()}:${collector}`
    if (seenTx.has(txKey)) continue
    seenTx.add(txKey)
    eligible.push(record)
    const list = bySender.get(collector) ?? []
    list.push(record)
    bySender.set(collector, list)
  }

  // Claim nearest pairs first, per sender.
  const claimed = new Set<MomentCollectRecord>()
  for (const [sender, recs] of bySender) {
    const rows = candidates.get(sender)
    if (!rows || rows.length === 0) continue
    const pairs: { record: MomentCollectRecord; row: number; distance: number }[] = []
    for (const record of recs) {
      for (let i = 0; i < rows.length; i++) {
        const distance = Math.abs(rows[i] - record.timestamp)
        if (distance <= KISMET_COLLECT_MATCH_WINDOW_MS) pairs.push({ record, row: i, distance })
      }
    }
    pairs.sort((a, b) => a.distance - b.distance)
    const usedRows = new Set<number>()
    for (const pair of pairs) {
      if (claimed.has(pair.record) || usedRows.has(pair.row)) continue
      claimed.add(pair.record)
      usedRows.add(pair.row)
    }
  }

  const out: MomentComment[] = []
  for (const record of eligible) {
    if (claimed.has(record)) continue
    out.push({
      sender: record.collector,
      comment:
        record.comment && !isPlatformCollectComment(record.comment)
          ? record.comment
          : DEFAULT_COLLECT_COMMENT,
      timestamp: record.timestamp,
      kind: 'kismet-collect',
    })
  }
  return out
}
