/**
 * Collector-file core oracle (lib/collectorFileCore) — run via
 * `npm run verify:collector-file` (wired into verify:flows).
 *
 * THE FIRST ASSERTIONS PIN THE CHUNK CODEC + STORAGE MATH: chunks must stay
 * under Upstash's 10 MB per-request cap, must never be parseable as JSON by
 * the SDK's auto-deserialization, and cfileStoredBytes must equal the real
 * encoded lengths or the storage-ceiling ledger lies. The retention planner
 * is pinned next — a drift there either strands chunk keys (storage leak)
 * or deletes bytes a live version still points at.
 */
import assert from 'node:assert/strict'
import {
  CFILE_BYTES_RETENTION,
  CFILE_CHUNK_BYTES,
  CFILE_HISTORY_CAP,
  CFILE_KINDS,
  CFILE_VIEWABLE_KINDS,
  cfileChunkCount,
  cfileRef,
  cfileStoredBytes,
  decodeCfileChunks,
  detectCfileKind,
  encodeCfileChunks,
  isCfileVersionRestorable,
  isViewableCfileKind,
  normalizeCfileName,
  planAttach,
  planDetach,
  planRollback,
  sha256Hex,
  storedBlobRefs,
  type CfileRecord,
} from '../lib/collectorFileCore.ts'

const COLLECTION = '0x00000000000000000000000000000000000000AB'

// ---- 1. Chunk codec: round-trip, caps, JSON-safety -----------------------
for (const size of [1, 2, 3, 4, CFILE_CHUNK_BYTES - 1, CFILE_CHUNK_BYTES, CFILE_CHUNK_BYTES + 1, 2 * CFILE_CHUNK_BYTES + 2]) {
  const data = Buffer.alloc(size)
  for (let i = 0; i < size; i += 4096) data[i] = (i / 4096) % 251
  const chunks = encodeCfileChunks(data)
  assert.equal(chunks.length, cfileChunkCount(size), `chunk count drifted at size ${size}`)
  assert.deepEqual(decodeCfileChunks(chunks, size), data, `round-trip failed at size ${size}`)
  assert.equal(
    chunks.reduce((s, c) => s + c.length, 0),
    cfileStoredBytes(size),
    `cfileStoredBytes lies at size ${size} — the ceiling ledger would drift`,
  )
  for (const c of chunks) {
    // Upstash rejects requests over 10MB; leave real headroom for envelope.
    assert.ok(c.length < 6 * 1024 * 1024, `encoded chunk ${c.length}B breaches the request-cap margin`)
    // The SDK JSON-parses GET replies — the prefix must make that impossible.
    assert.throws(() => JSON.parse(c), `chunk parseable as JSON — a digit-only chunk would corrupt`)
  }
}
// Tampering that changes reassembled length is rejected.
const tamperData = Buffer.alloc(CFILE_CHUNK_BYTES + 10, 3)
const tamperChunks = encodeCfileChunks(tamperData)
assert.throws(() => decodeCfileChunks(tamperChunks.slice(0, 1), tamperData.length), 'missing chunk accepted')
assert.throws(() => decodeCfileChunks(['x' + tamperChunks[0].slice(1), tamperChunks[1]], tamperData.length), 'bad prefix accepted')

// ---- 2. Ref canonicalization ---------------------------------------------
assert.equal(cfileRef(COLLECTION, '01'), cfileRef(COLLECTION, '1'), '"01" forked a second ref')
assert.equal(cfileRef(COLLECTION, '1'), `${COLLECTION.toLowerCase()}:1`)

// ---- 3. Filename hygiene -------------------------------------------------
assert.equal(normalizeCfileName('Pixel Art Gallery - Sylvester.zip'), 'Pixel Art Gallery - Sylvester.zip')
// The DETECTED kind forces the extension — the claimed one is stripped, so
// name, bytes and Content-Type can never disagree.
assert.equal(normalizeCfileName('gallery.pdf', 'pdf'), 'gallery.pdf')
assert.equal(normalizeCfileName('sylvester.glb', 'glb'), 'sylvester.glb')
assert.equal(normalizeCfileName('model.glb', 'pdf'), 'model.pdf', 'claimed ext must yield to detected kind')
assert.equal(normalizeCfileName('notes.pdf', 'zip'), 'notes.zip', 'claimed ext must yield to detected kind')
assert.equal(normalizeCfileName('', 'glb'), 'collector-file.glb')
assert.equal(normalizeCfileName('logo.svg', 'svg'), 'logo.svg')
assert.equal(normalizeCfileName('logo.svg', 'zip'), 'logo.zip', 'claimed ext must yield to detected kind')
// Header-injection material is stripped; terminal .zip is forced.
assert.equal(normalizeCfileName('a"; filename*=UTF-8\'\'payload.exe'), 'a filenameUTF-8payload.exe.zip')
assert.ok(!normalizeCfileName('x\r\nSet-Cookie: a=b.zip').includes('\r'), 'CR survived')
assert.ok(!normalizeCfileName('x\r\nSet-Cookie: a=b.zip').includes('\n'), 'LF survived')
// Bidi override (U+202E) can't survive to re-order the extension visually.
assert.ok(!normalizeCfileName('gallery‮bg.exe.zip').includes('‮'), 'bidi override survived')
// Double extension gets .zip forced on the end; hidden-file dots trimmed.
assert.equal(normalizeCfileName('invoice.pdf.exe'), 'invoice.pdf.exe.zip')
assert.ok(!normalizeCfileName('...hidden.zip').startsWith('.'), 'leading dots survived')
assert.equal(normalizeCfileName(''), 'collector-file.zip')
assert.equal(normalizeCfileName(null), 'collector-file.zip')
assert.ok(normalizeCfileName('x'.repeat(500) + '.zip').length <= 64, 'length cap failed')

// ---- 4. Format detection (magic bytes ONLY — never claimed extension) ----
assert.equal(detectCfileKind(Buffer.from('PK\x03\x04rest')), 'zip')
assert.equal(detectCfileKind(Buffer.from('%PDF-1.7\n%…')), 'pdf')
// Binary glTF: magic 0x46546C67 LE = ASCII "glTF" (IANA model/gltf-binary).
assert.equal(detectCfileKind(Buffer.from('glTF\x02\x00\x00\x00rest')), 'glb')
assert.equal(Buffer.from(CFILE_KINDS.glb.magic!).readUInt32LE(0), 0x46546c67, 'GLB magic drifted from spec')
assert.equal(detectCfileKind(Buffer.from('PK\x05\x06')), null, 'empty archive accepted') // empty central dir
assert.equal(detectCfileKind(Buffer.from('MZ\x90\x00')), null, 'PE binary accepted')
assert.equal(detectCfileKind(Buffer.from('%PDF')), null, 'truncated PDF header accepted')
assert.equal(detectCfileKind(Buffer.alloc(2)), null)
// ---- 4b. SVG: the one TEXT-sniffed kind -----------------------------------
// SVG has no fixed-offset signature, so it is detected by a bounded text
// sniff that runs ONLY after every binary matcher fails. These are the real
// preambles Inkscape/Illustrator/Figma emit — a regression here silently
// rejects legitimate vector uploads.
assert.equal(CFILE_KINDS.svg.magic, undefined, 'SVG must have no magic bytes')
const SVG_OK = [
  '<svg xmlns="http://www.w3.org/2000/svg"/>',
  '<?xml version="1.0" encoding="UTF-8"?>\n<svg width="10"/>',
  '<?xml version="1.0"?>\n<!-- Generator: Adobe Illustrator 27.0 -->\n<svg viewBox="0 0 1 1"/>',
  '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg/>',
  '\n\n   <svg/>',
  '<svg\n  xmlns="http://www.w3.org/2000/svg"/>',
]
for (const src of SVG_OK) {
  assert.equal(detectCfileKind(Buffer.from(src)), 'svg', `SVG preamble rejected: ${src.slice(0, 32)}`)
  // A UTF-8 BOM must not change the verdict.
  assert.equal(detectCfileKind(Buffer.from('\ufeff' + src)), 'svg', 'BOM-prefixed SVG rejected')
}
const SVG_NOT = [
  '<html><body>x',            // markup, not SVG
  '<?xml version="1.0"?><rss/>', // XML, not SVG
  '<svgfoo/>',                // different element with an svg prefix
  '<SVG/>',                   // XML is case-sensitive; would not parse anyway
  'hello world',
  '<?xml version',            // unterminated processing instruction
]
for (const src of SVG_NOT) {
  assert.equal(detectCfileKind(Buffer.from(src)), null, `non-SVG accepted: ${src.slice(0, 24)}`)
}
// Binary signatures WIN over the text sniff — a zip whose bytes happen to
// contain markup is still a zip.
assert.equal(detectCfileKind(Buffer.from('PK\x03\x04<svg')), 'zip', 'text sniff overrode zip magic')
assert.equal(detectCfileKind(Buffer.from('%PDF-<svg')), 'pdf', 'text sniff overrode pdf magic')
// The sniff is BOUNDED: a root element pushed past the scan window is not
// accepted (a crafted file must not make us scan megabytes).
assert.equal(detectCfileKind(Buffer.from('<!--' + 'x'.repeat(8000) + '--><svg/>')), null, 'sniff scanned past its bound')

// ---- 4c. Viewability + served Content-Types (immutable contracts) ---------
assert.deepEqual([...CFILE_VIEWABLE_KINDS].sort(), ['glb', 'svg'], 'viewable set drifted')
assert.ok(isViewableCfileKind('glb') && isViewableCfileKind('svg'))
// PDF/zip must NOT be viewable: the view route has no attachment semantics
// for a save dialog, and PDF viewing was deliberately deferred (pdf.js).
assert.ok(!isViewableCfileKind('pdf'), 'pdf became viewable without a viewer')
assert.ok(!isViewableCfileKind('zip'), 'zip became viewable')
assert.ok(!isViewableCfileKind(undefined), 'legacy (kind-less) record became viewable')
assert.equal(CFILE_KINDS.zip.mime, 'application/zip')
assert.equal(CFILE_KINDS.pdf.mime, 'application/pdf')
assert.equal(CFILE_KINDS.glb.mime, 'model/gltf-binary')
assert.equal(CFILE_KINDS.svg.mime, 'image/svg+xml')

// ---- 5. Version planning: attach, dedup, retention -----------------------
const now = 1_756_000_000_000
const plaintext = Buffer.from('PK\x03\x04 pretend rom bytes '.repeat(64))
const base = (over: Partial<Parameters<typeof planAttach>[1]> = {}) => ({
  size: plaintext.length,
  sha256: sha256Hex(plaintext),
  kind: 'zip' as const,
  name: 'a.zip',
  updatedBy: '0xArtist',
  now,
  ...over,
})

const first = planAttach(null, base())
assert.ok(first, 'first attach refused')
assert.equal(first.version.v, 1)
assert.equal(first.version.blobSeq, 1)
assert.equal(first.version.chunks, cfileChunkCount(plaintext.length))
assert.ok(first.version.stored, 'new version not marked stored')
assert.equal(first.record.nextBlobSeq, 2)
assert.deepEqual(first.prune, [], 'first attach pruned something')

// Same bytes again → null (no version, no meters, no cooldown burn).
assert.equal(planAttach(first.record, base()), null, 'same-sha replace not deduped')

const second = planAttach(first.record, base({ sha256: 'different', kind: 'glb', name: 'model.glb' }))
assert.ok(second)
assert.equal(second.version.v, 2)
assert.equal(second.version.kind, 'glb', 'kind not stored on the version')
assert.equal(second.record.history[0].kind, 'zip', 'history row lost its kind')
assert.equal(second.version.blobSeq, 2, 'blobSeq not sequenced')
assert.equal(second.record.history[0].v, 1, 'superseded version not in history')
assert.ok(second.record.history[0].stored, 'previous version lost its bytes inside the window')
assert.deepEqual(second.prune, [], 'pruned inside the retention window')

// Fill the window (v1..v3 stored), then one more: the OLDEST blob falls out.
const third = planAttach(second.record, base({ sha256: 'third' }))
assert.ok(third)
assert.equal([...storedBlobRefs(third.record)].length, CFILE_BYTES_RETENTION, 'window overfilled')
const fourth = planAttach(third.record, base({ sha256: 'fourth' }))
assert.ok(fourth)
assert.deepEqual(fourth.prune, [{ blobSeq: 1, chunks: cfileChunkCount(plaintext.length) }], 'oldest blob not pruned')
assert.ok(!fourth.record.history.find((h) => h.v === 1)?.stored, 'pruned version still flagged stored')
assert.ok(isCfileVersionRestorable(fourth.record, 3), 'in-window version not restorable')
assert.ok(!isCfileVersionRestorable(fourth.record, 1), 'out-of-window version claims restorable')

// Ledger math counts DISTINCT stored blobs only.
assert.equal(
  [...storedBlobRefs(fourth.record)].length * cfileStoredBytes(plaintext.length) >= cfileStoredBytes(plaintext.length),
  true,
)

// ---- 6. Rollback: re-points, never prunes, refuses gone bytes ------------
const rolled = planRollback(fourth.record, 3, '0xArtist', now + 1)
assert.ok(rolled, 'rollback refused')
assert.equal(rolled.record.current?.v, 5)
assert.equal(rolled.record.current?.blobSeq, 3, 'rollback lost the original blobSeq')
assert.equal(rolled.record.nextBlobSeq, 5, 'rollback must not consume a blob seq')
assert.deepEqual(rolled.prune, [], 'rollback pruned — it must never')
assert.deepEqual(
  [...storedBlobRefs(rolled.record)].map(([s]) => s).sort(),
  [...storedBlobRefs(fourth.record)].map(([s]) => s).sort(),
  'rollback changed the stored set',
)
// Rollback to a version whose bytes are gone → null.
assert.equal(planRollback(fourth.record, 1, '0xArtist', now), null, 'rollback to pruned bytes allowed')
assert.equal(planRollback(fourth.record, 99, '0xArtist', now), null, 'unknown version rolled back')

// After a rollback the next attach still mints a FRESH blobSeq.
const fifth = planAttach(rolled.record, base({ sha256: 'fifth' }))
assert.ok(fifth)
assert.equal(fifth.version.blobSeq, 5, 'blobSeq reused after rollback')

// Rollback-duplicated rows share one blobSeq — the ledger must count it once:
// stored set size stays ≤ retention even though rows duplicate.
assert.ok([...storedBlobRefs(fifth.record)].length <= CFILE_BYTES_RETENTION)

// ---- 7. Detach frees everything; nothing is restorable after -------------
const detached = planDetach(fifth.record)
assert.equal(detached.record.current, null)
assert.equal([...storedBlobRefs(detached.record)].length, 0, 'detach left stored flags')
assert.equal(detached.prune.length, CFILE_BYTES_RETENTION, 'detach did not free every stored blob')
assert.ok(detached.record.history.length > 0, 'detach erased the history record')
assert.ok(!detached.record.history.some((h) => isCfileVersionRestorable(detached.record, h.v)), 'restorable after detach')

// Re-attach after detach: old rows stay byte-less (bytes never come back by
// reordering), only the new blob is stored.
const reattached = planAttach(detached.record, base({ sha256: 'reborn' }))
assert.ok(reattached)
assert.deepEqual([...storedBlobRefs(reattached.record)].map(([s]) => s), [reattached.version.blobSeq])
assert.deepEqual(reattached.prune, [], 're-attach pruned already-freed blobs')

// ---- 8. History cap + blobSeq monotonicity under churn -------------------
let record: CfileRecord | null = null
for (let i = 0; i < CFILE_HISTORY_CAP + 8; i++) {
  const next = planAttach(record, base({ sha256: `sha${i}` }))
  assert.ok(next)
  record = next.record
}
assert.equal(record!.history.length, CFILE_HISTORY_CAP, 'history cap not enforced')
assert.equal(
  record!.nextBlobSeq,
  CFILE_HISTORY_CAP + 9,
  'nextBlobSeq must survive history trimming (trimmed rows are not the ledger)',
)
assert.equal([...storedBlobRefs(record!)].length, CFILE_BYTES_RETENTION, 'churn broke the retention window')

console.log('verify-collector-file: all assertions passed')
