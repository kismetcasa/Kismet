# Agent UI/UX spec — parity, variables, and design (pre-implementation)

> The definitive spec for surfacing the agent implementation to users. **No code
> in this pass** — per the directive, every relevant variable is identified first.
> Builds on `AGENT_UI_WIRING.md`, `AGENT_ACCOUNTING_AND_ELIGIBILITY.md`,
> `AGENT_SUBACCOUNT_DESIGN.md`, `AGENT_EOA_IMPROVEMENTS.md`.

## 0. Correctness confirmation (all shipped changes)

| Gate | Result |
| --- | --- |
| `typecheck` | ✅ |
| `lint` | ✅ |
| `verify:agent` (collect/buy/list/batch oracles + skill + scout engine) | ✅ |
| `check:resource-hints` | ✅ |
| **`next build`** (all routes incl. `/api/agent/*`) | ✅ compiled |
| **`check:bundle`** | ✅ no route over threshold |

**Only un-exercised item:** a live wallet smoke test of the buy flow (ETH 1-tap;
USDC EIP-5792 batch + legacy fallback) and the Mode A sub-account round-trip — CI
has no wallet/RPC. Everything else is verified.

## 1. Visibility & scope — Coinbase Smart Wallet only (confirmed)

The agent *experience* (tap-free collecting, budgets, Scouts) is built on **Sub
Accounts + Spend Permissions**, which **require a smart wallet** (verified in
`AGENT_ACCOUNTING_AND_ELIGIBILITY.md`: EOAs cannot own sub-accounts or grant spend
permissions). So:

- **Show the agent UI only to Coinbase Smart Wallet / Base Account users.**
- **EOAs:** unchanged per-action UI (collect/buy/list as today) + a soft "available
  with a Base Account / in the Base App" note. No agent UI, no regression.
- 7702-upgraded EOAs read as smart wallets and qualify automatically.

## 2. Feature-parity matrix (platform → agent → UI → status)

"100% parity" target is the **commerce surface** (collect/buy/list). Creator/social
features are out of scope by design.

| Platform feature | Agent support | UI surface(s) today | Parity status |
| --- | --- | --- | --- |
| **Collect — single** | ✅ `prepare-collect` / `useDirectCollect` | `MomentCard`, `MomentDetailView` | **Full.** Tap-free when collecting account active. |
| **Collect — all / batch** | ✅ `prepare-collect-batch` / `useCollectAll` | `CollectAllAction` (feed, collection, headings) | **Full.** One approval; tap-free when active. |
| **Collect — curated basket (Propose)** | ✅ `discover` + batch | `DiscoverPage`, `FeaturedFeed` | **New affordance to add.** |
| **Buy (secondary)** | ✅ `prepare-buy` / `BuyButton` | `MarketCard`, `BuyButton`, `MomentDetailView` | **Full** (1 tap ETH; 5792-batch USDC). |
| **List (secondary)** | ✅ `prepare-list` / `ListButton` | `ListButton` (owned moments) | **Full** (sign + one-time approval). |
| **Cancel listing** | ⚠️ backend supports (signed PATCH `cancelled`); **no agent prepare** | `ListButton`/market | **Gap** — add for full seller parity. |
| **Mint / create** | ❌ deferred (Creator-Pass-gated, media upload) | `MintForm`/`MintTabs` | **Intentional gap** (out of scope). |
| **Airdrop** | ❌ creator tool | `AirdropForm` | Out of scope. |
| **Discover / browse** | ✅ `discover` (free); x402 curated (future) | `DiscoverPage` | Full (read). |
| **Search / follow / curate / hide / profile-edit** | ❌ non-commerce | various | Out of scope. |
| **Collecting account (budget / tap-free / Scouts)** | ✅ Mode A built; Scouts future | **new** profile panel + setup sheet | New (smart-wallet only). |

**Parity verdict:** collect / buy / list are at **full functional parity** (incl.
feature-specific nuances in §3). Remaining commerce gaps: **cancel-listing**
(small, worth adding) and **mint** (intentionally deferred).

## 3. Feature-specific functionality the UI must handle

The agent must respect every per-action nuance the platform does:

- **Currency:** ETH (`fixedPrice`/FixedPriceStrategy) vs USDC (`erc20Mint`/ERC20Minter)
  — drives 1 vs 2 calls, the budget currency, and price display.
- **Sale state:** not-started / active / ended / **sold out** / per-wallet cap hit →
  surface "can't collect" cleanly (we already filter via `fetchEligibleTokens`).
- **Already collected** (per the account's collected set) → de-dupe in Propose/Scouts.
- **Price/free:** `free` vs `$X`/`Ξ X`; ETH adds the protocol `mintFee`.
- **Writing vs media moment:** content-type affects card preview (not the action).
- **Pass-gated collection:** collecting a Pass grants validity (webhook + the
  on-chain-verified `/api/collect` path) — the agent collect must record so validity
  is credited. (Minting is Pass-gated → out of scope.)
- **Buy:** listing active/expired, not own listing, Seaport allowance, EIP-2981
  royalty (display).
- **List:** ownership (`balanceOf`), one-time `setApprovalForAll(Seaport)`, EIP-2981
  royalty enforced, currency, 30-day expiry.
- **Recipient:** tap-free/auto collects mint to the **main account** (`mintTo =
  universal`) so they appear in the user's normal Collected section.

## 4. The variable inventory (identify everything first)

### 4.1 Wallet / environment
- Connected? chain == Base (8453)?
- **Wallet class:** Coinbase Smart Wallet (Base Account) / Coinbase Wallet EOA /
  other EOA / Farcaster mini-app wallet / WalletConnect.
- **Smart-wallet-capable?** (gates the whole agent UI) — see §5 detection.
- **Sub-account capable?** (Base Account SDK `wallet_addSubAccount`) — may differ from
  generic smart-wallet; **verify in the Base App mini-app** (injected provider).
- **Runtime:** Base App (Coinbase WebView, `isCoinbaseWebView`) / Farcaster mini-app /
  web (desktop/mobile). Provider differs (injected vs SDK vs WalletConnect).
- Paymaster configured? (`NEXT_PUBLIC_PAYMASTER_URL`) → gasless vs needs ETH for gas.

### 4.2 Collecting account (sub-account) state
- Provisioned? budget granted? status: **none / active / paused / expired / revoked**.
- Budget: currency (USDC v1), allowance, period (days), start, end.
- **Remaining this period**, next reset (`getPermissionStatus`).
- Recipient = main account (fixed).
- (Scouts, future) policy: collections, creators, max item price, max items/period,
  media types, mode (propose/auto).

### 4.3 Per-moment / per-action (from §3)
currency · price · mintFee · sale state · per-wallet cap · already-collected ·
ownership · approval state · royalty · listing active · is-own-listing.

### 4.4 UI state / lifecycle
- Phase: idle / preparing / awaiting-approval / confirming / recording / done / error.
- Tap-free vs needs-approval (depends on collecting-account active + budget remaining).
- First-time vs returning (one-time activation offer).
- Empty states (nothing eligible; no budget; no listings).

### 4.5 Errors / edges
user rejection · unsupported wallet (no 5792 / no sub-account) · insufficient funds ·
sale ended/sold-out mid-flow · per-wallet cap · **budget exhausted** · network/RPC ·
recording lag (on-chain succeeded, PATCH/`/api/collect` failed) · paymaster failure.

### 4.6 Trust / safety (display)
What the agent can do (collect within budget) and **cannot** (exceed cap, touch funds
outside the permission) · spend cap + ledger visibility · one-tap **pause/revoke** ·
recipient = your main account · untrusted-content rule (if a chat ships).

### 4.7 Surface / placement
profile (owner panel) · feed card (`MomentCard`) · collection (`CollectAllAction`) ·
moment detail (`MomentDetailView`) · market (`BuyButton`) · discover (Propose) · nav ·
notifications (autonomous activity) · optional co-pilot chat · external-assistant card.

## 5. Smart-wallet detection (the gate)

Layered `useSmartWalletAgentEligibility()` hook (build once, reuse everywhere the
agent UI renders):

1. **Capability check** — EIP-5792 `wallet_getCapabilities` for the connected
   address on Base: atomic batch supported? (Coinbase Smart Wallet ✔.)
2. **Contract check (fallback)** — `eth_getCode(address) !== '0x'` → a deployed smart
   account (catches 7702-upgraded EOAs too).
3. **Sub-account capability** — only when (1)/(2) pass, confirm the Base Account SDK
   can `wallet_addSubAccount` (treat failure as "not eligible" and hide the UI). This
   is the one to **verify in the Base App mini-app** (injected Coinbase provider) and
   on web (SDK provider) — the provider plumbing may differ from the wagmi connector.

Gate: render the agent UI only when eligible; otherwise the existing per-action UI +
soft note. SSR-safe (no `window` on server → render the EOA/default path, hydrate up).

## 6. The UI/UX design

Principle: the agent is a **native upgrade to collecting**, not a separate app.
Affordance-first (chat is a Phase-2 option).

### 6.1 Setup (one approval) — `CollectingAccountSetupSheet`
Triggered from the profile panel or the collect-context offer. One sheet: pick a
**USDC budget** (amount + period) → one Base Account approval that provisions the
sub-account + grants the Spend Permission. Clear copy on what it does and that it's
revocable. Gasless via paymaster if configured.

### 6.2 Profile home — `CollectingAccountPanel` (owner-only, eligible-only)
Lives with the existing owner sections/edit affordances in `ProfileView`. States:
- **Not set up:** value pitch + **[Set up]**.
- **Active:** remaining budget this period, next reset, a **collect ledger**, and
  **[Adjust] [Pause] [Revoke]**. (Scouts sub-panel later.)

### 6.3 In-context — tap-free collecting
When the collecting account is active, the **existing** collect affordances run
popup-less:
- `MomentCard` "collect+" and `MomentDetailView` collect → tap-free; subtle
  "tap-free" indicator + remaining-budget hint.
- `CollectAllAction` → popup-less batch (and the natural **activation point**: after a
  non-setup "collect all", show the one-time offer).
- Budget-aware: if a collect would exceed the remaining cap, fall back to per-action
  approval (never block).

### 6.4 Discover — Propose
A "Collect picks" affordance in `DiscoverPage`/`FeaturedFeed`: an agent/curated set →
one popup-less batch (or one approval if not set up). Powered by `discover` (free;
x402 curated later).

### 6.5 Notifications — autonomous activity
`NotificationFeed`/`Bell` gains scout/auto-collect types ("collected 3 this week —
$7"), budget-low, paused.

### 6.6 External assistant (secondary)
A small "Connect your AI assistant" card (profile/settings) with the `mcp.base.org` +
skill link, for users who want to drive Kismet from Claude/ChatGPT/Base App assistant.

### 6.7 Co-pilot chat (Phase 2, optional)
A conversational entry ("collect the best new photography under $5") that chains
discover → prepare → execute. Autonomous parts smart-wallet-gated; treat all
moment/API content as untrusted (no acting on embedded instructions).

## 7. Open decisions / must-verify before building

1. **Base App mini-app provider** — does `wallet_addSubAccount` / the Base Account SDK
   work through the Coinbase WebView injected provider the mini-app uses (vs the
   `@base-org/account` SDK provider, which may conflict with the wagmi connector)?
   **This is the top risk — verify first.**
2. **Live smoke test** — buy (ETH/USDC + fallback) and the Mode A round-trip on a real
   Base Account.
3. **Cancel-listing** parity — add an agent path? (small).
4. **Interaction model** — affordance-first MVP (recommended) vs co-pilot chat.
5. **Naming/copy** — "Collecting account" / "Auto-collect" / "Tap-free collecting".
6. **Paymaster** — sponsor gas or require ETH for the sub-account's gas.

## 8. Implementation plan (after decisions)

1. `useSmartWalletAgentEligibility()` detection hook (+ verify §7.1).
2. `CollectingAccountSetupSheet` + `CollectingAccountPanel` (profile) — Mode A.
3. Budget-aware `CollectAllAction` + `MomentCard` (tap-free when active) + the
   collect-context activation offer.
4. Discover **Propose**.
5. Notifications for autonomous activity.
6. (Parity) cancel-listing agent path.
7. (Phase 2) Scouts (Mode B), co-pilot chat, x402 curated discover.

Every step honors the EOA guardrails (`AGENT_UI_WIRING.md`): per-action path
unchanged; agent UI conditionally rendered; no regression.
