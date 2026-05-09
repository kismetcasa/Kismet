import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, http, verifyMessage } from 'viem'
import { mainnet } from 'viem/chains'
import { isAddress } from '@/lib/address'
import { recordAirdrop } from '@/lib/airdrops'
import { ADMIN_ADDRESS } from '@/lib/config'
import { getMomentMeta, writeNotification } from '@/lib/notifications'
import { redis } from '@/lib/redis'

const SESSION_TTL = 4 * 60 * 60 * 1000

// Mainnet client purely for ENS lookups — recipients can be passed as
// names (`alice.eth`) instead of addresses, since the most common case
// for a manual backfill is a creator giving you a recipient handle, not
// a hex string.
const mainnetClient = createPublicClient({
  chain: mainnet,
  transport: http(process.env.MAINNET_RPC_URL),
})

async function verifyAdminSession(body: {
  signature?: string
  timestamp?: number
}): Promise<{ error: string; status: number } | null> {
  if (!ADMIN_ADDRESS) return { error: 'Admin not configured', status: 403 }
  if (!body.signature || body.timestamp == null) {
    return { error: 'signature and timestamp required', status: 400 }
  }
  if (Date.now() - body.timestamp > SESSION_TTL) {
    return { error: 'Session expired — please sign in again', status: 401 }
  }
  const message = `Kismet Art admin session\nAddress: ${ADMIN_ADDRESS}\nTimestamp: ${body.timestamp}`
  const verified = await verifyMessage({
    address: ADMIN_ADDRESS as `0x${string}`,
    message,
    signature: body.signature as `0x${string}`,
  })
  if (!verified) return { error: 'Signature verification failed', status: 401 }
  return null
}

async function resolveRecipient(value: string): Promise<string | null> {
  const trimmed = value.trim()
  if (isAddress(trimmed)) return trimmed.toLowerCase()
  if (trimmed.endsWith('.eth')) {
    try {
      const addr = await mainnetClient.getEnsAddress({ name: trimmed })
      return addr ? addr.toLowerCase() : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Admin-gated backfill of an airdrop that landed before
 * `POST /api/airdrop/notify` existed (anything pre-this-PR went on-chain
 * via `useAirdrop` but never hit our Redis stores). Mirrors the live
 * notify route's three side-effects per recipient — sender airdrop log,
 * recipient collected zset, recipient inbox notification — so the same
 * surfaces light up retroactively.
 *
 * Auth follows the existing admin-session pattern (see permissions/audit):
 * the admin signs `Kismet Art admin session\nAddress: <admin>\nTimestamp: <ms>`
 * and posts the signature + timestamp alongside the airdrop body.
 *
 * Recipients accept either 0x-addresses or `*.eth` names; ENS resolution
 * runs against MAINNET_RPC_URL. Unresolvable entries are reported back
 * in the response so the admin can fix and retry without redoing the
 * already-written ones (recordAirdrop is idempotent at the JSON level —
 * a second call with the same {recipient, timestamp, ...} produces an
 * identical zset member, deduped by Redis).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    signature?: string
    timestamp?: number
    sender?: string
    collectionAddress?: string
    tokenId?: string | number
    recipients?: string[]
    txHash?: string
    // Backdates the entries to the actual airdrop time if the admin
    // knows it (epoch ms). Defaults to now when omitted.
    airdropTimestamp?: number
  } | null

  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const authErr = await verifyAdminSession(body)
  if (authErr) return NextResponse.json({ error: authErr.error }, { status: authErr.status })

  const sender = body.sender?.toLowerCase()
  const collectionAddress = body.collectionAddress?.toLowerCase()
  const tokenId = body.tokenId !== undefined && body.tokenId !== null ? String(body.tokenId) : null
  const recipientsInput = Array.isArray(body.recipients) ? body.recipients : []
  const txHash = body.txHash
  const recordTimestamp = body.airdropTimestamp ?? Date.now()

  if (!sender || !isAddress(sender)) {
    return NextResponse.json({ error: 'Invalid sender' }, { status: 400 })
  }
  if (!collectionAddress || !isAddress(collectionAddress)) {
    return NextResponse.json({ error: 'Invalid collectionAddress' }, { status: 400 })
  }
  if (!tokenId || !/^\d+$/.test(tokenId)) {
    return NextResponse.json({ error: 'Invalid tokenId' }, { status: 400 })
  }
  if (recipientsInput.length === 0) {
    return NextResponse.json({ error: 'No recipients' }, { status: 400 })
  }
  if (recipientsInput.length > 200) {
    return NextResponse.json({ error: 'Too many recipients' }, { status: 400 })
  }
  if (txHash && !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return NextResponse.json({ error: 'Invalid txHash' }, { status: 400 })
  }

  const resolved = await Promise.all(
    recipientsInput.map(async (r) => ({
      input: r,
      address: typeof r === 'string' ? await resolveRecipient(r) : null,
    })),
  )
  const validRecipients = resolved
    .map((r) => r.address)
    .filter((a): a is string => !!a && isAddress(a))
  const unresolved = resolved.filter((r) => !r.address).map((r) => r.input)
  if (validRecipients.length === 0) {
    return NextResponse.json(
      { error: 'No resolvable recipients', unresolved },
      { status: 400 },
    )
  }

  const meta = await getMomentMeta(collectionAddress, tokenId).catch(() => null)
  const tokenName = meta?.name

  await Promise.all(
    validRecipients.map(async (recipient) => {
      try {
        await recordAirdrop(sender, {
          collectionAddress,
          tokenId,
          recipient: { address: recipient },
          amount: 1,
          ...(txHash ? { txHash } : {}),
          timestamp: recordTimestamp,
        })
      } catch {
        // best-effort
      }
      try {
        await redis.zadd(`kismetart:collected:${recipient}`, {
          score: recordTimestamp,
          member: `${collectionAddress}:${tokenId}`,
        })
      } catch {
        // best-effort
      }
      if (recipient === sender) return
      void writeNotification({
        type: 'airdrop',
        recipient,
        actor: sender,
        tokenAddress: collectionAddress,
        tokenId,
        ...(tokenName ? { tokenName } : {}),
        amount: 1,
      })
    }),
  )

  return NextResponse.json({
    ok: true,
    backfilled: validRecipients.length,
    recipients: validRecipients,
    unresolved,
  })
}
