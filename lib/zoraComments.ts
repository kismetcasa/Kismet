import { parseAbi, zeroAddress, zeroHash, type Address } from 'viem'
import { KISMET_REFERRAL } from './zoraMint'

// Zora Comments protocol — Base mainnet (chainId 8453). Proxy at the canonical
// vanity address (impl 0xE37B9036440Fe6C189285629AaD8F4b31AD93F31, deployed
// block 21374808). Lets a holder comment on a token they already own as its own
// transaction — separate from minting — which is the "leave a comment after you
// collected" path. In Process indexes the emitted `Commented` event into
// /moment/comments alongside the mint comments the collect flow already writes,
// so posted comments surface in the activity feed with no Kismet-side store.
// Source: ourzora/zora-protocol packages/comments (IComments / CommentsImpl).
export const ZORA_COMMENTS: Address = '0x7777777C2B3132e03a65721a41745C07170a5877'

export const COMMENTS_ABI = parseAbi([
  'struct CommentIdentifier { address commenter; address contractAddress; uint256 tokenId; bytes32 nonce; }',
  'function sparkValue() view returns (uint256)',
  'function comment(address commenter, address contractAddress, uint256 tokenId, string text, CommentIdentifier replyTo, address commenterSmartWallet, address referrer) payable returns (CommentIdentifier)',
])

// An all-zero CommentIdentifier is a TOP-LEVEL comment (not a reply) — matches
// Zora's own tests (Comments_permit.t.sol).
const EMPTY_REPLY_TO = {
  commenter: zeroAddress,
  contractAddress: zeroAddress,
  tokenId: 0n,
  nonce: zeroHash,
} as const

// Build the `comment()` call for a direct EOA holder.
//   - commenter: the holder's EOA — the contract gates on it owning the token.
//   - commenterSmartWallet: zero (this app collects to the EOA, not a smart
//     wallet, so there's no smart-wallet owner to attribute).
//   - referrer: KISMET_REFERRAL, so comment-referral sparks accrue to the
//     platform treasury, mirroring the mint-referral split. Value must equal
//     exactly one sparkValue() — read it live and pass as the tx value.
export function buildCommentCall(params: {
  commenter: Address
  collection: Address
  tokenId: bigint
  text: string
}) {
  return {
    abi: COMMENTS_ABI,
    functionName: 'comment' as const,
    args: [
      params.commenter,
      params.collection,
      params.tokenId,
      params.text,
      EMPTY_REPLY_TO,
      zeroAddress,
      KISMET_REFERRAL,
    ],
  } as const
}
