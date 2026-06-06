import { concat, type Hex } from 'viem'
import { BUILDER_DATA_SUFFIX } from '@/lib/builderCode'

/**
 * Append Kismet's ERC-8021 builder-code suffix to calldata so agent-built
 * calls keep the same platform attribution the web app's EOA path applies via
 * viem's `dataSuffix` (see lib/builderCode.ts). Best-effort: the target
 * contract ignores the trailing bytes (ABI decoding reads only the declared
 * params) and ERC-8021 indexers read the suffix.
 *
 * We append to calldata rather than passing the EIP-5792 `dataSuffix`
 * capability so attribution survives regardless of whether the executing
 * wallet forwards capabilities — and we deliberately never do both, which
 * would double-encode the suffix.
 */
export function withBuilderSuffix(data: Hex): Hex {
  return BUILDER_DATA_SUFFIX ? concat([data, BUILDER_DATA_SUFFIX]) : data
}
