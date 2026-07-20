/**
 * Wallet user-rejection phrasings, extracted pure (no sonner import) so the
 * verify harness can unit-test the classification — same pattern as
 * lib/gateFlags. lib/toast's isUserRejection pairs this message-level match
 * with the EIP-1193 numeric check (code 4001).
 *
 * The tail alternations exist for the WalletConnect relay path: mobile wallets
 * report a cancel with a NON-4001 code (-32603), which viem renders as
 * "An internal error was received. … Details: Operation cancelled by the
 * user." — word order the leading "user cancell?ed" alternation can't match.
 * Without them a mobile artist's own cancel toasts as "Mint failed — internal
 * error" (the exact misread that escalated a wallet-warning cancel into the
 * 2026-07-20 mint incident).
 */
export const REJECTION_REGEX =
  /user rejected|user denied|rejected the request|user cancell?ed|cancell?ed by the user|operation cancell?ed/i
