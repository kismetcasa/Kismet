'use client'

import { useEffect, useState } from 'react'
import { useAccount, useBalance, useReadContract, useSignMessage, useWriteContract } from 'wagmi'
import { zeroAddress } from 'viem'
import { toast } from 'sonner'
import { BASE_CHAIN_ID, getChain } from '@/lib/chains'
import { ERC20_ABI, ZORA_CREATOR_REWARD_RECIPIENT_ABI, usdcAddress } from '@/lib/zoraMint'
import {
  SPLIT_MAIN_ABI,
  splitMainAddress,
  reconstructSplitParams,
  DISTRIBUTOR_FEE,
} from '@/lib/splitMain'
import { useEnsureChain } from '@/lib/useEnsureBase'
import { BUILDER_DATA_SUFFIX } from '@/lib/builderCode'
import { formatPrice } from '@/lib/inprocess'
import { toastError } from '@/lib/toast'
import type { SplitRecipient } from '@/lib/splits'
import type { CollectCurrency } from '@/hooks/useDirectCollect'

interface Options {
  address: string
  tokenId: string
  // Chain the moment lives on. Drives the balance reads + the distribute/withdraw
  // path: Base uses the sponsored relay; mainnet is user-paid 0xSplits-direct
  // (gated by splitsVerified). Defaults to Base.
  chainId?: number
  // Creator (resolved EOA) or a moment admin per the parent view. Either
  // grants distribute rights; recipients are detected here from the stored
  // split list. The distribute API authorizes the same roles.
  isCreator: boolean
  isAdmin: boolean
  // Kismet platform admin (ADMIN_ADDRESS) — a break-glass role that may
  // distribute any moment's splits (e.g. to unstick a payout a user reports
  // as missing). The distribute API authorizes the same address; the
  // signature gate keeps it to the real admin EOA.
  isPlatformAdmin: boolean
  // Sale currency of the moment — selects which balance to read off the
  // split contract (native ETH vs USDC) and which token inprocess distributes.
  currency: CollectCurrency
}

interface SplitsState {
  hasSplits: boolean
  recipients: SplitRecipient[]
  splitAddress: `0x${string}` | undefined
  // True when the connected wallet may trigger a distribution: creator,
  // moment admin, split recipient, or platform admin.
  canDistribute: boolean
  // True when the connected wallet is one of the split recipients. Lets the
  // view distinguish a recipient/creator from a platform-admin override.
  isRecipient: boolean
  // Undistributed proceeds sitting on the split, formatted for display
  // (e.g. "0.5 ETH" / "$5"). undefined while the balance read is pending.
  pendingFormatted: string | undefined
  // The connected wallet's share of `pendingFormatted` (balance × their %).
  // undefined when the viewer isn't a recipient or the read is pending.
  pendingShareFormatted: string | undefined
  // True when there's a non-zero balance to distribute. Gates the button so
  // we don't sponsor a no-op tx.
  hasPending: boolean
  distribute: (currency: CollectCurrency) => Promise<void>
  distributing: boolean
  distributeHash: string | null
  // User-paid chains only (mainnet): after a distribute, the connected
  // recipient's share sits in SplitMain until they pull it. `claimableFormatted`
  // is their withdrawable balance; `withdraw` is the pull. Base settles via the
  // relay, so these stay inert there (hasClaimable false).
  claimableFormatted: string | undefined
  hasClaimable: boolean
  withdraw: (currency: CollectCurrency) => Promise<void>
  withdrawing: boolean
  withdrawHash: string | null
}

/**
 * Bundles the splits state for MomentDetailView: the stored recipient list
 * (rendered for every viewer in the splits panel) plus the distribute flow
 * for the creator, moment admins, recipients, and the platform admin.
 *
 * `splitAddress`, the balance reads, and the distribute action are gated on
 * `canDistribute` because only those roles use them. `currency` selects the
 * balance to read (and is what inprocess needs as `tokenAddress=USDC_BASE`
 * for USDC moments, else it defaults to ETH and distributes nothing from a
 * USDC split).
 */
export function useMomentSplits({ address, tokenId, chainId = BASE_CHAIN_ID, isCreator, isAdmin, isPlatformAdmin, currency }: Options): SplitsState {
  const { address: connectedAddress } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const { writeContractAsync } = useWriteContract()
  const ensureChain = useEnsureChain()
  const [hasSplits, setHasSplits] = useState(false)
  const [recipients, setRecipients] = useState<SplitRecipient[]>([])
  const [distributing, setDistributing] = useState(false)
  const [distributeHash, setDistributeHash] = useState<string | null>(null)
  const [withdrawing, setWithdrawing] = useState(false)
  const [withdrawHash, setWithdrawHash] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setHasSplits(false)
    setRecipients([])
    fetch(`/api/moment/splits?collectionAddress=${address}&tokenId=${tokenId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (cancelled) return
        setHasSplits(d.hasSplits === true)
        setRecipients(Array.isArray(d.recipients) ? d.recipients : [])
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [address, tokenId])

  const connectedLower = connectedAddress?.toLowerCase()
  const viewerRecipient = connectedLower
    ? recipients.find((r) => r.address.toLowerCase() === connectedLower)
    : undefined
  const canDistribute = hasSplits && (isCreator || isAdmin || isPlatformAdmin || !!viewerRecipient)

  const { data: splitAddress } = useReadContract({
    chainId,
    address: address as `0x${string}`,
    abi: ZORA_CREATOR_REWARD_RECIPIENT_ABI,
    functionName: 'getCreatorRewardRecipient',
    args: [BigInt(tokenId)],
    query: { enabled: canDistribute },
  })

  // Undistributed proceeds live on the split contract until distribute is
  // called. ETH moments read the native balance; USDC moments read the ERC20
  // balance. Both hooks are declared unconditionally (rules of hooks) and
  // gated to the relevant currency via `enabled`.
  const { data: ethBalance } = useBalance({
    address: splitAddress,
    chainId,
    query: { enabled: canDistribute && !!splitAddress && currency === 'eth' },
  })
  const { data: usdcBalance } = useReadContract({
    chainId,
    address: usdcAddress(chainId),
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: splitAddress ? [splitAddress] : undefined,
    query: { enabled: canDistribute && !!splitAddress && currency === 'usdc' },
  })

  const pendingRaw = currency === 'usdc' ? usdcBalance : ethBalance?.value
  const hasPending = pendingRaw !== undefined && pendingRaw > 0n
  const pendingFormatted =
    pendingRaw === undefined ? undefined : formatPrice(pendingRaw.toString(), currency)
  const pendingShareFormatted =
    pendingRaw === undefined || !viewerRecipient
      ? undefined
      : formatPrice(
          ((pendingRaw * BigInt(viewerRecipient.percentAllocation)) / 100n).toString(),
          currency,
        )

  // On user-paid chains, distribute pushes each recipient's share into SplitMain
  // (not their wallet). The connected recipient pulls it with withdraw; read
  // their claimable balance to drive that button. Inert on Base (relay-settled).
  const claimableEnabled =
    !getChain(chainId).sponsoredMint &&
    getChain(chainId).splitsVerified &&
    !!viewerRecipient &&
    !!connectedAddress
  const { data: claimableEth } = useReadContract({
    chainId,
    address: splitMainAddress(chainId),
    abi: SPLIT_MAIN_ABI,
    functionName: 'getETHBalance',
    args: connectedAddress ? [connectedAddress] : undefined,
    query: { enabled: claimableEnabled && currency === 'eth' },
  })
  const { data: claimableUsdc } = useReadContract({
    chainId,
    address: splitMainAddress(chainId),
    abi: SPLIT_MAIN_ABI,
    functionName: 'getERC20Balance',
    args: connectedAddress ? [connectedAddress, usdcAddress(chainId)] : undefined,
    query: { enabled: claimableEnabled && currency === 'usdc' },
  })
  const claimableRaw = currency === 'usdc' ? claimableUsdc : claimableEth
  const hasClaimable = claimableRaw !== undefined && claimableRaw > 0n
  const claimableFormatted =
    claimableRaw === undefined ? undefined : formatPrice(claimableRaw.toString(), currency)

  async function distribute(currency: CollectCurrency) {
    if (!splitAddress) { toast.error('Split address not found'); return }
    if (!connectedAddress) { toast.error('Wallet not connected'); return }
    const addr = splitAddress

    // Non-sponsored chains (mainnet): user-paid 0xSplits-direct. Base keeps the
    // sponsored relay below, byte-for-byte unchanged. 0xSplits distribute is
    // permissionless — whoever clicks pays gas; funds still flow only to the
    // fixed recipients.
    if (!getChain(chainId).sponsoredMint) {
      // Gated until SplitMain is confirmed on-chain for this chain (and we mint
      // v1 splits there). Until then, preserve the prior "coming soon" UX.
      if (!getChain(chainId).splitsVerified) {
        toast.error('Distribution on Ethereum is coming soon')
        return
      }
      if (recipients.length < 2) {
        toast.error('Split recipients not loaded yet')
        return
      }
      setDistributing(true)
      try {
        await ensureChain(chainId)
        // Rebuild the exact params the split was created with (same helper used
        // at mint) — SplitMain's hash check reverts on any mismatch.
        const { accounts, percentAllocations } = reconstructSplitParams(recipients)
        const hash =
          currency === 'usdc'
            ? await writeContractAsync({
                chainId,
                address: splitMainAddress(chainId),
                abi: SPLIT_MAIN_ABI,
                functionName: 'distributeERC20',
                args: [addr, usdcAddress(chainId), accounts, percentAllocations, DISTRIBUTOR_FEE, zeroAddress],
                dataSuffix: BUILDER_DATA_SUFFIX,
              })
            : await writeContractAsync({
                chainId,
                address: splitMainAddress(chainId),
                abi: SPLIT_MAIN_ABI,
                functionName: 'distributeETH',
                args: [addr, accounts, percentAllocations, DISTRIBUTOR_FEE, zeroAddress],
                dataSuffix: BUILDER_DATA_SUFFIX,
              })
        setDistributeHash(hash)
        toast.success('Distributed!', { id: 'distribute' })
      } catch (err) {
        toastError('Distribution', err, { id: 'distribute' })
      } finally {
        setDistributing(false)
      }
      return
    }

    // Base: sponsored relay (unchanged).
    setDistributing(true)
    try {
      const nonceRes = await fetch(`/api/profile/${connectedAddress}/nonce`)
      if (!nonceRes.ok) throw new Error('Could not fetch nonce')
      const { nonce } = (await nonceRes.json().catch(() => ({}))) as { nonce?: string }
      if (!nonce) throw new Error('Could not fetch nonce')
      const message = `Distribute Kismet split\nCollection: ${address.toLowerCase()}\nToken: ${tokenId}\nSplit: ${addr.toLowerCase()}\nCurrency: ${currency}\nAddress: ${connectedAddress.toLowerCase()}\nNonce: ${nonce}`
      const signature = await signMessageAsync({ message })
      const res = await fetch('/api/distribute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          splitAddress: addr,
          collectionAddress: address,
          tokenId,
          chainId: 8453,
          currency,
          callerAddress: connectedAddress,
          signature,
          nonce,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Distribution failed')
      if (!data.hash) throw new Error('Distribute submitted but no tx hash returned')
      setDistributeHash(data.hash)
      toast.success('Distributed!', { id: 'distribute' })
    } catch (err) {
      toastError('Distribution', err, { id: 'distribute' })
    } finally {
      setDistributing(false)
    }
  }

  // User-paid 2nd hop: pull the connected recipient's withdrawable balance out
  // of SplitMain to their wallet. Permissionless on 0xSplits (funds always go to
  // `account`), so the connected recipient withdraws their own. Base settles via
  // the relay, so this is a no-op there.
  async function withdraw(currency: CollectCurrency) {
    if (!connectedAddress) { toast.error('Wallet not connected'); return }
    if (getChain(chainId).sponsoredMint) return
    setWithdrawing(true)
    try {
      await ensureChain(chainId)
      const hash = await writeContractAsync({
        chainId,
        address: splitMainAddress(chainId),
        abi: SPLIT_MAIN_ABI,
        functionName: 'withdraw',
        args:
          currency === 'usdc'
            ? [connectedAddress, 0n, [usdcAddress(chainId)]]
            : [connectedAddress, 1n, []],
        dataSuffix: BUILDER_DATA_SUFFIX,
      })
      setWithdrawHash(hash)
      toast.success('Withdrawn to your wallet!', { id: 'withdraw' })
    } catch (err) {
      toastError('Withdraw', err, { id: 'withdraw' })
    } finally {
      setWithdrawing(false)
    }
  }

  return {
    hasSplits,
    recipients,
    splitAddress,
    canDistribute,
    isRecipient: !!viewerRecipient,
    pendingFormatted,
    pendingShareFormatted,
    hasPending,
    distribute,
    distributing,
    distributeHash,
    claimableFormatted,
    hasClaimable,
    withdraw,
    withdrawing,
    withdrawHash,
  }
}
