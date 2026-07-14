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
}

console.log(`\n${failed === 0 ? 'OK' : 'FAILED'} — agent mint builders: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
