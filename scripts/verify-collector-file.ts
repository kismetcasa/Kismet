/**
 * Collector-file core oracle (lib/collectorFileCore) — run via
 * `npm run verify:collector-file` (wired into verify:flows).
 *
 * THE FIRST ASSERTION IS A KNOWN-ANSWER TEST over the key derivation:
 * ciphertexts on Arweave are permanent, so any drift in the HKDF salt/info
 * or the AAD format bricks every previously-uploaded version unrecoverably.
 * A failure here is a release blocker, not a flake
 * (COLLECTOR_DOWNLOADS_DESIGN.md §3.2).
 */
import assert from 'node:assert/strict'
import {
  CFILE_HISTORY_CAP,
  cfileAad,
  cfileKeyId,
  cfileRef,
  deriveCfileKey,
  looksLikeZip,
  normalizeCfileName,
  openCfile,
  planAttach,
  planRollback,
  sealCfile,
  sha256Hex,
  type CfileRecord,
} from '../lib/collectorFileCore.ts'

const MASTER = Buffer.alloc(32, 7).toString('base64')
const COLLECTION = '0x00000000000000000000000000000000000000AB'
const KEY_ID = cfileKeyId(COLLECTION, '1', 1)

// ---- 1. Known-answer pin: the unrepairable invariant --------------------
assert.equal(KEY_ID, '0x00000000000000000000000000000000000000ab:1:1', 'keyId format drifted')
assert.equal(
  deriveCfileKey(MASTER, KEY_ID).toString('hex'),
  '4a711f4ce95288e46b9fc54c0971a64f9e3373a9d3d19ed754f2761c0e53d7ce',
  'HKDF derivation drifted — this would brick every existing ciphertext',
)
assert.equal(
  cfileAad(KEY_ID).toString(),
  'kismet-cfile-v1|0x00000000000000000000000000000000000000ab:1:1',
  'AAD format drifted — this would brick every existing ciphertext',
)

// ---- 2. Seal/open round-trip + tamper rejection -------------------------
const plaintext = Buffer.from('PK\x03\x04 pretend rom bytes '.repeat(64))
const { sealed } = sealCfile(MASTER, KEY_ID, plaintext)
assert.deepEqual(openCfile(MASTER, KEY_ID, sealed), plaintext, 'round-trip failed')

// Any flipped ciphertext byte must fail authentication.
const tampered = Buffer.from(sealed)
tampered[20] ^= 0xff
assert.throws(() => openCfile(MASTER, KEY_ID, tampered), 'tampered ciphertext decrypted')

// A pointer swapped to a different artwork slot (different keyId → different
// key AND different AAD) must never decrypt.
assert.throws(
  () => openCfile(MASTER, cfileKeyId(COLLECTION, '2', 1), sealed),
  'cross-artwork pointer swap decrypted',
)

// Truncated payloads are rejected, not sliced into garbage.
assert.throws(() => openCfile(MASTER, KEY_ID, sealed.subarray(0, 10)))

// ---- 3. Ref canonicalization -------------------------------------------
assert.equal(cfileRef(COLLECTION, '01'), cfileRef(COLLECTION, '1'), '"01" forked a second ref')
assert.equal(cfileRef(COLLECTION, '1'), `${COLLECTION.toLowerCase()}:1`)

// ---- 4. Filename hygiene ------------------------------------------------
assert.equal(normalizeCfileName('Pixel Art Gallery - Sylvester.zip'), 'Pixel Art Gallery - Sylvester.zip')
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

// ---- 5. Zip magic -------------------------------------------------------
assert.ok(looksLikeZip(Buffer.from('PK\x03\x04rest')))
assert.ok(!looksLikeZip(Buffer.from('PK\x05\x06')), 'empty archive accepted') // empty central dir
assert.ok(!looksLikeZip(Buffer.from('MZ\x90\x00')), 'PE binary accepted')
assert.ok(!looksLikeZip(Buffer.alloc(2)))

// ---- 6. Version planning: attach, dedup, rollback -----------------------
const now = 1_756_000_000_000
const base = (over: Partial<Parameters<typeof planAttach>[1]> = {}) => ({
  keyIdSeqRef: cfileRef(COLLECTION, '1'),
  uri: 'ar://tx1',
  iv: 'aXY=',
  size: plaintext.length,
  sha256: sha256Hex(plaintext),
  name: 'a.zip',
  updatedBy: '0xArtist',
  now,
  pending: false,
  ...over,
})

const first = planAttach(null, base())
assert.ok(first, 'first attach refused')
assert.equal(first.version.v, 1)
assert.equal(first.version.keyId, KEY_ID)
assert.equal(first.record.nextKeySeq, 2)
assert.equal(first.record.history.length, 0)

// Same bytes again → null (no version, no spend, no cooldown burn).
assert.equal(planAttach(first.record, base()), null, 'same-sha replace not deduped')

const second = planAttach(first.record, base({ uri: 'ar://tx2', sha256: 'different' }))
assert.ok(second)
assert.equal(second.version.v, 2)
assert.equal(second.version.keyId, cfileKeyId(COLLECTION, '1', 2), 'keyId not sequenced')
assert.equal(second.record.history[0].v, 1, 'superseded version not in history')

// Rollback revives v1 as v3 CARRYING ITS ORIGINAL keyId — the rev-1
// data-loss bug was deriving keys from the display version.
const rolled = planRollback(second.record, 1, '0xArtist', now + 1)
assert.ok(rolled, 'rollback refused')
assert.equal(rolled.current?.v, 3)
assert.equal(rolled.current?.keyId, KEY_ID, 'rollback lost the original keyId')
assert.equal(rolled.current?.uri, 'ar://tx1')
assert.equal(rolled.nextKeySeq, 3, 'rollback must not consume a key seq')
// …and the revived pointer actually decrypts the original ciphertext.
assert.deepEqual(openCfile(MASTER, rolled.current!.keyId, sealed), plaintext)

// Unknown version → null.
assert.equal(planRollback(second.record, 99, '0xArtist', now), null)

// After a rollback the next attach still mints a FRESH keyId (seq 3).
const third = planAttach(rolled, base({ uri: 'ar://tx3', sha256: 'yet-another' }))
assert.ok(third)
assert.equal(third.version.keyId, cfileKeyId(COLLECTION, '1', 3), 'keyId reused after rollback')
assert.equal(third.version.v, 4)

// ---- 7. History cap + keyId monotonicity under churn --------------------
let record: CfileRecord | null = null
for (let i = 0; i < CFILE_HISTORY_CAP + 8; i++) {
  const next = planAttach(record, base({ uri: `ar://tx${i}`, sha256: `sha${i}` }))
  assert.ok(next)
  record = next.record
}
assert.equal(record!.history.length, CFILE_HISTORY_CAP, 'history cap not enforced')
assert.equal(
  record!.nextKeySeq,
  CFILE_HISTORY_CAP + 9,
  'nextKeySeq must survive history trimming (trimmed keyIds are still live ciphertexts)',
)

console.log('verify-collector-file: all assertions passed')
