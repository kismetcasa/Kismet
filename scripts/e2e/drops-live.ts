/**
 * Claim drops against the LIVE services, with no funded key — the half of
 * the end-to-end check that scripts/e2e/drops-flow.ts can't do in process.
 *
 * Arkiv (Rabdi): the real lib/arkiv modules.
 *   - every query the app runs must be accepted by the node;
 *   - every write the app makes — a drop, a claim, a settlement, each created
 *     and handed to its user in one batch — runs through the real
 *     write function down to the SDK, which simulates the batch on the node
 *     (eth_estimateGas from the writer needs no funds) and is stopped just
 *     before the transaction is sent. A batch that hands off a key it didn't
 *     create must revert there, proving the simulation executes the batch;
 *   - the funds guard reads a real balance (a fresh writer has none).
 *
 * Base (mainnet): lib/dropSettlement — the settle route's checks — on real
 * chain data: a real ERC-1155 mint found in recent blocks must match from its
 * receipt, and a recipient, operator or token it didn't mint must not; Zora's
 * getTokenInfo is read on Kismet's own collection for the "not yet" answer;
 * the resume path's log lookup runs when BASE_RPC_URL serves eth_getLogs
 * (Base's public endpoint doesn't).
 *
 * Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
 *        --import ./scripts/register-ts-alias.mjs scripts/e2e/drops-live.ts
 * (behind a proxy: NODE_USE_ENV_PROXY=1 and the proxy's CA in NODE_EXTRA_CA_CERTS)
 */
import { createPublicClient, getAddress, http, zeroAddress, type Hex } from 'viem'
import { base } from 'viem/chains'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createWalletClient } from '@arkiv-network/sdk'
import { rabdi } from '@arkiv-network/sdk/chains'
import { ExpirationTime } from '@arkiv-network/sdk'
import { addr, key as keyValue, u256, u64 } from '@arkiv-network/sdk/schema'

let passed = 0
let failed = 0
function ok(cond: boolean, name: string, detail?: unknown): void {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}` : ''}`)
}

// A fresh, unfunded writer: nothing it writes can land, everything it reads is empty.
const writerKey = generatePrivateKey()
process.env.ARKIV_WRITER_PRIVATE_KEY = writerKey
const writer = privateKeyToAccount(writerKey)

// Stop every Arkiv transaction at the door, after the SDK's simulation.
const STOP = 'SIMULATED: stopped before sending'
const estimates: bigint[] = []
const realFetch = globalThis.fetch
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const body = typeof init?.body === 'string' ? init.body : ''
  if (body.includes('"eth_sendRawTransaction"')) {
    const { id } = JSON.parse(body) as { id: number }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: STOP } }), {
      headers: { 'content-type': 'application/json' },
    })
  }
  const res = await realFetch(input, init)
  if (body.includes('"eth_estimateGas"')) {
    const j = (await res.clone().json()) as { result?: Hex }
    if (j.result) estimates.push(BigInt(j.result))
  }
  return res
}
const stopped = (err: unknown) => {
  for (let e = err as { message?: string; cause?: unknown } | undefined, i = 0; e && i < 10; e = e.cause as typeof e, i++) {
    if (e.message?.includes(STOP)) return true
  }
  return false
}

const drops = await import('@/lib/drops')
const client = await import('@/lib/arkiv/client')
const q = await import('@/lib/arkiv/drops')
const { SettlementSchema } = await import('@/lib/arkiv/schemas')
const { checkAirdropTx, findAirdrop } = await import('@/lib/dropSettlement')

const nowSec = Math.floor(Date.now() / 1000)
const someKey = `0x${'5a'.repeat(32)}` as Hex

try {
  console.log(`Arkiv  Rabdi block ${await client.arkivPublicClient().getBlockNumber()}, fresh writer ${writer.address}`)

  console.log('\nqueries (the real lib/arkiv/drops)')
  ok((await q.getDrop(someKey)) === null, 'getDrop: an unknown key is null')
  ok((await q.countClaims(someKey)) === 0, 'countClaims')
  ok((await q.listOpenDrops(nowSec)).length === 0, 'listOpenDrops')
  ok((await q.listSettlingDrops(nowSec)).length === 0, 'listSettlingDrops')
  ok((await q.listClaims(someKey)).length === 0, 'listClaims (keyset-paged, onMismatch: throw)')
  ok((await q.getSettlements([someKey])).size === 0, 'getSettlements: one drop')
  const many = Array.from({ length: 60 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, '0')}` as Hex)
  ok((await q.getSettlements(many)).size === 0, 'getSettlements: 60 drops, in two `or` batches of up to 50')
  ok((await q.listClaimsOwnedBy(writer.address)).length === 0, 'listClaimsOwnedBy (ownedBy)')
  ok((await q.listDropsClosedBetween(nowSec - drops.SETTLE_GRACE_SECONDS, nowSec)).length === 0, 'listDropsClosedBetween (between + $key paging)')

  console.log('\nfunds guard')
  ok((await client.writerIsFunded()) === false, 'a writer with no tGLM is reported unfunded (real balance and gas price)')

  console.log('\nwrites, simulated on the node and stopped before sending')
  const artist = privateKeyToAccount(generatePrivateKey())
  const collector = privateKeyToAccount(generatePrivateKey())
  const signature = await artist.signMessage({ message: 'a 65-byte signature, as an intent carries' })
  const intent = { signature, nonce: 'ab'.repeat(16), expiresAt: nowSec + 300 }
  const v = drops.validateOpenDrop(
    { title: 'Live simulation', description: 'Never sent.', swarmRef: 'cd'.repeat(32), mime: 'image/png', closesAt: nowSec + 3600, maxClaims: 199 },
    nowSec,
  )
  if (!v.ok) throw new Error(v.error)

  const attempt = async (name: string, write: () => Promise<unknown>) => {
    const before = estimates.length
    try {
      await write()
      ok(false, name, 'the write was not stopped')
    } catch (err) {
      ok(stopped(err) && estimates.length === before + 1, `${name} (${estimates.at(-1)} gas)`, String(err).slice(0, 300))
    }
  }
  await attempt('a drop, created and handed to its artist', () => q.writeDrop({ artist: artist.address, fields: v.value, intent }))
  await attempt('a claim, created and handed to its collector', () =>
    q.writeClaim({ dropKey: someKey, dropClosesAt: v.value.closesAt, collector: collector.address, claimedAt: nowSec, intent }))
  await attempt('a settlement, created and handed to the artist', () =>
    q.writeSettlement({
      dropKey: someKey,
      dropClosesAt: v.value.closesAt,
      artist: artist.address,
      collection: getAddress(`0x${'c0'.repeat(20)}`),
      tokenId: 7n,
      airdropTx: `0x${'7a'.repeat(32)}`,
      recipients: 200,
    }))

  // Negative control: the same settlement, but handing off a key the batch
  // didn't create — the node must refuse it in the simulation.
  const wallet = createWalletClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY?.trim() ?? '' }), transport: http(), account: writer })
  const before = estimates.length
  try {
    await wallet.executeBatch({
      creates: [{
        schema: SettlementSchema,
        values: { drop: keyValue(someKey), collection: addr(getAddress(`0x${'c0'.repeat(20)}`)), tokenId: u256(7n), airdropTx: `0x${'7a'.repeat(32)}`, recipients: u64(200n) },
        expiration: ExpirationTime.atDate(new Date((nowSec + 86400) * 1000)),
        flags: { readonly: true },
      }],
      ownershipChanges: [{ entityKey: `0x${'99'.repeat(32)}`, newOwner: artist.address }],
    } as unknown as Parameters<typeof wallet.executeBatch>[0])
    ok(false, 'a hand-off of a key the batch did not create is refused', 'it was not refused')
  } catch (err) {
    ok(!stopped(err) && estimates.length === before, 'a hand-off of a key the batch did not create is refused in the simulation', String(err).slice(0, 200))
  }

  console.log('\nBase mainnet: the settle checks on real chain data')
  // Mints are found from block receipts (eth_getBlockReceipts): Base's public
  // endpoint refuses eth_getLogs, which is also why the log-based resume
  // lookup needs a BASE_RPC_URL that serves it.
  const baseClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || undefined) })
  const { ZORA_1155_TOKEN_INFO_ABI } = await import('@/lib/zoraMint')
  const { PLATFORM_COLLECTION } = await import('@/lib/config')
  type RawLog = { address: Hex; topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: Hex }
  const TRANSFER_SINGLE_TOPIC = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62'
  const ZERO_TOPIC = `0x${'00'.repeat(32)}`
  const head = await baseClient.getBlockNumber()
  let found: { hash: Hex; collection: Hex; tokenId: bigint; operator: Hex; recipients: Hex[]; block: bigint } | null = null
  for (let back = 3n; back < 400n && !found; back++) {
    const receipts = (await baseClient.request({ method: 'eth_getBlockReceipts', params: [`0x${(head - back).toString(16)}`] } as never)) as { logs: RawLog[] }[]
    for (const rc of receipts ?? []) {
      const groups = new Map<string, RawLog[]>()
      for (const l of rc.logs) {
        if (l.topics[0] !== TRANSFER_SINGLE_TOPIC || l.topics[2] !== ZERO_TOPIC) continue
        const k = `${l.address}:${l.topics[1]}:${l.data.slice(0, 66)}`
        groups.set(k, [...(groups.get(k) ?? []), l])
      }
      for (const g of groups.values()) {
        found ??= {
          hash: g[0].transactionHash,
          collection: g[0].address,
          tokenId: BigInt(g[0].data.slice(0, 66)),
          operator: getAddress(`0x${g[0].topics[1].slice(26)}`),
          recipients: [...new Set(g.map((l) => getAddress(`0x${l.topics[3].slice(26)}`).toLowerCase()))] as Hex[],
          block: BigInt(g[0].blockNumber),
        }
      }
    }
  }
  if (!found) {
    ok(false, 'found an ERC-1155 mint in the last 400 blocks')
  } else {
    console.log(`       ${found.hash} — ${found.recipients.length} recipient(s) of ${found.collection} #${found.tokenId}, block ${found.block}`)
    const want = { collection: found.collection, tokenId: found.tokenId.toString(), fromBlock: (found.block - 1n).toString(), recipients: found.recipients, artist: found.operator }
    ok((await checkAirdropTx(baseClient, found.hash, want)) === found.hash, 'its receipt matches: every recipient, minted from 0x0, by its operator')
    ok((await checkAirdropTx(baseClient, found.hash, { ...want, recipients: [...found.recipients, getAddress(`0x${'ee'.repeat(20)}`)] })) === null,
      'a recipient it did not mint to fails the match')
    ok((await checkAirdropTx(baseClient, found.hash, { ...want, artist: getAddress(`0x${'ee'.repeat(20)}`) })) === null, 'another operator fails the match')
    ok((await checkAirdropTx(baseClient, found.hash, { ...want, tokenId: (found.tokenId + 1n).toString() })) === null, 'another token id fails the match')
  }
  ok((await checkAirdropTx(baseClient, `0x${'00'.repeat(31)}01`, { collection: PLATFORM_COLLECTION, tokenId: '1', fromBlock: '0', recipients: [], artist: zeroAddress })) === 'not-yet',
    'an unknown transaction is "not yet" (no receipt)')

  // getTokenInfo, on Kismet's own Zora collection (token 1 is long minted).
  const info = await baseClient.readContract({ address: PLATFORM_COLLECTION as Hex, abi: ZORA_1155_TOKEN_INFO_ABI, functionName: 'getTokenInfo', args: [1n] })
  ok(info.totalMinted > 0n, `Zora getTokenInfo decodes on a real collection (token 1: ${info.totalMinted} minted)`)
  const zoraWant = { collection: PLATFORM_COLLECTION, tokenId: '1', fromBlock: (head - 10n).toString(), artist: zeroAddress }
  const more = Array.from({ length: Number(info.totalMinted) + 1 }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, '0')}`).toLowerCase())
  ok((await findAirdrop(baseClient, { ...zoraWant, recipients: more })) === 'not-yet', 'an edition not fully minted is "not yet"')
  try {
    const none = await findAirdrop(baseClient, { ...zoraWant, recipients: more.slice(0, 1) })
    ok(none === null, 'fully minted but no matching airdrop since the mint block: null (not delivered by this drop)', none)
  } catch (err) {
    if (!String(err).includes('request limit reached')) throw err
    console.log('  SKIP  the resume path\'s log lookup — this RPC refuses eth_getLogs; set BASE_RPC_URL to one that serves it')
  }
} catch (err) {
  failed++
  console.error('\nerror:', err)
} finally {
  globalThis.fetch = realFetch
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
