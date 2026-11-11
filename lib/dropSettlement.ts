import { decodeEventLog, TransactionReceiptNotFoundError, zeroAddress, type Hex, type PublicClient } from 'viem'
import { ZORA_1155_TOKEN_INFO_ABI } from './zoraMint'
import { matchAirdropTx, TRANSFER_SINGLE_EVENT, type TransferSingleLike } from './airdropLanded'

/**
 * Has a claim drop been delivered? Answered from Base alone, for
 * /api/drops/{key}/settle — nothing the client says is taken on trust.
 *
 * A delivery is ONE transaction that minted the drop's edition from 0x0 to
 * EVERY recipient, sent by the artist (TransferSingle's operator): the
 * matcher the airdrop flow already confirms airdrops with
 * (lib/airdropLanded matchAirdropTx). `not-yet` means it hasn't happened.
 */

export interface DeliveryWanted {
  collection: string
  tokenId: string
  /** Base's head just before the edition was minted; the airdrop is after it. */
  fromBlock: string
  recipients: readonly string[]
  artist: string
}

type Reader = Pick<PublicClient, 'getTransactionReceipt' | 'readContract' | 'getLogs'>

/** The airdrop the artist says they sent, checked from its receipt. */
export async function checkAirdropTx(client: Reader, hash: Hex, want: DeliveryWanted): Promise<Hex | 'not-yet' | null> {
  const receipt = await client.getTransactionReceipt({ hash }).catch((err: unknown) => {
    if (err instanceof TransactionReceiptNotFoundError) return null
    throw err
  })
  if (!receipt) return 'not-yet'
  if (receipt.status !== 'success') return null
  const collection = want.collection.toLowerCase()
  const logs: TransferSingleLike[] = receipt.logs
    .filter((l) => l.address.toLowerCase() === collection)
    .flatMap((l) => {
      try {
        const { args } = decodeEventLog({ abi: [TRANSFER_SINGLE_EVENT], data: l.data, topics: l.topics })
        return [{ transactionHash: l.transactionHash, args }]
      } catch {
        return []
      }
    })
  const matched = matchAirdropTx(logs, { tokenId: BigInt(want.tokenId), recipients: want.recipients, operator: want.artist })
  return matched?.toLowerCase() === hash.toLowerCase() ? hash : null
}

/**
 * The airdrop, found on chain with no hash to go on — how an interrupted
 * delivery resumes from any device. The edition's sale is closed at creation,
 * so only its airdrop mints it: until it is fully minted, `not-yet`; once it
 * is, the transaction that minted it to every recipient (null if none did —
 * it was minted some other way). The log query is one collection, one
 * operator, genesis mints only: a handful of rows however long the range
 * (the lib/experience/discovery pattern).
 */
export async function findAirdrop(client: Reader, want: DeliveryWanted): Promise<Hex | 'not-yet' | null> {
  const collection = want.collection as Hex
  const tokenId = BigInt(want.tokenId)
  const info = await client.readContract({
    address: collection,
    abi: ZORA_1155_TOKEN_INFO_ABI,
    functionName: 'getTokenInfo',
    args: [tokenId],
  })
  if (info.totalMinted < BigInt(want.recipients.length)) return 'not-yet'
  const logs = await client.getLogs({
    address: collection,
    event: TRANSFER_SINGLE_EVENT,
    args: { operator: want.artist as Hex, from: zeroAddress },
    fromBlock: BigInt(want.fromBlock),
    toBlock: 'latest',
  })
  return matchAirdropTx(logs, { tokenId, recipients: want.recipients, operator: want.artist })
}
