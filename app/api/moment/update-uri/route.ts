import { NextResponse } from 'next/server'

/**
 * RETIRED 2026-09 — artwork metadata edits are now a direct, artist-signed
 * `updateTokenURI` from the connected wallet (hooks/useUpdateMomentUri; the
 * incident record lives in lib/momentUriEdit.ts). This route used to relay
 * the edit through inprocess's PATCH /moment under the platform API key,
 * which executes as the KEY OWNER's smart wallet and fails with "No authorized
 * smart wallet found for collection …" on every collection that never granted
 * that wallet ADMIN (all first-mint collections) — while Kismet's pencil and
 * preflight had authorized the artist's own wallet.
 *
 * Kept as a 410 tombstone rather than deleted, for the reason next.config.mjs
 * aliases /api/artwork/*: a long-lived tab or webview still running the old
 * bundle POSTs here, and its toast prints this `error` string verbatim, so the
 * stale client gets an actionable instruction instead of a bare 404. Safe to
 * delete once stale bundles have aged out. Never re-add an inprocess call
 * here: scripts/verify-metadata-edit.ts fails CI if the platform key is sent
 * from anywhere but the mint / distribute relays.
 */
export async function POST() {
  return NextResponse.json(
    { error: 'Kismet updated its editor — reload the page and save again from your wallet' },
    { status: 410 },
  )
}
