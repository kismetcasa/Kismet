# EOA experience: A/B research & decisions

> Goal: narrow the EOA ↔ smart-wallet gap **from both ends** without regressing
> anyone. Systematic review of two candidate improvements against our actual code
> and the relevant Base/standards docs.
>
> - **A** — reduce repeat-collect friction for EOAs (one-time / max USDC approve).
> - **B** — make a confirmed buy one tap (drop the "mark filled" signature).

## A — collect approval: **not recommended** (it fights our own policy)

What I found in our code (`hooks/useCollectAll.ts`):

> *"Bounded approve — exact batch total, **never MaxUint256**. … per 2024+ approval
> security guidance."*

So **exact/bounded approval is a deliberate, documented security decision** here.
Max-approving the minter would reverse it — and the search corroborated the live
risk class (USDC permit/approval **phishing-drain**). Other facts:

- **EOA USDC collect has an inherent floor of 2 interactions** (authorize + mint).
  EOAs can't batch natively (pre-ERC‑7702), and the Zora `ERC20Minter.mint` pulls
  via `transferFrom(msg.sender, …)` with **no permit parameter**, so approve+mint
  can't be fused into one call.
- **USDC on Base *does* support EIP‑2612 `permit`** (Circle FiatTokenV2_2). But
  because the minter takes no permit arg, permit only makes the approval **gasless +
  bounded + expiring** — it does **not** reduce the tap count. It's a *gas/safety*
  nicety, not a friction win, and adds typed-data/nonce/deadline complexity.

**Decision:** **do not** change the collect approval. Max-approve would regress our
security posture; the EOA 2-interaction floor is inherent. *Optional future:* swap
the on-chain exact-approve for an **EIP‑2612 permit** (gasless + bounded + expiring)
— strictly safer than even an exact on-chain approve, saves the approve gas — but
low priority since it doesn't cut taps. (For smart wallets, batching already
collapses approve+mint to one approval; for EOAs the floor stands.)

> This is exactly why we researched before building: **A looked attractive but is
> the wrong move for our build.**

## B — buy in one tap: **implemented**

What I found (`components/BuyButton.tsx`): a confirmed buy did `fulfillOrder` →
fetch nonce → `signMessage("Mark Kismet listing filled…")` → `PATCH`. The backend
(`/api/listings/[id]`) now verifies "filled" via the **txHash + Seaport
`OrderFulfilled`** (buyer derived from the event), so the buyer signature is
**redundant**.

**Change:** `BuyButton` now PATCHes `{ status: "filled", txHash }` with **no
signature** (removed the nonce fetch, `signMessage`, and the `useSignMessage` hook).

Effect, for **all** users (EOA and smart wallet):

| | Before | After |
| --- | --- | --- |
| **ETH buy** | fulfill tx + mark-filled signature = **2** | fulfill tx = **1 tap** |
| **USDC buy** | approve + fulfill + signature = **3** | approve + fulfill = **2** |

No security regression — the on-chain receipt is the binding proof, and the buyer is
read from the event (a marker can't redirect the sale or Pass-validity credit). The
web buy path now matches the agent path. Verified: typecheck + lint clean. *(Needs a
live wallet smoke test — CI has no wallet/RPC.)*

> *Optional future:* EIP‑5792-batch the USDC `approve + fulfillOrder` for smart
> wallets → 1-tap USDC buy (smart-wallet only; EOAs keep approve + fulfill).

## Net

**B narrows the gap for everyone — including EOAs — with zero security cost. A would
have cost security for no tap reduction, so we don't do it.** Plus the explicit EOA
guardrails (see `AGENT_UI_WIRING.md`) ensure the upcoming collecting-account UI never
regresses the per-action EOA path.

## Follow-up research — permit (gasless approve) vs EIP-5792 batch buy

Re-evaluated the two "optional future" items for necessity / best practice.

### Permit / Permit2 (gasless approve) — **declined** (not best practice for us)
EIP-2612 `permit` (USDC supports it on Base) and Permit2 only collapse
approve + action into one **when the spender contract consumes the signature** in
the same call. Our spenders — the Zora `ERC20Minter` (collect) and Seaport (buy) —
do **not** accept a permit, so permit would be a **standalone gasless signature that
sets the allowance, then a separate action**: same tap count, plus added
signature-phishing surface. For our build the right tool is **EIP-5792 batching**
(works regardless of the downstream contract) + exact on-chain approve for non-5792
wallets — which we already do. So permit is not adopted. (Lowest-value option: permit
could replace an EOA's on-chain approve to save *gas* — no tap reduction.)

### EIP-5792 batch buy — **implemented** (best practice; we were inconsistent)
We already batch approve + mint for collect (`useCollectAll`) but `BuyButton` did a
sequential approve → fulfill. Brought buy to parity: the **first-time USDC buy** now
batches `approve + fulfillOrder` into ONE wallet approval on EIP-5792 wallets
(Coinbase Smart Wallet, MetaMask v12+, Rainbow…), approve still **exact** (never
MaxUint256). Unchanged: ETH buy (single fulfill), repeat USDC buy (allowance covers →
single fulfill), and the **sequential fallback** for non-5792 wallets (identical to
the old path — no EOA/legacy regression). fulfill is always the last call, so its
receipt carries the `OrderFulfilled` the backend decodes; with the earlier signature
drop, a USDC buy is now **1 tap on 5792 wallets, 2 on legacy** (was 2 / 3). The
`isUnsupportedMethodError` helper was lifted into `lib/toast.ts` (shared by collect-all
and buy) to avoid duplicating the fallback logic.

Verified: typecheck, lint, `verify:agent` green. *(Live wallet smoke test still
pending — CI has no wallet/RPC.)*

### Sources
- Our code: `hooks/useCollectAll.ts` (exact-approve policy), `components/BuyButton.tsx`,
  `app/api/listings/[id]/route.ts` (txHash-only "filled").
- [USDC EIP‑2612 permit (Circle)](https://www.circle.com/blog/four-ways-to-authorize-usdc-smart-contract-interactions-with-circle-sdk) ·
  [EIP‑2612](https://eips.ethereum.org/EIPS/eip-2612) ·
  [Zora ERC20 mints](https://docs.zora.co/protocol-sdk/creator/erc20-mints) ·
  [Execute contract calls / batching (`send_calls`)](https://docs.base.org/ai-agents/guides/batch-calls) ·
  [ERC‑7702](https://blog.base.dev/securing-eip-7702-upgrades)
