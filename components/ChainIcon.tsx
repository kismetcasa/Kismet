import { MAINNET_CHAIN_ID } from '@/lib/chains'

/**
 * Small chain glyph for the mint UI: Base's solid blue square, or Ethereum's
 * diamond. viewBox-normalized so a single `className` (e.g. `w-4 h-4`) sizes it.
 * Decorative-but-labeled (role/aria-label) so it reads as the chain name to AT.
 */
export function ChainIcon({
  chainId,
  className = 'w-4 h-4',
}: {
  chainId: number
  className?: string
}) {
  if (chainId === MAINNET_CHAIN_ID) {
    return (
      <svg viewBox="0 0 24 24" className={className} role="img" aria-label="Ethereum">
        <path d="M12 2 6 12l6 3.5z" fill="#627EEA" fillOpacity="0.6" />
        <path d="M12 2 18 12l-6 3.5z" fill="#627EEA" />
        <path d="M12 16.4 6 13l6 9z" fill="#627EEA" fillOpacity="0.6" />
        <path d="M12 16.4 18 13l-6 9z" fill="#627EEA" />
      </svg>
    )
  }
  // Base (default) — the solid blue square brand mark.
  return (
    <svg viewBox="0 0 24 24" className={className} role="img" aria-label="Base">
      <rect width="24" height="24" rx="5" fill="#0000FF" />
    </svg>
  )
}
