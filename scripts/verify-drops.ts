// Guards claim drops — lib/drops.ts (the pure rules, intents and settlement
// list) and lib/arkiv/schemas.ts (the Arkiv entity shapes).
//
// THE REGRESSIONS IT GUARDS:
//   1. A drop must never take more claims than ONE airdrop can deliver.
//      DROP_MAX_CLAIMS is pinned equal to MAX_AIRDROP_RECIPIENTS: raise one
//      without the other and a full drop can no longer be settled in a single
//      airdrop (or the cap silently stops meaning anything).
//   2. The client and the server must build the SAME EIP-712 message. The
//      form signs buildOpenDropMessage / buildClaimDropMessage and the routes
//      rebuild them to verify; a field that drifts (case, a bigint vs a
//      number, a trimmed title) turns every signature into a 401. Proven here
//      by signing with a local key and verifying with viem, the way the server
//      does — and that a tampered term, or a claim signature presented as an
//      open, does NOT verify.
//   3. validateOpenDrop is the only gate on a drop's terms, on both sides —
//      its window and size bounds are pinned at their edges, including the
//      Arkiv one that is easy to miss: a `str` holds 128 BYTES, so a title of
//      100 emoji is too long even though it is 100 characters.
//   4. The whole record (window + settle grace) must fit inside Arkiv's
//      maximum entity lifetime, or the longest drop could never be written.
//   5. The airdrop list is each claim's CURRENT owner, deduplicated, in claim
//      order, capped — the collector who signed is not necessarily who owns
//      the claim at settlement.
//   6. Encrypted Swarm references (64 bytes) are refused: they embed their
//      decryption key, and Arkiv entities are public.
//   7. The schemas index exactly what a query filters on (drops by closesAt,
//      claims by drop) — an index costs more than a stored-only attribute,
//      and arkiv/schema.md documents exactly these.
//   8. The public links keep the formats checked live: the explorer's
//      /entity/<key> route and the gateway's /bzz/<ref>/ read path.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/verify-drops.ts

import { MAX_LIFETIME, MAX_STRING_BYTES } from '@arkiv-network/sdk'
import { keccak256, toBytes, verifyTypedData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { MAX_AIRDROP_RECIPIENTS } from '../lib/config.ts'
import { KISMET_INTENT_DOMAIN } from '../lib/intent.ts'
import {
  ARKIV_STR_MAX_BYTES,
  arkivEntityUrl,
  buildClaimDropMessage,
  buildOpenDropMessage,
  CLAIM_DROP_TYPES,
  DROP_MAX_CLAIMS,
  DROP_MAX_WINDOW_SECONDS,
  DROP_MIN_WINDOW_SECONDS,
  formatTimeLeft,
  hashDescription,
  isDropOpen,
  isEntityKey,
  isSwarmRef,
  OPEN_DROP_TYPES,
  recordExpiresAt,
  SETTLE_GRACE_SECONDS,
  settlementRecipients,
  sniffImageType,
  swarmGatewayUrl,
  validateDropTerms,
  validateOpenDrop,
  type ClaimView,
  type OpenDropFields,
} from '../lib/drops.ts'
import {
  CLAIM_SCHEMA_NAME,
  ClaimSchema,
  DROP_SCHEMA_NAME,
  DropSchema,
  SETTLEMENT_SCHEMA_NAME,
  SettlementSchema,
} from '../lib/arkiv/schemas.ts'

let failures = 0
const check = (name: string, cond: boolean): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}`)
    failures++
  }
}

const NOW = 1_800_000_000
const REF = 'ab'.repeat(32)
const DROP_KEY = `0x${'cd'.repeat(32)}` as const
const base = {
  title: 'Dawn',
  description: 'first light',
  swarmRef: REF,
  mime: 'image/png',
  closesAt: NOW + 24 * 3600,
  maxClaims: 100,
}

// ── 1. caps in lockstep ──────────────────────────────────────────────────
console.log('caps')
check('DROP_MAX_CLAIMS + 1 equals MAX_AIRDROP_RECIPIENTS (one airdrop delivers a full drop and the artist\'s copy)',
  DROP_MAX_CLAIMS + 1 === MAX_AIRDROP_RECIPIENTS)
check('ARKIV_STR_MAX_BYTES matches the SDK MAX_STRING_BYTES', ARKIV_STR_MAX_BYTES === MAX_STRING_BYTES)

// ── 3. validateOpenDrop ──────────────────────────────────────────────────
console.log('validateOpenDrop')
const ok = validateOpenDrop(base, NOW)
check('valid terms pass and are trimmed', ok.ok && ok.value.title === 'Dawn')
check('title is trimmed', (() => { const r = validateOpenDrop({ ...base, title: '  Dawn  ' }, NOW); return r.ok && r.value.title === 'Dawn' })())
check('empty title is refused', !validateOpenDrop({ ...base, title: '   ' }, NOW).ok)
check('100-char ASCII title passes', validateOpenDrop({ ...base, title: 'a'.repeat(100) }, NOW).ok)
check('101-char title is refused', !validateOpenDrop({ ...base, title: 'a'.repeat(101) }, NOW).ok)
check('40 emoji (160 bytes) is refused by the 128-byte Arkiv str cap', !validateOpenDrop({ ...base, title: '🌅'.repeat(40) }, NOW).ok)
check('1000-char description passes', validateOpenDrop({ ...base, description: 'x'.repeat(1000) }, NOW).ok)
check('1001-char description is refused', !validateOpenDrop({ ...base, description: 'x'.repeat(1001) }, NOW).ok)
check('window of exactly the minimum passes', validateOpenDrop({ ...base, closesAt: NOW + DROP_MIN_WINDOW_SECONDS }, NOW).ok)
check('window one second short is refused', !validateOpenDrop({ ...base, closesAt: NOW + DROP_MIN_WINDOW_SECONDS - 1 }, NOW).ok)
check('window of exactly the maximum passes', validateOpenDrop({ ...base, closesAt: NOW + DROP_MAX_WINDOW_SECONDS }, NOW).ok)
check('window one second long is refused', !validateOpenDrop({ ...base, closesAt: NOW + DROP_MAX_WINDOW_SECONDS + 1 }, NOW).ok)
check('a close time in the past is refused', !validateOpenDrop({ ...base, closesAt: NOW - 1 }, NOW).ok)
check('a fractional close time is refused', !validateOpenDrop({ ...base, closesAt: NOW + 3600.5 }, NOW).ok)
check('1 claim passes', validateOpenDrop({ ...base, maxClaims: 1 }, NOW).ok)
check(`${DROP_MAX_CLAIMS} claims pass`, validateOpenDrop({ ...base, maxClaims: DROP_MAX_CLAIMS }, NOW).ok)
check('0 claims are refused', !validateOpenDrop({ ...base, maxClaims: 0 }, NOW).ok)
check(`${DROP_MAX_CLAIMS + 1} claims are refused`, !validateOpenDrop({ ...base, maxClaims: DROP_MAX_CLAIMS + 1 }, NOW).ok)
check('fractional claims are refused', !validateOpenDrop({ ...base, maxClaims: 10.5 }, NOW).ok)
check('unsupported mime is refused', !validateOpenDrop({ ...base, mime: 'image/svg+xml' }, NOW).ok)
check('the form\'s precheck validates terms without an artwork', validateDropTerms({ title: 'Dawn', closesAt: NOW + 3600, maxClaims: 5 }, NOW).ok)
check('the open route still requires the artwork', !validateOpenDrop({ ...base, swarmRef: undefined }, NOW).ok)

// ── 6. Swarm references and entity keys ──────────────────────────────────
console.log('identifiers')
check('a 32-byte lowercase reference is a Swarm ref', isSwarmRef(REF))
check('an encrypted 64-byte reference is refused (it embeds its key)', !isSwarmRef('ab'.repeat(64)))
check('an uppercase reference is refused', !isSwarmRef(REF.toUpperCase()))
check('a 0x-prefixed reference is refused', !isSwarmRef(`0x${REF}`))
check('validateOpenDrop refuses an encrypted reference', !validateOpenDrop({ ...base, swarmRef: 'ab'.repeat(64) }, NOW).ok)
check('entity key accepts 0x + 64 hex', isEntityKey(DROP_KEY))
check('entity key refuses a Swarm ref', !isEntityKey(REF))

// ── image sniffing ───────────────────────────────────────────────────────
console.log('sniffImageType')
const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)])
check('PNG', sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) === 'image/png')
check('JPEG', sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0)) === 'image/jpeg')
check('GIF89a', sniffImageType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) === 'image/gif')
check('GIF87a', sniffImageType(bytes(0x47, 0x49, 0x46, 0x38, 0x37, 0x61)) === 'image/gif')
check('WebP', sniffImageType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50)) === 'image/webp')
check('RIFF WAVE is not WebP', sniffImageType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45)) === null)
check('HTML is not an image', sniffImageType(new TextEncoder().encode('<!doctype html><script>')) === null)
check('empty input is not an image', sniffImageType(new Uint8Array()) === null)

// ── 4. lifetimes ─────────────────────────────────────────────────────────
console.log('lifetimes')
const BLOCK_SECONDS = 2
check('longest window + settle grace fits inside Arkiv MAX_LIFETIME',
  BigInt(Math.ceil((DROP_MAX_WINDOW_SECONDS + SETTLE_GRACE_SECONDS) / BLOCK_SECONDS)) < MAX_LIFETIME)
check('records expire SETTLE_GRACE_SECONDS after close', recordExpiresAt(NOW) === NOW + SETTLE_GRACE_SECONDS)
check('open one second before closesAt', isDropOpen(NOW + 1, NOW))
check('closed at closesAt (the open-drops query is closesAt > now)', !isDropOpen(NOW, NOW))
check('countdown formats days', formatTimeLeft(2 * 86400 + 4 * 3600 + 5) === '2d 4h')
check('countdown formats hours', formatTimeLeft(3 * 3600 + 12 * 60) === '3h 12m')
check('countdown formats minutes', formatTimeLeft(45 * 60 + 7) === '45m 7s')
check('countdown formats seconds', formatTimeLeft(9) === '9s')
check('countdown at zero says closed', formatTimeLeft(0) === 'closed')

// ── 2. intents: client and server build the same message ─────────────────
console.log('intents')
const signer = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const fields = (validateOpenDrop(base, NOW) as { ok: true; value: OpenDropFields }).value
const nonce = 'f'.repeat(32)
const expiresAt = NOW + 300

const openMsg = buildOpenDropMessage(signer.address, fields, nonce, expiresAt)
check('account is lowercased in the message', openMsg.account === signer.address.toLowerCase())
check('description is bound by its keccak hash', openMsg.descriptionHash === keccak256(toBytes('first light')))
check('no description hashes to the empty string', hashDescription('') === '')
check('numeric terms are bigints', typeof openMsg.closesAt === 'bigint' && typeof openMsg.maxClaims === 'bigint')

const openSig = await signer.signTypedData({ domain: KISMET_INTENT_DOMAIN, types: OPEN_DROP_TYPES, primaryType: 'OpenDrop', message: openMsg })
const openVerifies = await verifyTypedData({
  address: signer.address,
  domain: KISMET_INTENT_DOMAIN,
  types: OPEN_DROP_TYPES,
  primaryType: 'OpenDrop',
  // The server rebuilds from the request body — with a checksummed account,
  // the way the client sends it.
  message: buildOpenDropMessage(signer.address, fields, nonce, expiresAt),
  signature: openSig,
})
check('an OpenDrop signature verifies against the server-rebuilt message', openVerifies)

const tampered = await verifyTypedData({
  address: signer.address,
  domain: KISMET_INTENT_DOMAIN,
  types: OPEN_DROP_TYPES,
  primaryType: 'OpenDrop',
  message: buildOpenDropMessage(signer.address, { ...fields, maxClaims: 200 }, nonce, expiresAt),
  signature: openSig,
})
check('changing a term after signing breaks the signature', !tampered)

const claimMsg = buildClaimDropMessage(signer.address, DROP_KEY.toUpperCase().replace('0X', '0x'), nonce, expiresAt)
check('the drop key is lowercased in the claim message', claimMsg.drop === DROP_KEY)
const claimSig = await signer.signTypedData({ domain: KISMET_INTENT_DOMAIN, types: CLAIM_DROP_TYPES, primaryType: 'ClaimDrop', message: claimMsg })
check('a ClaimDrop signature verifies', await verifyTypedData({
  address: signer.address,
  domain: KISMET_INTENT_DOMAIN,
  types: CLAIM_DROP_TYPES,
  primaryType: 'ClaimDrop',
  message: buildClaimDropMessage(signer.address, DROP_KEY, nonce, expiresAt),
  signature: claimSig,
}))
check('a claim for another drop does not verify', !(await verifyTypedData({
  address: signer.address,
  domain: KISMET_INTENT_DOMAIN,
  types: CLAIM_DROP_TYPES,
  primaryType: 'ClaimDrop',
  message: buildClaimDropMessage(signer.address, `0x${'ee'.repeat(32)}`, nonce, expiresAt),
  signature: claimSig,
})))
let crossVerifies = false
try {
  crossVerifies = await verifyTypedData({
    address: signer.address,
    domain: KISMET_INTENT_DOMAIN,
    types: OPEN_DROP_TYPES,
    primaryType: 'OpenDrop',
    message: openMsg,
    signature: claimSig,
  })
} catch {
  crossVerifies = false
}
check('a ClaimDrop signature never verifies as an OpenDrop', !crossVerifies)

// ── 5. settlement list ───────────────────────────────────────────────────
console.log('settlementRecipients')
const A = '0x' + 'a'.repeat(40)
const B = '0x' + 'b'.repeat(40)
const C = '0x' + 'c'.repeat(40)
const claim = (k: string, collector: string, owner: string, claimedAt: number): ClaimView => ({
  key: `0x${k.repeat(64)}` as `0x${string}`,
  collector,
  owner,
  claimedAt,
})
const ARTIST = '0x' + 'd'.repeat(40)
const list = settlementRecipients([
  claim('3', C, C, 30),
  claim('1', A, A, 10),
  claim('2', B, A, 20), // B handed their claim to A
], ARTIST)
check('each claim\'s current owner, deduplicated, in claim order, then the artist', list.join() === [A, C, ARTIST].join())
check('owners are lowercased', settlementRecipients([claim('1', A, A.toUpperCase().replace('0X', '0x'), 1)], ARTIST)[0] === A)
check('invalid owners are skipped', settlementRecipients([claim('1', A, '0x1234', 1)], ARTIST).join() === ARTIST)
check('the artist is listed once when a claim was handed to them',
  settlementRecipients([claim('1', A, ARTIST, 1), claim('2', B, B, 2)], ARTIST.toUpperCase().replace('0X', '0x')).join() === [ARTIST, B].join())
const many = Array.from({ length: DROP_MAX_CLAIMS + 25 }, (_, i) =>
  claim(((i % 9) + 1).toString(), A, '0x' + i.toString(16).padStart(40, '0'), i))
check(`a full drop is ${DROP_MAX_CLAIMS} claims plus the artist — one airdrop's worth`,
  settlementRecipients(many, ARTIST).length === MAX_AIRDROP_RECIPIENTS)

// ── 7. schemas ───────────────────────────────────────────────────────────
console.log('schemas')
const indexed = (cols: Record<string, { isIndexed: boolean }>) =>
  Object.entries(cols).filter(([, c]) => c.isIndexed).map(([n]) => n).sort().join(',')
check('drop schema indexes exactly closesAt', indexed(DropSchema.columns as Record<string, { isIndexed: boolean }>) === 'closesAt')
check('claim schema indexes exactly drop', indexed(ClaimSchema.columns as Record<string, { isIndexed: boolean }>) === 'drop')
check('settlement schema indexes exactly drop', indexed(SettlementSchema.columns as Record<string, { isIndexed: boolean }>) === 'drop')
check('schema names are versioned',
  DROP_SCHEMA_NAME === 'kismet.drop.v1' && CLAIM_SCHEMA_NAME === 'kismet.claim.v1' && SETTLEMENT_SCHEMA_NAME === 'kismet.settlement.v1')
check('description is a bytes column (a str would cap at 128 bytes)',
  (DropSchema.columns as Record<string, { type: string }>).description.type === 'bytes')

// ── 8. public links ──────────────────────────────────────────────────────
console.log('links')
check('explorer entity link uses the /entity/<key> route', arkivEntityUrl(DROP_KEY) === `https://rabdi.explorer.arkiv.network/entity/${DROP_KEY}`)
check('gateway link uses the /bzz/<ref>/ read path', swarmGatewayUrl(REF) === `https://api.gateway.ethswarm.org/bzz/${REF}/`)

console.log(failures === 0 ? '\nverify-drops: OK' : `\nverify-drops: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
