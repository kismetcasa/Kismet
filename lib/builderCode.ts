import { Attribution } from 'ox/erc8021'
import type { Hex } from 'viem'

// Base Builder Code attribution (ERC-8021). The code string is issued at
// base.dev (Settings → Builder Code) and supplied via env so it isn't
// baked into the repo and preview/staging deploys can carry their own (or
// none). We encode it to the calldata suffix once at module load via ox's
// canonical encoder — never hand-write the hex: the layout is
// [codes ASCII][length byte][schema 0x00][16-byte 8021 marker] and a
// malformed suffix is silently dropped by Base's indexers.
//
// Unset code → undefined, which viem treats as "no suffix", so every write
// path below is a no-op until NEXT_PUBLIC_BUILDER_CODE is provided.
function encodeBuilderSuffix(): Hex | undefined {
  const code = process.env.NEXT_PUBLIC_BUILDER_CODE?.trim()
  if (!code) return undefined
  try {
    return Attribution.toDataSuffix({ codes: [code] })
  } catch {
    // A malformed code must not brick the app at module load. Drop
    // attribution and continue; zero attributed txs on base.dev is the
    // signal to fix the env value.
    return undefined
  }
}

// Plain-hex suffix for the EOA path — pass straight to viem/wagmi's
// `dataSuffix` on writeContract / sendTransaction. viem appends it to
// calldata (best-effort; smart contracts ignore the trailing bytes).
export const BUILDER_DATA_SUFFIX = encodeBuilderSuffix()

// EIP-5792 (wallet_sendCalls) carries attribution as a wallet capability
// rather than appended calldata. optional:true → wallets that don't
// implement the capability still process the batch (just unattributed)
// instead of rejecting it. Undefined when no code is set so callers can
// pass `capabilities: builderCodeCapabilities` and omit it entirely.
export const builderCodeCapabilities = BUILDER_DATA_SUFFIX
  ? { dataSuffix: { value: BUILDER_DATA_SUFFIX, optional: true } }
  : undefined
