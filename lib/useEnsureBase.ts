import { useAccount, useSwitchChain } from 'wagmi'
import { base } from 'wagmi/chains'

// Returns an async fn that resolves once the wallet is on Base.
// Silent no-op if already on Base; prompts the wallet to switch otherwise.
// Call before any writeContractAsync so transactions can't accidentally land on the wrong chain.
export function useEnsureBase() {
  const { chain } = useAccount()
  const { switchChainAsync } = useSwitchChain()

  return async () => {
    if (chain?.id === base.id) return
    await switchChainAsync({ chainId: base.id })
  }
}
