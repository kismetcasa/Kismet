import { NextRequest, NextResponse } from 'next/server'
import {
  parseWebhookEvent,
  createVerifyAppKeyWithHub,
} from '@farcaster/miniapp-node'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { clearTokens, registerToken } from '@/lib/farcasterNotifications'

// Farcaster Mini App webhook endpoint.
//
// Receives four event types from the host whenever a user changes their
// notification relationship with Kismet:
//
//   miniapp_added         — user tapped "Add Mini App". Body may include
//                            notificationDetails if they granted permission
//                            at the same time.
//   miniapp_removed       — user removed the app. All tokens invalidated.
//   notifications_enabled — user re-enabled notifications after having them off.
//                            notificationDetails always present.
//   notifications_disabled— user turned off notifications (but kept the app).
//
// Security: the payload is a JSON Farcaster Signature envelope (header,
// payload, signature, base64url-encoded). parseWebhookEvent verifies the
// ed25519 signature and confirms the signer key is currently registered as
// an app key for the claimed FID via a Hub onchain-signers lookup. Without
// this gate anyone could POST a forged "miniapp_added" claiming any FID
// and direct future notifications for that user to a malicious URL.
//
// Hub: defaults to https://hub.farcaster.xyz. Override with FARCASTER_HUB_URL
// for a private hub (Neynar / self-hosted). Hub call is the only network
// dependency on the critical path of this endpoint; everything else is Redis.

const HUB_URL = process.env.FARCASTER_HUB_URL?.replace(/\/$/, '') ?? 'https://hub.farcaster.xyz'

// VerifyAppKey constructor is sync; reuse one instance for connection
// keep-alive and to avoid per-request allocation.
const verifyAppKey = createVerifyAppKeyWithHub(HUB_URL)

export async function POST(req: NextRequest) {
  // Coarse IP rate-limit. Real abuse rejected by signature verification
  // below; this just prevents a DoS via signature-verify floods.
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`fc-webhook:${ip}`, 60, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  let result
  try {
    result = await parseWebhookEvent(raw, verifyAppKey)
  } catch (err) {
    // Cause includes the specific error class (signature mismatch,
    // unrecognised app key, malformed payload). Log the class name only —
    // we never log the body since it might contain notification tokens.
    const name = err instanceof Error ? err.name : 'unknown'
    console.warn('[fc-webhook] signature verification failed:', name)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const { fid, event } = result

  try {
    switch (event.event) {
      case 'miniapp_added': {
        // notificationDetails are optional on add — present when the user
        // also granted notification permission in the same flow, absent
        // when they added but kept notifications off (separate webhook
        // later if they enable them).
        if (event.notificationDetails) {
          await registerToken(fid, {
            url: event.notificationDetails.url,
            token: event.notificationDetails.token,
          })
        }
        break
      }
      case 'miniapp_removed': {
        // The user uninstalled. Every token they had with us is now
        // invalid; the host won't accept POSTs to them. Clear the lot.
        await clearTokens(fid)
        break
      }
      case 'notifications_enabled': {
        // Always carries notificationDetails. May fire after a
        // notifications_disabled — register normalises so a re-enable
        // is idempotent and re-seeds the default opt-in only on a true
        // first-time grant.
        await registerToken(fid, {
          url: event.notificationDetails.url,
          token: event.notificationDetails.token,
        })
        break
      }
      case 'notifications_disabled': {
        // User kept the app but turned notifications off. We don't get
        // the exact (url, token) here — wipe everything. They'll re-issue
        // a fresh token via notifications_enabled if they turn it back on.
        await clearTokens(fid)
        break
      }
      default: {
        // Unknown event — accept it so the host doesn't retry forever,
        // but record the type for diagnostics.
        const unknown: { event?: string } = event
        console.warn('[fc-webhook] unknown event type:', unknown.event)
      }
    }
  } catch (err) {
    // Storage failure shouldn't 5xx — webhook deliveries are retried by
    // the host which could double-write on transient blips. Log and 200.
    console.warn('[fc-webhook] storage error:', err)
  }

  return NextResponse.json({ ok: true })
}
