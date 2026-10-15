// Farcaster Mini App haptic feedback.
//
// Fire-and-forget wrapper around sdk.haptics.notificationOccurred so call
// sites stay one-liners. Gracefully no-ops on:
//   - Hosts that don't expose the haptics capability (older clients, web FC)
//   - Devices with haptics disabled in OS settings
//   - Any other SDK failure
//
// Call sites must pre-gate on isInMiniApp before invoking — otherwise the
// dynamic import would load the @farcaster/miniapp-sdk chunk for regular
// web users on every success path. Inside a Mini App, FarcasterProvider
// has already loaded the SDK so the import resolves from cache instantly.

export function hapticNotifySuccess(): void {
  void import('@farcaster/miniapp-sdk')
    .then(({ sdk }) => sdk.haptics.notificationOccurred('success').catch(() => {}))
    .catch(() => {})
}

/** The light tick of a selection change — a page turn in the zine reader.
 *  Same gating rule as above: call only inside a Mini App. */
export function hapticSelection(): void {
  void import('@farcaster/miniapp-sdk')
    .then(({ sdk }) => sdk.haptics.selectionChanged().catch(() => {}))
    .catch(() => {})
}
