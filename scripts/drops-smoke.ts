// End-to-end smoke test for claim drops against the REAL services: your Bee
// node (Swarm) and Arkiv's Rabdi testnet. Runs the production modules — the
// same writeDrop / writeClaim / queries / Swarm upload the API routes call —
// minus HTTP and Redis.
//
//   npm run drops:smoke                      # throwaway drop, gone in ~20 min
//   npm run drops:smoke -- --keep            # a 7-day example drop to cite in
//                                            # arkiv/swarm.md and the README
//   npm run drops:smoke -- --image art.png   # upload your own image
//   npm run drops:smoke -- --check           # configuration only: reach both
//                                            # services, check the writer's
//                                            # funds and the batch — writes
//                                            # nothing (run it before enabling)
//
// Needs (in .env.local or the shell): ARKIV_WRITER_PRIVATE_KEY (funded with
// tGLM from hub.arkiv.network/faucet), ARKIV_ACCESS_KEY (optional),
// SWARM_BEE_URL (e.g. http://127.0.0.1:1633 for Nook) and SWARM_BATCH_ID.
//
// The artist and the collector are fresh throwaway keys each run, so the
// test proves the hand-off: the drop ends up owned by the "artist", the claim
// by the "collector", both still created by your writer.
//
// Run with the alias loader: node --experimental-strip-types --import ./scripts/register-ts-alias.mjs scripts/drops-smoke.ts

import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { formatEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { arkivPublicClient, arkivWriterAddress, isArkivConfigured, writerIsFunded } from '@/lib/arkiv/client'
import { getDrop, listClaims, listOpenDrops, writeClaim, writeDrop } from '@/lib/arkiv/drops'
import { fetchFromSwarm, getStampStatus, isSwarmUploadConfigured, swarmPublicInfo, uploadToSwarm } from '@/lib/swarm'
import {
  arkivEntityUrl,
  arkivTxUrl,
  buildClaimDropMessage,
  buildOpenDropMessage,
  CLAIM_DROP_TYPES,
  OPEN_DROP_TYPES,
  settlementRecipients,
  sniffImageType,
  validateOpenDrop,
} from '@/lib/drops'
import { KISMET_INTENT_DOMAIN } from '@/lib/intent'

// A 1×1 PNG, used when no --image is given.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const checkOnly = args.includes('--check')
const imageArg = args.indexOf('--image')
const imagePath = imageArg >= 0 ? args[imageArg + 1] : undefined

let failures = 0
function check(name: string, cond: boolean): void {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}
const nonce = () => randomBytes(16).toString('hex')

async function main(): Promise<void> {
  // ── configuration ──
  if (!isArkivConfigured()) {
    console.error('Set ARKIV_WRITER_PRIVATE_KEY (a testnet key funded at hub.arkiv.network/faucet).')
    process.exit(2)
  }
  if (!isSwarmUploadConfigured()) {
    console.error('Set SWARM_BEE_URL (your Bee/Nook node API, e.g. http://127.0.0.1:1633) and SWARM_BATCH_ID.')
    process.exit(2)
  }
  const writer = arkivWriterAddress()!
  const pub = arkivPublicClient()
  const [block, balance] = await Promise.all([pub.getBlockNumber(), pub.getBalance({ address: writer })])
  console.log(`Arkiv  Rabdi block ${block}, writer ${writer}, ${formatEther(balance)} tGLM`)
  check('the writer has tGLM for gas', balance > 0n)
  check('the writer can pay for the next 20 claims (the routes refuse writes below this)', await writerIsFunded())

  const stamp = await getStampStatus()
  const { batchId, gateway } = swarmPublicInfo()
  console.log(`Swarm  batch ${batchId} — ${stamp ? `usable=${stamp.usable}, depth ${stamp.depth}, ~${Math.floor(stamp.batchTTL / 86400)} days left` : 'node did not report the batch'}`)
  check('the postage batch is usable', stamp?.usable === true)

  if (checkOnly) {
    const enabled = process.env.DROPS_ENABLED?.trim() === '1'
    console.log(`Drops  DROPS_ENABLED=${enabled ? '1 — the routes are on' : 'unset — the routes stay off until it is 1'}`)
    console.log(failures === 0 ? '\ndrops-smoke --check: OK' : `\ndrops-smoke --check: ${failures} FAILURE(S)`)
    process.exit(failures === 0 ? 0 : 1)
  }

  // ── Swarm: upload, then read back ──
  const bytes = imagePath ? new Uint8Array(readFileSync(imagePath)) : new Uint8Array(TINY_PNG)
  const mime = sniffImageType(bytes)
  if (!mime) {
    console.error('The image must be a PNG, JPEG, GIF or WebP.')
    process.exit(2)
  }
  const { reference } = await uploadToSwarm(bytes, mime, `smoke.${mime.split('/')[1]}`)
  console.log(`Swarm  uploaded ${bytes.byteLength} bytes → ${reference}`)
  console.log(`       ${gateway}/bzz/${reference}/`)
  const back = await fetchFromSwarm(reference)
  const backBytes = back ? new Uint8Array(await back.arrayBuffer()) : new Uint8Array()
  check('the file reads back from Swarm byte-for-byte', backBytes.length === bytes.length && backBytes.every((b, i) => b === bytes[i]))

  // ── Arkiv: open a drop as a throwaway artist ──
  const artist = privateKeyToAccount(generatePrivateKey())
  const collector = privateKeyToAccount(generatePrivateKey())
  const now = Math.floor(Date.now() / 1000)
  const windowSeconds = keep ? 7 * 24 * 3600 : 10 * 60
  const validated = validateOpenDrop(
    {
      title: keep ? 'Kismet claim drop — example' : 'Kismet smoke test',
      description: 'Written by scripts/drops-smoke.ts: artwork on Swarm, drop and claim on Arkiv.',
      swarmRef: reference,
      mime,
      closesAt: now + windowSeconds,
      maxClaims: 5,
    },
    now,
  )
  if (!validated.ok) throw new Error(validated.error)
  const fields = validated.value
  // A throwaway run cleans itself up ten minutes after its window closes.
  const recordExpiresAtOverride = keep ? undefined : fields.closesAt + 10 * 60

  const openNonce = nonce()
  const intentExpiresAt = now + 300
  const openSig = await artist.signTypedData({
    domain: KISMET_INTENT_DOMAIN,
    types: OPEN_DROP_TYPES,
    primaryType: 'OpenDrop',
    message: buildOpenDropMessage(artist.address, fields, openNonce, intentExpiresAt),
  })
  const opened = await writeDrop({
    artist: artist.address,
    fields,
    intent: { signature: openSig, nonce: openNonce, expiresAt: intentExpiresAt },
    recordExpiresAtOverride,
  })
  console.log(`Arkiv  drop  ${opened.entityKey}`)
  console.log(`       ${arkivEntityUrl(opened.entityKey)}`)
  console.log(`       tx ${arkivTxUrl(opened.txHash)}`)

  // ── Arkiv: claim it as a throwaway collector ──
  const claimNonce = nonce()
  const claimSig = await collector.signTypedData({
    domain: KISMET_INTENT_DOMAIN,
    types: CLAIM_DROP_TYPES,
    primaryType: 'ClaimDrop',
    message: buildClaimDropMessage(collector.address, opened.entityKey, claimNonce, intentExpiresAt),
  })
  const claimed = await writeClaim({
    dropKey: opened.entityKey,
    dropClosesAt: fields.closesAt,
    collector: collector.address,
    claimedAt: now,
    intent: { signature: claimSig, nonce: claimNonce, expiresAt: intentExpiresAt },
    recordExpiresAtOverride,
  })
  console.log(`Arkiv  claim ${claimed.entityKey}`)

  // ── reads: exactly the queries the app runs ──
  const drop = await getDrop(opened.entityKey)
  check('getDrop finds the drop', drop !== null)
  check('the drop is owned by the artist (hand-off worked)', drop?.owner === artist.address.toLowerCase())
  check('the drop records the Swarm reference', drop?.swarmRef === reference)
  const open = await listOpenDrops(Math.floor(Date.now() / 1000))
  const listed = open.find((d) => d.key === opened.entityKey.toLowerCase())
  check('the drop is in the open-drops query with 1 claim counted', listed?.claimCount === 1)
  const claims = await listClaims(opened.entityKey)
  check('listClaims returns the claim, owned by the collector (hand-off worked)',
    claims.length === 1 && claims[0].key === claimed.entityKey.toLowerCase() && claims[0].owner === collector.address.toLowerCase())
  check('the airdrop list is the collector, then the artist',
    settlementRecipients(claims, artist.address).join() === [collector.address, artist.address].join().toLowerCase())

  console.log(`\nFor arkiv/swarm.md: drop entity ${opened.entityKey} → Swarm reference ${reference}`)
  console.log(keep ? 'Kept: the drop is open for 7 days and stays on Arkiv 7 more.' : 'Throwaway: these entities expire about 20 minutes from now.')
  console.log(failures === 0 ? '\ndrops-smoke: OK' : `\ndrops-smoke: ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('drops-smoke failed:', err)
  process.exit(1)
})
