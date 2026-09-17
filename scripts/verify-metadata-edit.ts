// Verifies the artwork metadata editor's pure core (lib/momentUriEdit) and the
// relay-surface invariant that keeps the 2026-09 incident from coming back.
//
// The incident: metadata edits relayed through inprocess's PATCH /moment under
// the platform API key. Since inprocess 2026-05-29 that endpoint executes as
// the KEY OWNER's smart wallet and fails ("No authorized smart wallet found
// for collection …") on every collection that never granted that wallet ADMIN
// — every first-mint collection — while Kismet's pencil + preflight had
// authorized the ARTIST's wallet. The edit is now a direct wallet write
// (hooks/useUpdateMomentUri) gated by the exact rows the contract checks.
//
//   1. COLLECTION_ABI's updateTokenURI fragment matches the Zora 1155 contract
//      signature `updateTokenURI(uint256,string)` selector-exact, and the
//      calldata decodes back through an INDEPENDENT human-readable ABI.
//   2. isMetadataUri admits only ar:// and https:// pointers (the surface the
//      retired server route enforced), never data:/blob:/javascript:/empty.
//   3. canEditMomentMetadata (the pencil's gate) is exactly ADMIN|METADATA —
//      the bits updateTokenURI's onlyAdminOrRole honors — and no other bit,
//      so the affordance can't outrun the on-chain write.
//   4. pickMetadataName tolerates every non-object / non-string shape.
//   5. RELAY SURFACE: the platform API key (x-api-key) is sent from ONLY the
//      allowlisted relays (mint-proxy create/writing, distribute /splits).
//      Any new file sending it — e.g. a re-added relayed admin write — fails
//      here with the incident record, because inprocess executes those as the
//      platform's wallet, which holds ADMIN on no artist collection. The
//      retired update-uri route must stay a tombstone (no upstream call).
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//        --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        scripts/verify-metadata-edit.ts

import fs from 'node:fs'
import path from 'node:path'
import { decodeFunctionData, parseAbi, toFunctionSelector } from 'viem'
import {
  UPDATE_TOKEN_URI_SIGNATURE,
  encodeUpdateTokenUri,
  isMetadataUri,
  pickMetadataName,
} from '../lib/momentUriEdit.ts'
import { COLLECTION_ABI } from '../lib/collections.ts'
import {
  PERMISSION_BIT_ADMIN,
  PERMISSION_BIT_METADATA,
  PERMISSION_BIT_MINTER,
  PERMISSION_BIT_SALES,
  canEditMomentMetadata,
} from '../lib/permissions.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

// ── 1. updateTokenURI ABI fragment — selector-exact against the contract ─────
console.log('1. updateTokenURI calldata')
const fragment = COLLECTION_ABI.find(
  (f) => f.type === 'function' && f.name === 'updateTokenURI',
)
check('COLLECTION_ABI carries an updateTokenURI function fragment', !!fragment)
const expectedSelector = toFunctionSelector(UPDATE_TOKEN_URI_SIGNATURE)
const calldata = encodeUpdateTokenUri(7n, 'ar://abc123')
check(
  'selector equals keccak(updateTokenURI(uint256,string))',
  calldata.slice(0, 10) === expectedSelector,
  `${calldata.slice(0, 10)} vs ${expectedSelector}`,
)
// Independent spelling: a field-order or type drift in COLLECTION_ABI can't
// self-verify against itself.
const independentAbi = parseAbi(['function updateTokenURI(uint256 tokenId, string _newURI)'])
const decoded = decodeFunctionData({ abi: independentAbi, data: calldata })
check('decodes to functionName updateTokenURI', decoded.functionName === 'updateTokenURI')
check('tokenId round-trips', decoded.args[0] === 7n, String(decoded.args[0]))
check('newUri round-trips', decoded.args[1] === 'ar://abc123', String(decoded.args[1]))

// ── 2. isMetadataUri — only pointers we are willing to commit on-chain ───────
console.log('2. isMetadataUri')
check('accepts ar://<txid>', isMetadataUri('ar://VqfXo1lSxCg3Dm-Ye3o1yDqfwZ2uVxYNy1s9fEgfR1w'))
check('accepts https://', isMetadataUri('https://arweave.net/abc'))
check('rejects bare ar://', !isMetadataUri('ar://'))
check('rejects bare https://', !isMetadataUri('https://'))
check('rejects data:', !isMetadataUri('data:application/json,{}'))
check('rejects blob:', !isMetadataUri('blob:https://kismet.art/uuid'))
check('rejects javascript:', !isMetadataUri('javascript:alert(1)'))
check('rejects http:// (plaintext)', !isMetadataUri('http://arweave.net/abc'))
check('rejects ipfs:// (editor never produces it)', !isMetadataUri('ipfs://Qm'))
check('rejects whitespace inside', !isMetadataUri('ar://abc def'))
check('rejects empty string', !isMetadataUri(''))
check('rejects non-string', !isMetadataUri(undefined) && !isMetadataUri(42))

// ── 3. The pencil's gate is exactly the contract's gate ───────────────────────
console.log('3. canEditMomentMetadata mask')
const ALL_BITS = [1n, PERMISSION_BIT_ADMIN, PERMISSION_BIT_MINTER, PERMISSION_BIT_SALES, PERMISSION_BIT_METADATA, 32n, 64n]
for (const bit of ALL_BITS) {
  const expected = bit === PERMISSION_BIT_ADMIN || bit === PERMISSION_BIT_METADATA
  check(`bit ${bit} → ${expected ? 'may edit' : 'may NOT edit'}`, canEditMomentMetadata(bit) === expected)
}
check('0 (no grant) may NOT edit', !canEditMomentMetadata(0n))
check('MINTER|SALES may NOT edit', !canEditMomentMetadata(PERMISSION_BIT_MINTER | PERMISSION_BIT_SALES))
check('ADMIN|MINTER may edit', canEditMomentMetadata(PERMISSION_BIT_ADMIN | PERMISSION_BIT_MINTER))
check('METADATA|SALES may edit', canEditMomentMetadata(PERMISSION_BIT_METADATA | PERMISSION_BIT_SALES))

// ── 4. pickMetadataName ───────────────────────────────────────────────────────
console.log('4. pickMetadataName')
check('plain name', pickMetadataName({ name: 'Untitled' }) === 'Untitled')
check('trims', pickMetadataName({ name: '  Sea  ' }) === 'Sea')
check('empty name → undefined', pickMetadataName({ name: '   ' }) === undefined)
check('non-string name → undefined', pickMetadataName({ name: 7 }) === undefined)
check('null → undefined', pickMetadataName(null) === undefined)
check('array → undefined', pickMetadataName(['name']) === undefined)
check('string → undefined', pickMetadataName('name') === undefined)

// ── 5. Relay surface: the platform key never leaves the allowlisted relays ───
console.log('5. relay surface (x-api-key allowlist)')
const ROOT = path.resolve(import.meta.dirname, '..')
const SCAN_DIRS = ['app', 'lib', 'hooks', 'components']
// The ONLY places that may send INPROCESS_API_KEY upstream. Each executes a
// creator-scoped write inprocess derives from the request (create) or a
// platform-scoped split payout — never an admin-class write on an artist's
// collection, which the platform wallet cannot perform.
const RELAY_ALLOWLIST = new Set([
  'lib/mint-proxy.ts',
  'app/api/distribute/route.ts',
  'app/api/distribute-all/route.ts',
])
const KEY_HEADER = /['"`]x-api-key['"`]/
const offenders: string[] = []
const seenAllowlisted = new Set<string>()
const walk = (dir: string): void => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      walk(full)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    const rel = path.relative(ROOT, full).split(path.sep).join('/')
    const text = fs.readFileSync(full, 'utf8')
    if (!KEY_HEADER.test(text)) continue
    if (RELAY_ALLOWLIST.has(rel)) seenAllowlisted.add(rel)
    else offenders.push(rel)
  }
}
for (const d of SCAN_DIRS) walk(path.join(ROOT, d))
check(
  'no file outside the relay allowlist sends x-api-key',
  offenders.length === 0,
  offenders.length
    ? `${offenders.join(', ')} — inprocess executes platform-key writes as the platform wallet, which holds ADMIN on no artist collection (2026-09 "No authorized smart wallet found" incident); admin writes must be artist-signed`
    : '',
)
for (const rel of RELAY_ALLOWLIST) {
  check(`allowlisted relay still present: ${rel}`, seenAllowlisted.has(rel), 'update RELAY_ALLOWLIST if this relay was retired')
}
const tombstone = fs.readFileSync(path.join(ROOT, 'app/api/moment/update-uri/route.ts'), 'utf8')
check('retired update-uri route makes no upstream call', !/INPROCESS_API|inprocessUrl\(|fetch\(/.test(tombstone))
check('retired update-uri route answers 410', /status:\s*410/.test(tombstone))
const detailView = fs.readFileSync(path.join(ROOT, 'components/MomentDetailView.tsx'), 'utf8')
check('editor no longer posts to /api/moment/update-uri', !detailView.includes('/api/moment/update-uri'))
check('editor uses the artist-signed hook', detailView.includes('useUpdateMomentUri'))
check(
  'pencil gates purely on the on-chain read (no isCreator shortcut on canEditMeta)',
  /useMomentEditPermission\(address, tokenId\)/.test(detailView) &&
    !/useMomentEditPermission\(address, tokenId, \{ skip: isCreator \}\)/.test(detailView),
)

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
