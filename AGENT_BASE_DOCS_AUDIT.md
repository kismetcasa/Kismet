# Base docs compliance audit — agent collect / buy / list

> A complete review of our implementation against the canonical Base docs
> (Custom Plugins, batch-calls/`send_calls`, approval-mode, SKILL onboarding, Sub
> Accounts, Spend Permissions). Scoped per the current priorities:
>
> 1. **Mint is out of scope** — focus collect / buy / list.
> 2. **This is a Base App / Base Account feature** — the priority audience is
>    smart-wallet users; the Base App is the primary surface.
>
> Sources are the canonical Base docs + the **installed** `@base-org/account@2.4.0`
> types (docs.base.org blocks automated fetch, so shipped types are authoritative).

## Two paths, and which constraints apply

| Path | Who calls `/api/agent/*` | Constraints from the docs | Priority |
| --- | --- | --- | --- |
| **Kismet-native** | our own app (web + Base App mini-app) + the sub-account SDK | none of the `web_request` allowlist / GET-only / POST limits apply (we call our own API directly) | **Primary (#2)** |
| **Base MCP plugin** | an external assistant (Claude/ChatGPT/Base App assistant) via `mcp.base.org` | `web_request` is GET-only + allowlisted (Kismet isn't on it); POST unsupported in consumer apps | Secondary (reach) |

**Key conclusion:** the Custom Plugins doc's HTTP limits (POST unsupported,
non-allowlisted hosts) do **not** block our priority audience, because Base App /
Base Account users go through the **Kismet-native** path where our app calls our
own endpoints. The limits only constrain the secondary external-agent path, which
we document and scope accordingly.

## Audit

### A. `send_calls` contract — COVERED
- `{ chain: "base", calls: [{ to, value, data }] }`, `chain` is the **name** (not
  numeric), top-level. ✓
- `value` is **hex wei** (`"0x0"` when none) — fixed earlier; oracles assert it. ✓
- `approve` + action **batched atomically** into one approval (batch endpoint). ✓
- Builder code (ERC-8021) + Zora referral preserved in every prepared call. ✓

### B. Approval mode — COVERED (fixed this pass)
- SKILL.md step 4 now: write tools return `{ approvalUrl, requestId }` → present
  **"Approve Transaction"** → wait → poll `get_request_status` **once** → success
  **only after** confirm; destination named **"Base Account"**; never claim success
  early. ✓ (Was a gap.)

### C. Custom-plugin anatomy — COVERED (fixed this pass)
- **Onboarding gate (STOP):** added to SKILL.md — forces `get_wallets` + disclaimer
  before any Kismet call. ✓
- **Read endpoints:** `GET /api/agent/discover`, `GET /api/agent/manifest`;
  `references/discover.md` documents them. Prices/eligibility resolved server-side. ✓
- **Prepare endpoints (exact response shape):** the envelope documents `calls:
  [{to, value(hex), data}]` (+ `typedData` for list, `record`/`records` for the
  follow-up). ✓ — these are **POST** (see E).
- **`send_calls` mapping:** SKILL.md + per-verb references show passing `calls`
  through unchanged. ✓

### D. SKILL onboarding / disclaimer / tone — COVERED
- STOP gate defers to Base MCP onboarding (which presents the verbatim ToS
  disclaimer) rather than restating it. ✓
- Tone rules: inherited from the installed `base-mcp` skill (ours layers on top). ✓

### E. GET vs POST + `web_request` allowlist — DOCUMENTED (scoped)
- Our prepare endpoints are **POST**. Per the docs that's unusable via Base MCP
  `web_request` in consumer apps, and Kismet isn't allowlisted.
- SKILL.md "Reaching the endpoints" now states: consumer-app agents fetch prepares
  with their own HTTP (or the user pastes); **Base App / Kismet-native is the
  priority and isn't subject to this.** ✓
- **Optional follow-up (deferred per #2):** add GET variants of the prepare
  endpoints for full consumer-app reach.

### F. Chains — COVERED
- Base mainnet only (`8453` / `0x2105`); `send_calls` uses `chain: "base"`. ✓

### G. Per-verb correctness (collect / buy / list) — COVERED
- **Collect:** `send_calls` (ETH `[mint]` / USDC `[approve, mint]`); record on the
  on-chain-verified `/api/collect`; calldata oracle-verified. ✓
- **Buy:** `send_calls` (`fulfillOrder`, ETH value / USDC `[approve, fulfillOrder]`);
  **single approval** (txHash-only "mark filled", buyer derived from the on-chain
  event); oracle-verified. ✓
- **List:** optional one-time `setApprovalForAll` + EIP-712 Seaport `sign`; POST to
  `/api/listings` (re-validates shape, signature, full EIP-2981 royalty); EIP-712
  well-formedness oracle-verified. ✓
- **Mint:** excluded per #1. SKILL.md + manifest omit it. ✓

### H. Base App / Base Account path (Sub Accounts, Spend Permissions) — IMPLEMENTED, type-verified
- Mode A (in-session, popup-less collecting) wired through the **wagmi-connected
  provider**: the `baseAccount` connector is configured with `subAccounts`
  (`creation`/`defaultAccount`/`funding`/`toOwnerAccount: getCryptoKeyAccount`)
  in `lib/wagmi.ts`, and `baseAccount.ts` drives `requestSpendPermission` /
  `getPermissionStatus` / `fetchPermissions` / `requestRevoke` +
  `wallet_sendCalls` from the sub-account against that provider (via
  `getAccount(wagmiConfig)`). No standalone `createBaseAccountSDK` / second
  session. ✓ (typecheck + build + bundle clean; see
  `AGENT_SUBACCOUNT_INTEGRATION.md` → "Implemented (this turn)")
- `AutoCollectPanel` mounted owner-only in ProfileView, code-split
  (`next/dynamic`, `ssr:false`) so the 21 MB SDK stays out of the profile route's
  initial JS. ✓
- Funds never reach a Kismet address; the user owns + revokes the sub-account. ✓
- **Live smoke test pending** (no wallet/RPC in CI) — checklist in
  `AGENT_SUBACCOUNT_DESIGN.md` §8.

### I. x402 — OUT OF SCOPE this pass
- Not required for collect/buy/list. Curated discovery via x402 is a future paid
  upgrade (`AGENT_EXPERIENCE_DESIGN.md`). No gap for current scope.

## Fixed this pass
- SKILL.md: added the **STOP onboarding gate**, the full **approval-mode loop**
  (`get_request_status`, "Approve Transaction", "Base Account", never-claim-early),
  a **GET/POST + allowlist** section, and **Base App / Base Account scoping**.

## Remaining follow-ups (scoped, non-blocking)
- **Live smoke tests:** Mode A sub-account round-trip; an external Base MCP plugin
  round-trip (own-fetch path).
- **Base App mini-app provider:** confirm the Base Account SDK provider works in the
  Coinbase WebView (mini-app currently uses the Farcaster connector + injected).
- **GET prepare variants** for full consumer-app reach (deferred per #2).
- **Single-file `plugins/kismet.md`** to drop into the base-mcp skill (our standalone
  skill is compliant; this is convenience).
- **`mintTo = main collection`** variant for Mode A (sender/recipient split).

## Verdict
For the priority audience (**Base App / Base Account**), **collect / buy / list are
covered and correct** against the Base docs, and the skill is now canonically
compliant (STOP gate, approval loop, send_calls contract, GET/POST scoping). The
only un-exercised items are **live wallet smoke tests** (impossible in CI) and
explicitly-deferred reach/UX follow-ups. Mint remains out of scope per #1.

## Round 2 — EIP-5792 / SDK RPC-shape verification

Verified every manual wallet RPC against the canonical specs + installed types
(docs.base.org blocks fetch; installed types + EIPs are authoritative and current):

| Call | Where | Spec check | Result |
| --- | --- | --- | --- |
| `wallet_getCapabilities` | `useSmartWalletAgentEligibility` | EIP-5792: params `[address,[chainIds]]`; `atomic.status` ∈ supported/ready/unsupported | ✅ matches |
| `wallet_sendCalls` | `baseAccount.ts` | EIP-5792: `{version:"2.0.0", from, chainId(hex), atomicRequired, calls:[{to,data,value(hex)}]}` | ✅ matches |
| `wallet_getCallsStatus` | `baseAccount.ts` | EIP-5792: `status` is **numeric** (100/200/400/500/600) | ⚠️ → **fixed** |
| `waitForCallsStatus` | `BuyButton` | wagmi normalizes status to string `'success'` | ✅ correct (wagmi API) |
| `viem.getCode` | `useSmartWalletAgentEligibility` | viem 2.47 client action | ✅ valid |
| `requestSpendPermission` etc. | `baseAccount.ts` | `@base-org/account@2.4.0` types | ✅ matches |
| `baseAccount({ subAccounts })` | integration spec | `@wagmi/connectors@6.2.0` types | ✅ matches |
| `send_calls` value = hex; chain name | collect/buy/list/batch | EIP-5792 + Base batch-calls | ✅ matches (oracles) |

**Fix applied:** `waitForCollectTxHash` now gates on the numeric EIP-5792
`status === 200` (confirmed) before returning the receipt txHash, and throws on
terminal failures (400/500/600) — previously it returned as soon as `receipts`
appeared. (`BuyButton` was already correct via wagmi's normalized status.)

### Sources
- [Custom Plugins](https://docs.base.org/ai-agents/plugins/custom-plugins) ·
  [Execute contract calls (`send_calls`)](https://docs.base.org/ai-agents/guides/batch-calls) ·
  [base/skills `base-mcp`](https://github.com/base/skills/tree/master/skills/base-mcp)
- [Use Sub Accounts](https://docs.base.org/base-account/improve-ux/sub-accounts) ·
  [Use Spend Permissions](https://docs.base.org/base-account/improve-ux/spend-permissions) ·
  installed `@base-org/account@2.4.0` types
