// Builds the `fc:miniapp` (and legacy `fc:frame`) meta tag values for a
// Farcaster Mini App embed. Drop the return value into a Next.js
// Metadata.other object on any page to make that URL render as a rich,
// launchable card when shared in a cast.
//
// Both `fc:miniapp` (current) and `fc:frame` (legacy parsers) are emitted
// so older Farcaster clients still resolve the embed correctly. The only
// difference between the two payloads is the `action.type` discriminator
// — `launch_miniapp` vs `launch_frame`.
//
// Spec: https://miniapps.farcaster.xyz/docs/specification

export type FarcasterEmbedAction = {
  /** Page URL the host should open. Defaults to the current page URL when omitted. */
  url?: string
  /** App name override. Defaults to manifest.name. */
  name?: string
  /** Splash image override. Defaults to manifest.splashImageUrl. Must be 200x200 PNG. */
  splashImageUrl?: string
  /** Splash bg override. Defaults to manifest.splashBackgroundColor. */
  splashBackgroundColor?: string
}

export type FarcasterEmbedInput = {
  /** 3:2 PNG; 600x400 min, 3000x2000 max, ≤10MB, URL ≤1024 chars. */
  imageUrl: string
  /** Button text. Spec caps at 32 chars; longer strings are truncated. */
  buttonTitle: string
  action?: FarcasterEmbedAction
}

export function buildFarcasterEmbed(
  input: FarcasterEmbedInput,
): Record<string, string> {
  const action = input.action ?? {}
  const button = { title: input.buttonTitle.slice(0, 32) }

  const miniappPayload = {
    version: '1' as const,
    imageUrl: input.imageUrl,
    button: { ...button, action: { type: 'launch_miniapp' as const, ...action } },
  }

  const framePayload = {
    version: '1' as const,
    imageUrl: input.imageUrl,
    button: { ...button, action: { type: 'launch_frame' as const, ...action } },
  }

  return {
    'fc:miniapp': JSON.stringify(miniappPayload),
    'fc:frame': JSON.stringify(framePayload),
  }
}
