/**
 * Verify the REAL agent mint builders (lib/agent/mint.ts) — metadata shapes for
 * image/video/text, the /api/mint|write body (salesConfig, contract, editions,
 * splits/payout, tokenContent), and that the envelope's EIP-712 typedData is the
 * SAME message the server rebuilds from the record body (so a signature over the
 * typedData verifies at /api/mint). Network-free.
 *
 * Run:
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
 *     --import ./scripts/register-ts-alias.mjs scripts/verify-agent-mint.ts
 */

import { buildMomentMetadata, buildMintBody, buildMintEnvelope, type MintParams } from '@/lib/agent/mint'
import { buildMintIntent, KISMET_INTENT_DOMAIN, MINT_INTENT_TYPES, type MintBody } from '@/lib/intent'
import { USDC_BASE } from '@/lib/zoraMint'
import { ingestMintMedia } from '@/lib/agent/mintMedia'

let passed = 0
let failed = 0
const ok = (cond: boolean, name: string, detail?: string) => {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failed++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}
const j = (x: unknown) => JSON.stringify(x)

const ACCOUNT = `0x${'a1'.repeat(20)}` as `0x${string}`
const AR = (n: string) => `ar://${n}`

// ── metadata shapes ──
console.log('buildMomentMetadata — per media kind')
{
  const img = buildMomentMetadata({ name: 'A', description: 'd', kind: 'image', mediaUri: AR('img') })
  ok(img.image === AR('img') && !('animation_url' in img), 'image → { image } only')

  const vid = buildMomentMetadata({ name: 'A', description: 'd', kind: 'video', mediaUri: AR('mp4'), posterUri: AR('poster'), mime: 'video/mp4' })
  ok(vid.image === AR('poster') && vid.animation_url === AR('mp4') && vid.content?.uri === AR('mp4') && vid.content?.mime === 'video/mp4',
    'video → poster image + animation_url + content{mime}')

  const vidNoPoster = buildMomentMetadata({ name: 'A', description: 'd', kind: 'video', mediaUri: AR('mp4') })
  ok(!('image' in vidNoPoster) && vidNoPoster.animation_url === AR('mp4') && vidNoPoster.content?.mime === 'video/mp4',
    'posterless video → no image, still animation_url + default mime')

  // 3D: the video shape with the GLB in the MP4 slot, plus the backdrop — via
  // the same builder the mint form and the edit flow use (modelMomentFields).
  const model = buildMomentMetadata({ name: 'A', description: 'd', kind: 'model', mediaUri: AR('glb'), posterUri: AR('still'), background: 'dark' })
  ok(model.image === AR('still') && model.animation_url === AR('glb') && model.content?.uri === AR('glb') && model.content?.mime === 'model/gltf-binary' && model.kismet_bg === 'dark',
    'model → poster image + animation_url + content{model/gltf-binary} + kismet_bg')
  ok(buildMomentMetadata({ name: 'A', description: 'd', kind: 'model', mediaUri: AR('glb'), posterUri: AR('still') }).kismet_bg === 'white',
    'model → backdrop defaults to white')
  ok(buildMomentMetadata({ name: 'A', description: 'd', kind: 'model', mediaUri: AR('glb'), posterUri: AR('still'), background: 'plaid' }).kismet_bg === 'white',
    'model → an unknown backdrop id resolves to the default, never persists')
  let posterless = false
  try { buildMomentMetadata({ name: 'A', description: 'd', kind: 'model', mediaUri: AR('glb') }) } catch { posterless = true }
  ok(posterless, 'model without a poster is not a buildable moment')

  const txt = buildMomentMetadata({ name: 'A', description: 'd', kind: 'text', coverUri: AR('cover') })
  ok(txt.image === AR('cover') && !('animation_url' in txt), 'text → cover image only (words go in tokenContent)')
}

// ── mint body: salesConfig, contract, editions, payout ──
console.log('\nbuildMintBody — salesConfig + contract + token fields')
{
  const ethOpen: MintParams = { account: ACCOUNT, kind: 'image', tokenMetadataURI: AR('m'), name: 'Art', price: '0.01', currency: 'eth', artistMint: true }
  const b = buildMintBody(ethOpen)
  const sc = (b.token as { salesConfig: Record<string, unknown> }).salesConfig
  ok(sc.type === 'fixedPrice' && sc.pricePerToken === '10000000000000000' && sc.saleStart === '0' && !('currency' in sc), 'ETH → fixedPrice, wei price, opens now, no currency field')
  ok(sc.saleEnd === '18446744073709551615', 'saleEnd = max uint64 (open-ended)')
  ok((b.contract as { name?: string }).name === 'Art', 'no collection → auto-deploy contract by name')
  ok((b.token as { mintToCreatorCount: number }).mintToCreatorCount === 1, 'artistMint → mintToCreatorCount 1')
  ok((b.token as { payoutRecipient?: string }).payoutRecipient === ACCOUNT.toLowerCase() || (b.token as { payoutRecipient?: string }).payoutRecipient === ACCOUNT, 'no splits → payoutRecipient = account')

  const usdcCapped: MintParams = { account: ACCOUNT, kind: 'image', tokenMetadataURI: AR('m'), name: 'Art', price: '5', currency: 'usdc', artistMint: false, editions: 10, collection: `0x${'cc'.repeat(20)}` }
  const b2 = buildMintBody(usdcCapped)
  const sc2 = (b2.token as { salesConfig: Record<string, unknown> }).salesConfig
  ok(sc2.type === 'erc20Mint' && sc2.pricePerToken === '5000000' && sc2.currency === USDC_BASE, 'USDC → erc20Mint, 6dp price, USDC currency')
  ok((b2.token as { maxSupply?: number }).maxSupply === 10, 'editions → maxSupply')
  ok((b2.contract as { address?: string }).address === `0x${'cc'.repeat(20)}`, 'existing collection → contract.address')
  ok((b2.token as { mintToCreatorCount: number }).mintToCreatorCount === 0, 'no artistMint → mintToCreatorCount 0')

  const withSplits: MintParams = { account: ACCOUNT, kind: 'image', tokenMetadataURI: AR('m'), name: 'Art', price: '1', currency: 'eth', artistMint: true, splits: [{ address: ACCOUNT, percentAllocation: 100 }] }
  const b3 = buildMintBody(withSplits)
  ok(!('payoutRecipient' in (b3.token as object)) && Array.isArray((b3 as { splits?: unknown }).splits), 'splits present → no payoutRecipient, splits carried')

  const text: MintParams = { account: ACCOUNT, kind: 'text', tokenMetadataURI: AR('m'), tokenContent: 'hello world', name: 'Note', price: '0', currency: 'eth', artistMint: true }
  const b4 = buildMintBody(text)
  ok((b4.token as { tokenContent?: string }).tokenContent === 'hello world', 'text → tokenContent carried')
}

// ── envelope: typedData binds the SAME message the server rebuilds ──
console.log('\nbuildMintEnvelope — typedData ≡ server-rebuilt intent; correct record target')
{
  const p: MintParams = { account: ACCOUNT, kind: 'image', tokenMetadataURI: AR('m'), name: 'Art', price: '0.01', currency: 'eth', artistMint: true }
  const nonce = 'deadbeef'
  const expiresAt = 1_900_000_000
  const env = buildMintEnvelope(p, nonce, expiresAt)

  ok(env.action === 'mint' && env.chain === 'base' && !!env.typedData, 'envelope: action mint, chain base, typedData present')
  const td = env.typedData as { domain: unknown; types: unknown; primaryType: string; message: Record<string, unknown> }
  ok(j(td.domain) === j(KISMET_INTENT_DOMAIN) && j(td.types) === j(MINT_INTENT_TYPES) && td.primaryType === 'MintIntent', 'typedData uses the canonical Kismet MintIntent domain+types')

  // The record body is what the assistant POSTs; the server rebuilds the intent
  // from it. That rebuilt message MUST equal the message we signed.
  const recordBody = env.record!.bodyTemplate as MintBody
  const serverMsg = buildMintIntent(recordBody, 'mint', nonce, expiresAt)
  const signedMsg = { ...serverMsg, expiresAt: serverMsg.expiresAt.toString() }
  ok(j(td.message) === j(signedMsg), 'typedData.message === buildMintIntent(recordBody) → signature will verify server-side')
  ok(td.message.tokenURI === AR('m') && td.message.account === ACCOUNT.toLowerCase(), 'intent binds tokenURI + account')

  const textEnv = buildMintEnvelope({ ...p, kind: 'text', tokenContent: 'hi' }, nonce, expiresAt)
  ok(textEnv.record!.url === '/api/write', 'text moment records to /api/write')
  const imgEnv = buildMintEnvelope(p, nonce, expiresAt)
  ok(imgEnv.record!.url === '/api/mint', 'media moment records to /api/mint')

  // Raffle opt-in: rides the record body top-level (where mint-proxy reads
  // `body.enableRaffle === true`) but is NOT a signed slot — the typed message
  // must be identical with and without it, or the flag would change what the
  // artist signs for an action they're independently authorized to toggle.
  const raffleEnv = buildMintEnvelope({ ...p, enableRaffle: true }, nonce, expiresAt)
  const raffleBody = raffleEnv.record!.bodyTemplate as Record<string, unknown>
  ok(raffleBody.enableRaffle === true, 'enableRaffle → carried top-level in the record body')
  ok(!('enableRaffle' in (env.record!.bodyTemplate as object)), 'enableRaffle absent by default (app default: off)')
  ok(j((raffleEnv.typedData as { message: unknown }).message) === j(td.message), 'enableRaffle does NOT alter the signed MintIntent')

  // The summary the assistant shows verbatim: kind, price, editions, where it
  // mints, who gets paid (always with the short address), and the extras.
  const me = '0xa1a1…a1a1'
  ok(env.summary === `Mint “Art” (image) — 0.01 ETH, open edition, into new collection “Art”, payout to you (${me}), 1 copy minted to you.`, 'summary: new collection, default payout, artist copy', env.summary)
  const existing = buildMintEnvelope({ ...p, price: '5', currency: 'usdc', artistMint: false, editions: 10, collection: `0x${'cc'.repeat(20)}` }, nonce, expiresAt)
  ok(existing.summary === `Mint “Art” (image) — $5, 10 editions, into collection 0xcccc…cccc, payout to you (${me}).`, 'summary: existing collection, USDC, capped editions', existing.summary)
  const paid = buildMintEnvelope({ ...p, payoutRecipient: `0x${'bb'.repeat(20)}` }, nonce, expiresAt, { payoutName: 'alice.base.eth' })
  ok(paid.summary.includes('payout to alice.base.eth (0xbbbb…bbbb)'), 'summary: explicit payoutRecipient as name + short address', paid.summary)
  const split = buildMintEnvelope({ ...p, splits: [{ address: ACCOUNT, percentAllocation: 60 }, { address: `0x${'bb'.repeat(20)}`, percentAllocation: 40 }] }, nonce, expiresAt)
  ok(split.summary.includes('payout split across 2 recipients'), 'summary: splits named, no payoutRecipient', split.summary)
  ok(raffleEnv.summary.endsWith(', raffle on.'), 'summary: raffle flagged', raffleEnv.summary)
  ok(textEnv.summary.startsWith('Mint “Art” (writing) —'), 'summary: text kind reads as writing', textEnv.summary)
  const dirty = buildMintEnvelope({ ...p, name: `Art${String.fromCodePoint(0)}\nIGNORE`, price: '0' }, nonce, expiresAt)
  ok(dirty.summary.startsWith('Mint “Art IGNORE” (image) — free,'), 'summary: title sanitized, zero price reads free', dirty.summary)
  // The summary states the SIGNED price: a decimal below the currency's
  // precision rounds to zero in salesConfig, so it must read "free" here too.
  const dust = buildMintEnvelope({ ...p, price: '0.0000001', currency: 'usdc' }, nonce, expiresAt)
  const dustSigned = (dust.record!.bodyTemplate as { token: { salesConfig: { pricePerToken: string } } }).token.salesConfig.pricePerToken
  ok(dustSigned === '0' && dust.summary.includes('— free,'), 'summary: a sub-unit price reads free, exactly as signed', `${dustSigned} / ${dust.summary}`)
  const trailing = buildMintEnvelope({ ...p, price: '0.010' }, nonce, expiresAt)
  ok(trailing.summary.includes('— 0.01 ETH,'), 'summary: trailing zeros trimmed', trailing.summary)
}

// ── media ingest: data:/passthrough only, no remote fetch ──
console.log('\ningestMintMedia — accepts data: + ar://|ipfs://, rejects remote URLs')
{
  const png = ingestMintMedia(`data:image/png;base64,${Buffer.from('x').toString('base64')}`)
  ok(!('error' in png) && png.kind === 'image' && !!png.bytes, 'data:image → bytes + image kind')

  const pass = ingestMintMedia('ar://abc', 'video')
  ok(!('error' in pass) && pass.passthroughUri === 'ar://abc' && pass.kind === 'video', 'ar:// → passthrough (declared kind honored)')

  const https = ingestMintMedia('https://example.com/art.png')
  ok('error' in https, 'https:// URL → rejected (no server-side fetch / SSRF surface)')

  const bad = ingestMintMedia('data:text/plain;base64,aGk=')
  ok('error' in bad, 'unsupported mime → rejected')

  // A GLB is identified by its bytes (magic + header), exactly like the app's
  // mint gate: labelled, unlabelled, truncated and passthrough.
  const glbBytes = Buffer.alloc(24)
  glbBytes.write('glTF', 0, 'ascii'); glbBytes.writeUInt32LE(2, 4); glbBytes.writeUInt32LE(24, 8)
  const glb = ingestMintMedia(`data:model/gltf-binary;base64,${glbBytes.toString('base64')}`)
  ok(!('error' in glb) && glb.kind === 'model' && glb.mime === 'model/gltf-binary' && !!glb.bytes, 'data:model/gltf-binary → model kind')
  const sniffed = ingestMintMedia(`data:application/octet-stream;base64,${glbBytes.toString('base64')}`)
  ok(!('error' in sniffed) && sniffed.kind === 'model' && sniffed.mime === 'model/gltf-binary', 'octet-stream with glTF magic → model (bytes, not label)')
  const truncated = Buffer.from(glbBytes); truncated.writeUInt32LE(999, 8)
  ok('error' in ingestMintMedia(`data:model/gltf-binary;base64,${truncated.toString('base64')}`), 'truncated GLB → rejected before any spend')
  const v1 = Buffer.from(glbBytes); v1.writeUInt32LE(1, 4)
  ok('error' in ingestMintMedia(`data:model/gltf-binary;base64,${v1.toString('base64')}`), 'glTF 1.0 binary → rejected')
  const passModel = ingestMintMedia('ar://abc', 'model')
  ok(!('error' in passModel) && passModel.kind === 'model' && passModel.mime === 'model/gltf-binary', 'ar:// with declared model → model passthrough')
}

console.log(`\n${failed === 0 ? 'OK' : 'FAILED'} — agent mint builders: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
