// Guards the cross-reload upload-persistence layer (lib/arweave/uploadPersistence)
// that prevents Arweave credit waste — re-uploading byte-identical data under a
// fresh Turbo txid on every page reload.
//
// THE REGRESSION CLASS IT GUARDS: an upload banked only in an in-memory ref
// re-bills every reload (data-item ids hash a salted signature, so identical
// bytes never reuse an id). That's the exact bug fixed in 70d7d4c / bd8964c —
// the JSON metadata had no localStorage store while the cover did. Two layers:
//   1. behavioural — the store round-trips, retires after N strikes, is
//      LRU-capped + TTL'd, and drops corrupt/foreign records;
//   2. wiring/parity — BOTH the mint and create flows (and the edit flow) wire
//      the persistence helpers + stall detection, so an edit can't silently
//      re-introduce the asymmetry that wasted credits.
//
// Run: node --experimental-strip-types scripts/verify-persistence.ts

import { readFileSync } from 'node:fs'

// Minimal in-memory localStorage so the browser-targeted module runs in node.
// The module only touches localStorage inside its functions (guarded by a
// typeof check), so importing it before this shim is set is safe.
const mem = new Map<string, string>()
const shim: Storage = {
  get length() {
    return mem.size
  },
  clear: () => mem.clear(),
  getItem: (k) => (mem.has(k) ? mem.get(k)! : null),
  key: (i) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k) => {
    mem.delete(k)
  },
  setItem: (k, v) => {
    mem.set(k, v)
  },
}
globalThis.localStorage = shim

const {
  savePersistedJson,
  loadPersistedJson,
  savePersistedCover,
  loadPersistedCover,
} = await import('../lib/arweave/uploadPersistence.ts')

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const JSON_STORE = 'kismet:json-resume:v1'
// File identity is name|size|lastModified — a plain shape is enough for the key.
const fileLike = (name: string): File => ({ name, size: 1, lastModified: 1 }) as unknown as File

// ── behavioural: JSON store ──────────────────────────────────────────────────
mem.clear()
savePersistedJson('k1', { uri: 'ar://abc', failures: 0 })
const j = loadPersistedJson('k1')
check('json round-trips', j?.uri === 'ar://abc' && j?.failures === 0, JSON.stringify(j))

savePersistedJson('k1', { uri: 'ar://abc', failures: 2 })
check('json strike persists across save', loadPersistedJson('k1')?.failures === 2)

check('json miss -> null', loadPersistedJson('absent') === null)

// LRU cap (MAX_ENTRIES=3): saving a 4th evicts the oldest, newest-first.
mem.clear()
for (const k of ['a', 'b', 'c', 'd']) savePersistedJson(k, { uri: `ar://${k}`, failures: 0 })
check('LRU keeps newest 3', loadPersistedJson('d') !== null && loadPersistedJson('b') !== null)
check('LRU evicts oldest', loadPersistedJson('a') === null)

// TTL: an entry older than 7 days is dropped on read.
mem.clear()
const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
mem.set(JSON_STORE, JSON.stringify([{ key: 'old', savedAt: eightDaysAgo, uri: 'ar://o', failures: 0 }]))
check('TTL drops a stale entry', loadPersistedJson('old') === null)

// Robustness: corrupt JSON and partial records never throw, just drop.
mem.clear()
mem.set(JSON_STORE, 'not-json{')
check('corrupt store -> null (no throw)', loadPersistedJson('x') === null)
mem.set(JSON_STORE, JSON.stringify([{ key: 'k', savedAt: Date.now() }]))
check('partial record (no uri/failures) dropped', loadPersistedJson('k') === null)

// ── behavioural: store independence (the cover↔json asymmetry that caused it) ─
mem.clear()
savePersistedCover(fileLike('cover.png'), { imageUri: 'ar://cov', thumbhash: null, verifyFailures: 0 })
check('cover round-trips', loadPersistedCover(fileLike('cover.png'))?.imageUri === 'ar://cov')
check('stores are independent (cover write not visible to json)', loadPersistedJson('cover.png') === null)

// ── wiring / parity: both flows must persist JSON AND detect stalls ───────────
const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8')
const mintSrc = read('../components/MintForm.tsx')
const createSrc = read('../components/CreateCollectionForm.tsx')
const editSrc = read('../components/EditCollectionForm.tsx')

const wiresJson = (s: string): boolean => /loadPersistedJson/.test(s) && /savePersistedJson/.test(s)
const wiresStall = (s: string): boolean => /isChainStalled/.test(s) && /toastChainStalled/.test(s)

check('mint flow wires JSON persistence', wiresJson(mintSrc))
check('create flow wires JSON persistence', wiresJson(createSrc))
check('edit flow wires JSON persistence', wiresJson(editSrc))
check('mint flow persists media uploads', /savePersistedUpload/.test(mintSrc) && /loadPersistedUpload/.test(mintSrc))
check('create flow persists cover uploads', /savePersistedCover/.test(createSrc) && /loadPersistedCover/.test(createSrc))
check('edit flow persists cover uploads', /savePersistedCover/.test(editSrc) && /loadPersistedCover/.test(editSrc))
check('mint flow detects chain stalls', wiresStall(mintSrc))
check('create flow detects chain stalls', wiresStall(createSrc))

if (failures > 0) {
  console.error(`\n${failures} persistence check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll persistence checks passed.')
