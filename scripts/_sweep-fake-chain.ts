/**
 * An in-process fake of the slice of Base the sweep touches, for
 * scripts/verify-sweep.ts and scripts/verify-sweep-index.ts. Served two ways:
 * as an EIP-1193 provider behind a real viem `custom` transport (so the client
 * code runs through viem's real encoding, decoding and error mapping), and as
 * an HTTP JSON-RPC server for code that builds its own client from an env URL
 * (lib/rpc serverBaseClient).
 *
 * Modelled: FixedPriceSaleStrategy.sale(), Zora 1155 getTokenInfo() /
 * balanceOf() / mintFee(), Multicall3 aggregate3 (per-sub-call success, a
 * strict sub-call reverts the whole call) and aggregate3Value (the sweep's
 * simulation: the node's `balance ≥ value` check, Multicall3's `msg.value == Σ`
 * invariant, and FixedPriceSaleStrategy's strict `value == price + fee` per
 * mint), eth_estimateGas and the EIP-1559 fee reads. Nothing here is a
 * behavior the real chain does not have; every rule cites what it models.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  createPublicClient,
  custom,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  hexToBigInt,
  keccak256,
  numberToHex,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { base } from 'viem/chains'
import { FPSS_SALE_ABI } from '../lib/saleConfig.ts'
import {
  MULTICALL3_ADDRESS,
  MULTICALL3_BALANCE_ABI,
  ZORA_1155_MINT_FEE_ABI,
  ZORA_1155_TOKEN_INFO_ABI,
  ZORA_FIXED_PRICE_STRATEGY,
} from '../lib/zoraMint.ts'
import { MINT_1155_ABI } from './_agent-verify-helpers.ts'

const AGG3_ABI = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
])
const AGG3V_ABI = parseAbi([
  'function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
])
const BALANCE_ABI = parseAbi(['function balanceOf(address account, uint256 id) view returns (uint256)'])
const TRANSFER_SINGLE_ABI = parseAbi([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
])
const ZERO = `0x${'00'.repeat(20)}` as Address
const MC3 = MULTICALL3_ADDRESS.toLowerCase()
const FPSS = ZORA_FIXED_PRICE_STRATEGY.toLowerCase()

export const tokenKey = (collection: string, tokenId: bigint | string): string =>
  `${collection.toLowerCase()}:${tokenId.toString()}`

export type FakeSale = { saleStart: bigint; saleEnd: bigint; maxTokensPerAddress: bigint; pricePerToken: bigint }
export interface FakeToken {
  /** The strategy's sale row; 'revert' = the read reverts; 'garbage' = undecodable bytes. */
  sale: FakeSale | 'revert' | 'garbage'
  /** getTokenInfo(); undefined = open edition (maxSupply 0); 'revert' = a non-Zora contract. */
  info?: { maxSupply: bigint; totalMinted: bigint } | 'revert' | 'garbage'
  /** balanceOf(account, id); undefined = 0. */
  balance?: bigint | 'revert'
  /** Whether a mint sub-call succeeds in a simulation (default true). */
  mintOk?: boolean
}

/** A JSON-RPC error the way a node returns it (code + message). */
export class RpcErr extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

export interface FakeChain {
  now: bigint
  tokens: Map<string, FakeToken>
  /** Lowercased collection → mintFee(); 'revert' / 'garbage' as above; absent = no such contract. */
  fees: Map<string, bigint | 'revert' | 'garbage'>
  /** What Multicall3.getEthBalance reports. */
  ethBalance: bigint
  /** What the node checks `value` against in eth_call / eth_estimateGas (defaults to ethBalance). */
  nodeBalance: bigint | null
  /** Every eth_call answers an RPC error. */
  failing: boolean
  /** 0-based indices of eth_call requests that answer an RPC error (one-off failures). */
  failCalls: Set<number>
  gas: bigint | 'error'
  baseFeePerGas: bigint
  /** Per-simulation policy: (simulation number starting at 1, token key) → mint succeeds. */
  simPolicy: ((simulation: number, key: string) => boolean) | null
  /** Drop the last Result from every aggregate3Value answer (a malformed node). */
  simTruncate: boolean
  /** Transactions "mined" by mineTransaction, by hash. */
  receipts: Map<string, Record<string, unknown>>
  txs: Map<string, { from: Address; to: Address; value: bigint; data: Hex }>
  log: { method: string; params: unknown[] }[]
  ethCalls: number
  /** aggregate3Value eth_calls that reached Multicall3 (executed). */
  simulations: number
  /** aggregate3Value eth_calls attempted, including ones the node refused or that failed. */
  simAttempts: number
  /** Simulations that carried allowFailure=false on any sub-call (must stay 0: the node never sees a strict bundle). */
  strictSimulations: number
}

export function createFakeChain(over: Partial<FakeChain> = {}): FakeChain {
  return {
    now: 1_800_000_000n,
    tokens: new Map(),
    fees: new Map(),
    ethBalance: 10n ** 18n,
    nodeBalance: null,
    failing: false,
    failCalls: new Set(),
    gas: 3_000_000n,
    baseFeePerGas: 10_000_000n, // 0.01 gwei — Base-like
    simPolicy: null,
    simTruncate: false,
    receipts: new Map(),
    txs: new Map(),
    log: [],
    ethCalls: 0,
    simulations: 0,
    simAttempts: 0,
    strictSimulations: 0,
    ...over,
  }
}

export const liveSale = (pricePerToken: bigint, maxTokensPerAddress = 0n): FakeSale => ({
  saleStart: 0n,
  saleEnd: 18_446_744_073_709_551_615n, // uint64 max — the open-ended sentinel
  maxTokensPerAddress,
  pricePerToken,
})

/** A collection-level revert or garbage for an inner call. */
class InnerRevert extends Error {}

function innerCall(chain: FakeChain, target: string, data: Hex): Hex {
  const to = target.toLowerCase()
  if (to === FPSS) {
    const { args } = decodeFunctionData({ abi: FPSS_SALE_ABI, data })
    const t = chain.tokens.get(tokenKey(args[0] as string, args[1] as bigint))
    // No sale ever set: the strategy returns zeros (not a revert).
    if (!t) {
      return encodeFunctionResult({
        abi: FPSS_SALE_ABI,
        functionName: 'sale',
        result: { saleStart: 0n, saleEnd: 0n, maxTokensPerAddress: 0n, pricePerToken: 0n, fundsRecipient: ZERO },
      })
    }
    if (t.sale === 'revert') throw new InnerRevert('sale reverted')
    if (t.sale === 'garbage') return '0x1234'
    return encodeFunctionResult({
      abi: FPSS_SALE_ABI,
      functionName: 'sale',
      result: { ...t.sale, fundsRecipient: ZERO },
    })
  }
  if (to === MC3) {
    decodeFunctionData({ abi: MULTICALL3_BALANCE_ABI, data })
    return encodeFunctionResult({ abi: MULTICALL3_BALANCE_ABI, functionName: 'getEthBalance', result: chain.ethBalance })
  }
  // A collection contract.
  try {
    const { args } = decodeFunctionData({ abi: ZORA_1155_TOKEN_INFO_ABI, data })
    const t = chain.tokens.get(tokenKey(to, args[0] as bigint))
    const info = t?.info
    if (info === 'revert') throw new InnerRevert('getTokenInfo reverted')
    if (info === 'garbage') return '0x12'
    return encodeFunctionResult({
      abi: ZORA_1155_TOKEN_INFO_ABI,
      functionName: 'getTokenInfo',
      result: { uri: '', maxSupply: info?.maxSupply ?? 0n, totalMinted: info?.totalMinted ?? 0n },
    })
  } catch (e) {
    if (e instanceof InnerRevert) throw e
  }
  try {
    const { args } = decodeFunctionData({ abi: BALANCE_ABI, data })
    const t = chain.tokens.get(tokenKey(to, args[1] as bigint))
    if (t?.balance === 'revert') throw new InnerRevert('balanceOf reverted')
    return encodeFunctionResult({ abi: BALANCE_ABI, functionName: 'balanceOf', result: t?.balance ?? 0n })
  } catch (e) {
    if (e instanceof InnerRevert) throw e
  }
  try {
    decodeFunctionData({ abi: ZORA_1155_MINT_FEE_ABI, data })
    const fee = chain.fees.get(to)
    if (fee === undefined || fee === 'revert') throw new InnerRevert('mintFee reverted')
    if (fee === 'garbage') return '0x'
    return encodeFunctionResult({ abi: ZORA_1155_MINT_FEE_ABI, functionName: 'mintFee', result: fee })
  } catch (e) {
    if (e instanceof InnerRevert) throw e
  }
  throw new InnerRevert(`unknown call to ${to}`)
}

const INSUFFICIENT = (have: bigint, want: bigint) =>
  new RpcErr(-32000, `insufficient funds for gas * price + value: address have ${have} want ${want}`)

function nodeBalance(chain: FakeChain): bigint {
  return chain.nodeBalance ?? chain.ethBalance
}

function handleEthCall(chain: FakeChain, call: { to?: string; data?: Hex; value?: Hex; from?: string }): Hex {
  const idx = chain.ethCalls++
  const to = (call.to ?? '').toLowerCase()
  const data = call.data ?? '0x'
  if (to === MC3 && data.startsWith('0x174dea71')) {
    chain.simAttempts++
    const { args } = decodeFunctionData({ abi: AGG3V_ABI, data })
    if (args[0].some((c) => !c.allowFailure)) chain.strictSimulations++
  }
  if (chain.failing || chain.failCalls.has(idx)) throw new RpcErr(-32000, 'mock: chain read failure')
  const value = call.value ? hexToBigInt(call.value) : 0n
  // op-geth: a call whose sender cannot cover `value` is refused before it runs.
  if (value > 0n && value > nodeBalance(chain)) throw INSUFFICIENT(nodeBalance(chain), value)
  if (to === MC3 && data.startsWith('0x82ad56cb')) {
    // aggregate3 — reads.
    const { args } = decodeFunctionData({ abi: AGG3_ABI, data })
    const results = args[0].map((c) => {
      try {
        return { success: true, returnData: innerCall(chain, c.target, c.callData) }
      } catch (e) {
        if (!(e instanceof InnerRevert)) throw e
        if (!c.allowFailure) throw new RpcErr(-32000, 'execution reverted')
        return { success: false, returnData: '0x' as Hex }
      }
    })
    return encodeFunctionResult({ abi: AGG3_ABI, functionName: 'aggregate3', result: results })
  }
  if (to === MC3 && data.startsWith('0x174dea71')) {
    // aggregate3Value — the sweep bundle, simulated.
    chain.simulations++
    const { args } = decodeFunctionData({ abi: AGG3V_ABI, data })
    const sum = args[0].reduce((s, c) => s + c.value, 0n)
    // Multicall3's own invariant: msg.value must equal the sum of sub-call values.
    if (sum !== value) throw new RpcErr(-32000, 'execution reverted: Multicall3: value mismatch')
    const results = args[0].map((c) => {
      let ok = false
      try {
        const { functionName, args: a } = decodeFunctionData({ abi: MINT_1155_ABI, data: c.callData })
        if (functionName === 'mint') {
          const key = tokenKey(c.target, a[1] as bigint)
          const t = chain.tokens.get(key)
          const sale = t && typeof t.sale === 'object' ? t.sale : null
          const fee = chain.fees.get(c.target.toLowerCase())
          // FixedPriceSaleStrategy: exact value, and the strategy address must be the minter.
          const valueOk = sale !== null && typeof fee === 'bigint' && c.value === (sale.pricePerToken + fee) * (a[2] as bigint)
          const minterOk = String(a[0]).toLowerCase() === FPSS
          const policy = chain.simPolicy ? chain.simPolicy(chain.simulations, key) : (t?.mintOk ?? true)
          ok = valueOk && minterOk && policy
        }
      } catch {
        ok = false
      }
      if (!ok && !c.allowFailure) throw new RpcErr(-32000, 'execution reverted')
      return { success: ok, returnData: '0x' as Hex }
    })
    const out = chain.simTruncate ? results.slice(0, -1) : results
    return encodeFunctionResult({ abi: AGG3V_ABI, functionName: 'aggregate3Value', result: out })
  }
  try {
    return innerCall(chain, to, data)
  } catch (e) {
    if (e instanceof InnerRevert) throw new RpcErr(-32000, 'execution reverted')
    throw e
  }
}

/**
 * "Mine" a signed sweep or direct-mint transaction: decode it exactly as the
 * chain would, run the same per-mint rules the simulation applies, credit the
 * minted balances, and record a success receipt carrying one TransferSingle
 * per mint (from 0x0 to the recipient, emitted by the collection) — the log
 * /api/collect verifies against. A failing strict bundle mines as a revert
 * (status 0x0, no logs, nothing credited). Returns the tx hash.
 */
export function mineTransaction(chain: FakeChain, tx: { from: Address; to: Address; value: bigint; data: Hex }): Hex {
  const hash = keccak256(`${tx.data}${tx.from.slice(2)}${numberToHex(chain.txs.size + 1).slice(2)}` as Hex)
  chain.txs.set(hash, tx)
  const to = tx.to.toLowerCase()
  // Trailing bytes (an ERC-8021 builder suffix) are ignored by the ABI decoder, as on-chain.
  const mints: { collection: Address; tokenId: bigint; quantity: bigint; recipient: Address; value: bigint; allowFailure: boolean }[] = []
  let sum = 0n
  if (to === MC3) {
    const { args } = decodeFunctionData({ abi: AGG3V_ABI, data: tx.data })
    for (const c of args[0]) {
      const { args: a } = decodeFunctionData({ abi: MINT_1155_ABI, data: c.callData })
      const [recipient] = decodeMinterArgs(a[4] as Hex)
      mints.push({ collection: c.target, tokenId: a[1] as bigint, quantity: a[2] as bigint, recipient, value: c.value, allowFailure: c.allowFailure })
      sum += c.value
    }
  } else {
    const { args: a } = decodeFunctionData({ abi: MINT_1155_ABI, data: tx.data })
    const [recipient] = decodeMinterArgs(a[4] as Hex)
    mints.push({ collection: tx.to, tokenId: a[1] as bigint, quantity: a[2] as bigint, recipient, value: tx.value, allowFailure: false })
    sum = tx.value
  }
  const ok = (m: (typeof mints)[number]) => {
    const t = chain.tokens.get(tokenKey(m.collection, m.tokenId))
    const fee = chain.fees.get(m.collection.toLowerCase())
    return Boolean(t && typeof t.sale === 'object' && typeof fee === 'bigint' && m.value === (t.sale.pricePerToken + fee) * m.quantity && (t.mintOk ?? true))
  }
  const reverted = sum !== tx.value || tx.value > nodeBalance(chain) || mints.some((m) => !m.allowFailure && !ok(m))
  const logs: Record<string, unknown>[] = []
  if (!reverted) {
    mints.forEach((m, i) => {
      if (!ok(m)) return
      const t = chain.tokens.get(tokenKey(m.collection, m.tokenId))!
      t.balance = (typeof t.balance === 'bigint' ? t.balance : 0n) + m.quantity
      if (t.info && typeof t.info === 'object') t.info = { ...t.info, totalMinted: t.info.totalMinted + m.quantity }
      logs.push({
        address: m.collection,
        blockHash: `0x${'11'.repeat(32)}`,
        blockNumber: '0x10',
        data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [m.tokenId, m.quantity]),
        logIndex: numberToHex(i),
        removed: false,
        topics: encodeEventTopics({ abi: TRANSFER_SINGLE_ABI, eventName: 'TransferSingle', args: { operator: FPSS as Address, from: ZERO, to: m.recipient } }),
        transactionHash: hash,
        transactionIndex: '0x0',
      })
    })
    chain.ethBalance -= tx.value
  }
  chain.receipts.set(hash, {
    blockHash: `0x${'11'.repeat(32)}`,
    blockNumber: '0x10',
    contractAddress: null,
    cumulativeGasUsed: '0x5208',
    effectiveGasPrice: numberToHex(chain.baseFeePerGas + 1n),
    from: tx.from,
    gasUsed: '0x5208',
    logs,
    logsBloom: `0x${'00'.repeat(256)}`,
    status: reverted ? '0x0' : '0x1',
    to: tx.to,
    transactionHash: hash,
    transactionIndex: '0x0',
    type: '0x2',
  })
  return hash
}

const MINTER_ARGS = [{ type: 'address' }, { type: 'string' }] as const
function decodeMinterArgs(data: Hex): [Address, string] {
  const [to, comment] = decodeAbiParameters(MINTER_ARGS, data)
  return [to, comment]
}

function block(chain: FakeChain) {
  return {
    number: '0x10',
    hash: `0x${'11'.repeat(32)}`,
    parentHash: `0x${'22'.repeat(32)}`,
    timestamp: numberToHex(chain.now),
    nonce: '0x0000000000000000',
    difficulty: '0x0',
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    miner: ZERO,
    extraData: '0x',
    logsBloom: `0x${'00'.repeat(256)}`,
    sha3Uncles: `0x${'33'.repeat(32)}`,
    stateRoot: `0x${'44'.repeat(32)}`,
    receiptsRoot: `0x${'55'.repeat(32)}`,
    transactionsRoot: `0x${'66'.repeat(32)}`,
    size: '0x100',
    totalDifficulty: '0x0',
    transactions: [],
    uncles: [],
    baseFeePerGas: numberToHex(chain.baseFeePerGas),
  }
}

/** One JSON-RPC method; throws RpcErr for a node error. */
export function handleRpc(chain: FakeChain, method: string, params: unknown[] = []): unknown {
  chain.log.push({ method, params })
  switch (method) {
    case 'eth_chainId':
      return '0x2105'
    case 'eth_blockNumber':
      return '0x10'
    case 'eth_getBlockByNumber':
      return block(chain)
    case 'eth_call':
      return handleEthCall(chain, (params[0] ?? {}) as { to?: string; data?: Hex; value?: Hex; from?: string })
    case 'eth_estimateGas': {
      const call = (params[0] ?? {}) as { value?: Hex }
      const value = call.value ? hexToBigInt(call.value) : 0n
      if (value > nodeBalance(chain)) throw INSUFFICIENT(nodeBalance(chain), value)
      if (chain.gas === 'error') throw new RpcErr(-32000, 'mock: estimate failed')
      return numberToHex(chain.gas)
    }
    case 'eth_maxPriorityFeePerGas':
      return '0x1'
    case 'eth_gasPrice':
      return numberToHex(chain.baseFeePerGas + 1n)
    case 'eth_getTransactionReceipt':
      return chain.receipts.get(String(params[0]).toLowerCase()) ?? null
    case 'eth_getTransactionByHash': {
      const h = String(params[0]).toLowerCase()
      const tx = chain.txs.get(h)
      if (!tx) return null
      return {
        hash: h,
        blockHash: `0x${'11'.repeat(32)}`,
        blockNumber: '0x10',
        from: tx.from,
        to: tx.to,
        value: numberToHex(tx.value),
        input: tx.data,
        gas: '0x5208',
        gasPrice: numberToHex(chain.baseFeePerGas + 1n),
        nonce: '0x0',
        transactionIndex: '0x0',
        type: '0x2',
        chainId: '0x2105',
        v: '0x0',
        r: '0x0',
        s: '0x0',
      }
    }
    case 'eth_getTransactionCount':
      return '0x0'
    case 'eth_getBalance':
      return numberToHex(chain.ethBalance)
    case 'eth_getCode':
      return '0x'
    default:
      throw new RpcErr(-32601, `unhandled ${method}`)
  }
}

/** A viem PublicClient over the fake, configured like the app's Base client (multicall batching on). */
export function fakeClient(chain: FakeChain): PublicClient {
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) =>
      handleRpc(chain, method, params ?? []),
  }
  return createPublicClient({ chain: base, transport: custom(provider), batch: { multicall: true } }) as PublicClient
}

/** The same fake behind HTTP, for code that reads its RPC URL from the environment. */
export function startFakeRpcServer(chain: FakeChain): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    // A browser client (a Playwright run) needs CORS; Node callers ignore it.
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', 'content-type')
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      return res.end()
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      const parsed = JSON.parse(body) as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[]
      const one = (rpc: { id: number; method: string; params?: unknown[] }) => {
        try {
          return { jsonrpc: '2.0', id: rpc.id, result: handleRpc(chain, rpc.method, rpc.params ?? []) }
        } catch (e) {
          const code = e instanceof RpcErr ? e.code : -32000
          return { jsonrpc: '2.0', id: rpc.id, error: { code, message: e instanceof Error ? e.message : String(e) } }
        }
      }
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      resolve({ url, close: () => server.close() })
    })
  })
}
