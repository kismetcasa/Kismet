import { NextResponse } from 'next/server'

// Farcaster Mini App manifest served at /.well-known/farcaster.json.
//
// All asset URLs, copy fields, and the signed accountAssociation block
// are env-driven so brand assets and the signature can be rotated without
// touching code. When FARCASTER_HEADER/PAYLOAD/SIGNATURE are unset the
// manifest still serves (preview tool works, embeds render) — but the
// app won't be indexed in the Farcaster directory and can't send
// notifications until the accountAssociation is signed via:
//   https://farcaster.xyz/~/developers/mini-apps/manifest?domain=kismet.art
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
    imageUrl: envOrDefault(
      'NEXT_PUBLIC_FARCASTER_EMBED_IMAGE_URL',
      `${SITE_URL}/embed-default.png`,
    ),
    buttonTitle: envOrDefault('NEXT_PUBLIC_FARCASTER_BUTTON_TITLE', 'Open Kismet'),
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
    // Hard requirements; without these the app cannot function. Optional
    // capabilities (composeCast, swapToken, sendToken, haptics) are not
    // declared so the app still renders on hosts that lack them.
    requiredCapabilities: ['actions.signIn', 'wallet.getEthereumProvider'],
  }

  return NextResponse.json(accountAssociation ? { accountAssociation, miniapp } : { miniapp })
}
