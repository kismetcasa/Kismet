import { NextResponse } from 'next/server'

// Farcaster Mini App manifest served at /.well-known/farcaster.json.
//
// All asset URLs, copy fields, and the signed accountAssociation block
// are env-driven so brand assets and the signature can be rotated without
// touching code. When FARCASTER_HEADER/PAYLOAD/SIGNATURE are unset the
// manifest still serves (preview tool works, embeds render) — but the
// app won't be indexed in the Farcaster directory and can't send
// notifications until the accountAssociation is signed via Farcaster's
// Mini App Manifest tool at https://farcaster.xyz/~/developers/new
// (enter `kismet.art` as the domain).
//
// Spec: https://miniapps.farcaster.xyz/docs/specification#manifest
// Publishing guide: https://miniapps.farcaster.xyz/docs/guides/publishing

// Revalidate hourly so env-driven changes (new icon URL, signed account
// association) propagate without a redeploy. Farcaster's indexer crawls
// daily, so 1h freshness is plenty.
export const revalidate = 3600

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://kismet.art'

function envOrDefault(key: string, fallback: string): string {
  const v = process.env[key]
  return v && v.length > 0 ? v : fallback
}

export async function GET() {
  const header = process.env.FARCASTER_HEADER
  const payload = process.env.FARCASTER_PAYLOAD
  const signature = process.env.FARCASTER_SIGNATURE
  const accountAssociation =
    header && payload && signature ? { header, payload, signature } : undefined

  const miniapp = {
    version: '1',
    name: envOrDefault('NEXT_PUBLIC_FARCASTER_APP_NAME', 'Kismet Art'),
    iconUrl: envOrDefault('NEXT_PUBLIC_FARCASTER_ICON_URL', `${SITE_URL}/icon.png`),
    homeUrl: SITE_URL,
    splashImageUrl: envOrDefault(
      'NEXT_PUBLIC_FARCASTER_SPLASH_URL',
      `${SITE_URL}/splash.png`,
    ),
    splashBackgroundColor: envOrDefault(
      'NEXT_PUBLIC_FARCASTER_SPLASH_BG',
      '#0d0d0d',
    ),
    description: envOrDefault(
      'NEXT_PUBLIC_FARCASTER_DESCRIPTION',
      'mint, collect, and discover art on Kismet Art',
    ),
    subtitle: envOrDefault('NEXT_PUBLIC_FARCASTER_SUBTITLE', 'Art on Base'),
    tagline: envOrDefault('NEXT_PUBLIC_FARCASTER_TAGLINE', 'mint, collect, discover'),
    primaryCategory: envOrDefault('NEXT_PUBLIC_FARCASTER_CATEGORY', 'art-creativity'),
    // Base only — matches lib/wagmi.ts. Hosts that don't support Base will
    // refuse to render rather than failing mid-transaction.
    requiredChains: ['eip155:8453'],
    // Hosts that don't support wallet.getEthereumProvider can't render
    // Kismet at all (mint/collect both need a wallet), so declaring it
    // required is correct — they refuse upfront rather than crash on
    // first interaction. Quick Auth lives at sdk.quickAuth.* and isn't
    // a declarable capability; sdk.actions.signin is intentionally
    // omitted because we use Quick Auth (not the signin action), so
    // declaring it would only cause hosts that lack it to wrongly
    // refuse our app.
    requiredCapabilities: ['wallet.getEthereumProvider'],
    // Webhook endpoint for the four lifecycle events (miniapp_added,
    // miniapp_removed, notifications_enabled, notifications_disabled).
    // Host POSTs a JFS-signed payload — see app/api/farcaster/webhook
    // for signature verification + token storage.
    webhookUrl: `${SITE_URL}/api/farcaster/webhook`,
    // Manifest-level imageUrl and buttonTitle are deprecated as of SDK
    // 0.0.35 (April 2025) — per-page embeds (see lib/farcasterEmbed.ts
    // + each page's generateMetadata) carry the image and button text
    // at the embed level instead.
  }

  return NextResponse.json(accountAssociation ? { accountAssociation, miniapp } : { miniapp })
}
