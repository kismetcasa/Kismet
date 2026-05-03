// Comma-separated list of Arweave/EVM/Solana addresses whose Turbo credits
// this deployment is approved to spend. Read at every upload so a single env
// change covers metadata uploads, media uploads, and any future flows.
export function getPaidBy(): string[] | undefined {
  const raw = process.env.NEXT_PUBLIC_ARWEAVE_PAID_BY
  if (!raw) return undefined
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return list.length > 0 ? list : undefined
}
