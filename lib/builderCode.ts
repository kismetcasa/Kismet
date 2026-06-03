import { concat, size, stringToHex, toHex, type Hex } from 'viem'

// Base Builder Code attribution (ERC-8021). The code string is issued at
// base.dev (Settings → Builder Code) and supplied via env so it isn't
// baked into the repo and preview/staging deploys can carry their own (or
// none). We encode it to the calldata suffix once at module load.
//
// We inline the ERC-8021 schema-0 encoding rather than import
// `ox/erc8021`'s `Attribution.toDataSuffix`: that import pulls ~120KB of
// ox into every client bundle that touches a wallet write (it tripped the
// /mint bundle-size gate). viem is already bundled everywhere, so the
// primitives below cost ~0. The layout below is the canonical schema-0
// encoding and is verified byte-for-byte against `Attribution.toDataSuffix`
// for single codes (incl. the `bc_…` form base.dev issues):
//
//   [ code ASCII ] ∥ [ code length: 1 byte ] ∥ [ schema id: 0x00 ] ∥
//   [ 16-byte ERC-8021 marker: 0x80218021802180218021802180218021 ]
//
// Single code only — base.dev issues one code per app. (ox joins multiple
// codes with ",", which we don't need.) Unset env → undefined, which viem
// treats as "no suffix", so every write path is a no-op until the code is
// configured.
const ERC8021_MARKER = '0x80218021802180218021802180218021' as const

function encodeBuilderSuffix(): Hex | undefined {
  const code = process.env.NEXT_PUBLIC_BUILDER_CODE?.trim()
  if (!code) return undefined
  try {
    const codeHex = stringToHex(code)
    return concat([codeHex, toHex(size(codeHex), { size: 1 }), '0x00', ERC8021_MARKER])
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
