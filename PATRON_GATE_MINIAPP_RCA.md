# Patron Gate RCA — miniapp prompts a pass-holder to collect again (2026-07-29)

Root-cause analysis for the report: *a wallet that already collected from the
Kismet Patron Collection (`andreaboi.eth`,
`0x8425cb9db22f88bb38f6c64b39c4712e4ca8aa11`) opens the Mini App and the CREATE
form still shows "COLLECT FROM KISMET PATRON COLLECTION / minting requires an
artwork from Kismet Patron Collection".*

Validated end-to-end against code and git history. Live-production probes
(`kismet.art` API, Base RPC) were egress-blocked in the analysis sandbox; §4
lists the exact two-minute confirmation commands to run from any normal
machine. Everything else below is deterministic from code.

> **STATUS: FIXED ON THIS BRANCH (2026-07-29).** The §6 design shipped as the
> identity-union gate — see **§9 Resolution** for exactly what changed. §§1–5
> describe the pre-fix state and are retained as the incident record and the
> design rationale the code comments cite. §7 (per-user remediation) is only
> needed if the §4 probes reveal the Scenario-B lost-credit case, which this
> fix does not (and must not) paper over.

**Verdict in one line:** the pass gate is evaluated against the
**wagmi-connected signer wallet**, and inside a Mini App that signer is the
**host's embedded wallet** (Farcaster wallet / Base App account) — a different
address from the user's Kismet identity wallet that actually holds the pass;
pass validity is a per-wallet Redis ledger with **no address-union across a
user's FC-verified wallets**, so the Mini App treats this user as pass-less on
every open, even though the platform's own identity doctrine
(`lib/addressUnion.ts`) says a Farcaster user is one identity across all their
verified wallets.

---

## 1. Symptom, restated precisely

- Mini App CREATE form replaces the mint button with the gate CTA
  (`components/MintForm.tsx:2015-2031`).
- The same user's profile (`0x8425…aa11`) shows 2 created artworks and — per
  the report — the collected patron piece. On desktop web (wallet `0x8425…`
  connected directly) the gate does not fire for them.

The CTA renders iff `gatedOut` from `usePassGate` (`hooks/usePassGate.ts:45-49`):

```
gatedOut = passGate.enabled && passGate.passCollection && passGate.validBalance < 1 && !isAdmin
```

The probe **fails open** (in-flight, error, or no wallet → `gatedOut=false`),
so a rendered CTA strictly implies: **gate enabled AND the probed address has
ledger `validBalance = 0`** (or is pass-blacklisted, which the endpoint reports
as 0 — `app/api/pass-validity/route.ts:61-68`).

## 2. The gate stack — what decides the prompt

| Layer | Subject it checks | Source |
|---|---|---|
| CTA hint (`usePassGate`) | `useAccount().address` — the **connected signer** | `hooks/usePassGate.ts:33-39` |
| `/api/pass-validity` | raw Redis ledger read for that address (`getValidBalance`), **no on-chain fallback** | `app/api/pass-validity/route.ts:70`, `lib/pass-validity.ts:222-229` |
| Mint enforcement (`/api/mint`, `/api/write`) | `body.account` — the **intent-signed signer** | `lib/mint-proxy.ts:127-165` |
| Create-collection enforcement | `sessionAddress` — the **Quick-Auth identity** (≠ signer in Mini App!) | `app/api/collections/route.ts:481-490` |

Two structural properties matter:

1. **The ledger only ever clamps down.** `hasValidPass` reconciles against
   `balanceOfBatch` but only lowers the ledger (`lib/pass-validity.ts:580-596`);
   `getValidBalance` never reads the chain at all. Holding the pass on-chain
   with no platform-provenance credit ⇒ permanently gated until a manual
   repair. This is the deliberate pass-purity design (mint / airdrop /
   Kismet-secondary only), but it means lost or mis-addressed credits never
   self-heal.
2. **Validity is strictly per-wallet.** There is no aggregation across a
   user's wallets anywhere in the gate stack.

## 3. Root cause

Inside a Mini App, wagmi connects the **host wallet**, not the user's own EOA:

- `lib/wagmi.ts:148-152` — `farcasterMiniApp()` is registered first in Mini App
  environments; `injected()` for Coinbase/Base-App WebViews.
- `providers/FarcasterProvider.tsx:552-563` — bootstrap explicitly connects the
  `farcaster` connector (the host's embedded wallet provider).
- `hooks/useBaseAppAutoConnect.ts` — auto-connects the Base App's injected
  wallet.

Meanwhile the nav shows the user as `andreaboi.eth` because Mini App identity
comes from a *separate* channel: Quick-Auth JWT → FID →
`getKismetIdentityAddress` (FidProfile.currentAddress → legacy pointer → FC
primary; `lib/farcasterAuth.ts`). So the screen presents the user as
`0x8425…aa11` while every wallet-keyed check runs against the host wallet.

The pass credit (from their collect/airdrop) lives on `0x8425…aa11`. The host
wallet has none. `usePassGate` probes the host wallet → `validBalance: 0` →
CTA. **Deterministic on every Mini App open.** And it is not merely a UI hint
bug: `mint-proxy` would 403 the actual mint for the same reason (it gates on
the intent-signed signer).

The codebase already names the missing piece. `lib/addressUnion.ts:12-31`
defines the server-side **address union** — *"makes a Farcaster user feel like
a single Kismet identity regardless of which of their wallets they happen to
use for a given on-chain action"* — and applies it to timeline
creator/collector filters, artist earnings (`expandToEarningsWallets`),
hidden-profile moderation closure, and canonical profile resolution. **The
pass-validity gate is the one entitlement surface that never got the union.**

Corroborating inconsistency: because `/api/collections` gates on the *session
identity* while `mint-proxy` gates on the *signer*, today's Mini App user is
simultaneously pass-valid for create-collection and pass-less for minting —
two sibling endpoints disagree about who the caller is. (Client-side, both
forms are blocked by the same signer-keyed CTA, which is why the create-form
inconsistency isn't user-visible yet.)

## 4. Two scenarios, and the two-minute disambiguation

**Scenario A (primary, expected):** `0x8425…aa11` has ledger validity; the Mini
App prompt is purely the signer/identity split above. Predicts: desktop create
works; Mini App prompts; host wallet probes 0.

**Scenario B (possible additionally):** the pass-holding wallet itself reads
`validBalance 0` because its credit was lost. This is the known 2026-07-24
incident class — the webhook used to credit only platform-flagged txs, so a
mint whose `/api/collect` never ran earned nothing (fixed by `617a48a`
"credit Pass mints from the webhook, not just flagged txs" + the synchronous
credit in `/api/collect` + `scripts/reconcile-pass-validity.mjs` for
retroactive repair). Also possible: false taint or pass-blacklist. Predicts:
desktop create would prompt too.

Run from any machine with normal egress:

```bash
# 1. The identity wallet's ledger state (what desktop sees):
curl -s 'https://kismet.art/api/pass-validity?address=0x8425cb9db22f88bb38f6c64b39c4712e4ca8aa11'
#    validBalance >= 1  → Scenario A confirmed.
#    validBalance == 0  → Scenario B (check provenance via /api/admin/taint?address=<wallet>, then
#                         reconcile script or admin grant — see §7).

# 2. Identify the Mini App signer: Farcaster app → Settings → Wallet
#    (or the `wallets` array from /api/me for this FID — the host wallet is
#    auto-verified onto the FID). Then:
curl -s 'https://kismet.art/api/pass-validity?address=<HOST_WALLET>'
#    Expected 0 — confirms the probed subject in the Mini App.

# 3. On-chain cross-check (holder truth), Patron collection
#    0x80ce7bd430f34792490a22ee0fd479e7333715c9 (STACK_OVERVIEW.md:126):
#    balanceOfBatch for both addresses across known tokenIds, e.g. via Basescan.
```

## 5. Secondary traps the current CTA creates

1. **Double payment.** Obeying the CTA inside the Mini App collects with the
   connected signer: `useDirectCollect` mints to
   `getAccount(config).address` (`hooks/useDirectCollect.ts:122`, `mintTo:
   account` at `:214`). The user buys a *second* pass onto the host wallet
   while already owning one on their identity wallet. This is exactly the
   "prompts him to collect even though he already collected" harm.
2. **Catalog/payout fragmentation.** If they then mint from the Mini App,
   `account`/`artist` (and the default `payoutRecipient`,
   `components/MintForm.tsx:863`) are the host wallet — moment attribution and
   proceeds accrue to a wallet the user doesn't think of as theirs. The
   timeline address-union masks this in feeds, but moment-meta creator and
   split payouts do not union. (Adjacent product issue; out of scope here but
   worth a follow-up.)

## 6. Recommended fix — apply the address union to the gate

**Evaluate pass validity over `expandToFidSiblings(signer)`: the caller passes
if ANY FC-verified sibling wallet passes `hasValidPass`.** Ledger, taint,
blacklist, and revocation stay per-wallet and untouched; only the
*authorization read* aggregates.

### Where

1. **Server (one choke point):** `lib/gate.ts hasGateAccess` — keep the admin
   and pass-collection-target bypasses; check the signer first (cheap, common
   case unchanged); on failure expand via `expandToFidSiblings(signer)`
   (dedup, lowercase, cap ~10, short-circuit on first valid; order:
   signer → FidProfile.currentAddress/identity → rest). This automatically
   fixes every enforcement caller: `mint-proxy` (`/api/mint`, `/api/write`),
   `/api/collections`, `/api/agent/prepare-mint` — and makes the
   signer-vs-session inconsistency moot (the union contains both).
2. **Client hint:** extend `/api/pass-validity` with `?scope=identity` (or a
   sibling endpoint) that returns the union-aggregated `validBalance`
   (server-side, same `expandToFidSiblings`), and have `usePassGate` probe with
   that scope. The ProfileView "Valid Pass" badge keeps the per-address default
   — a badge on a token is genuinely about that wallet's holding. CTA and
   server verdict then share one predicate and cannot drift.
3. **Tests:** union OR-logic incl. per-wallet blacklist/taint/admin-grant;
   FC-API-failure degraded mode (union collapses to `[signer]` — denies, never
   admits); Mini-App-shaped integration (signer = host wallet, pass on
   identity wallet → mint allowed); web cookie-session regression unchanged.

### Why this is the right fix (validated reasoning)

- **Consistency with the platform's own doctrine.** The identity picker
  restricts to FC-verified wallets (`app/api/me/identity`), sessions resolve
  to the chosen identity, timelines/earnings/moderation/profiles all union
  (`lib/addressUnion.ts`). The gate is the outlier; this removes the outlier
  rather than adding a new concept.
- **Cryptographically anchored.** The signer is proven by the intent signature
  (`mint-proxy` `verifyIntent`); signer→FID comes from the reverse index seeded
  only by the public FC verifications endpoint
  (`lib/farcasterProfile.ts:290-303`); FID→siblings are on-protocol *signed*
  verifications. Sibling entitlement is exactly as trustworthy as FC
  verification — the same trust already extended for earnings attribution and
  hidden-profile ownership (`isViewerFidSibling`). No session plumbing needed
  in `mint-proxy`.
- **Pass-purity invariants intact.** Read-time OR over per-wallet
  `hasValidPass`: each inner call still applies blacklist, taint exclusion,
  and the live clamp-down. No ledger writes, no credit mirroring — if the
  holder transfers the pass out, the webhook decrements the holding wallet and
  the union flips for the whole identity. Revocation semantics unchanged.
- **Fails degraded, never open.** A verifications-fetch failure returns `[]`
  (lenient projection, `lib/farcasterProfile.ts:319-324`) → union collapses to
  the signer → today's behavior. Since the union only ever *expands* access
  from affirmative FC data, the lenient variant is safe for an authorization
  gate.
- **Bounded cost.** `expandToFidSiblings` is ~1-2 Redis-cached reads (1h TTL);
  extra `hasValidPass` evaluations run only when the signer check fails —
  i.e., exactly the currently-broken path. Endpoints are already rate-limited
  (mint 20/min/IP, pass-validity 60/min/IP).
- **Policy decision to make explicit (recommended: deny):** should a
  pass-blacklisted wallet anywhere in the union deny the whole identity?
  Recommended yes — moderation targets the person, matching the
  hidden-profiles sibling-closure precedent. (Minimal alternative: keep
  per-wallet blacklist only; a blacklisted signer with a clean sibling would
  then pass — weaker moderation.)

### Alternatives considered and rejected

| Alternative | Why rejected |
|---|---|
| On-chain `balanceOf` across wallets (skip the ledger) | Breaks the "valid pass" provenance definition the entire taint/platform-tx machinery enforces; re-admits off-platform-acquired passes. |
| Mirror-credit the host wallet when the identity holds a pass | Second source of truth; transfer-out of the real pass wouldn't revoke the mirror (webhook only decrements the holding wallet) → permanent laundering hole. |
| Switch mint-proxy's subject to the session identity (like `/api/collections`) | Re-creates the same bug mirrored (desktop user whose session identity ≠ pass wallet); `mint-proxy` is deliberately session-free and intent-signed. The union subsumes this. |
| Mini-App-only UX explainer ("your pass lives on 0x8425…, use kismet.art") | Honest but leaves invited artists unable to create from the Mini App — a shipped, first-class surface. Acceptable only as interim copy. |
| Ask the user to collect again in the Mini App | Double payment for an owned entitlement + catalog/payout fragmentation (§5). This is what the current CTA de-facto instructs. |

## 7. Immediate remediation for the affected user (no deploy)

1. Run the §4 probes to confirm the scenario.
2. **Scenario A:** unblock now via the admin escape hatch — `/admin/pass` →
   `setValidBalance(passCollection, <host wallet>, 1)`. The admin-grant flag
   survives live reconciliation by design (`lib/pass-validity.ts:243-268`).
   Revert once the union fix ships. Tell the user **not** to collect again in
   the Mini App.
3. **Scenario B:** for a mint-origin lost credit run
   `node scripts/reconcile-pass-validity.mjs --address 0x8425… --commit`; for
   airdrop-origin use the admin grant; for a false taint use the documented
   `removeTaint` + grant remedy (`lib/pass-validity.ts:612-618`).

## 8. Timeline of relevant changes

- **2026-07-13** — pass gate, validity ledger, Mini App provider land (repo
  history anchor `08e374e`).
- **2026-07-18** — airdrop path credits validity (`/api/airdrop/notify`).
- **2026-07-24** — "minted-but-never-credited" incident fixed: webhook mint-arm
  (`617a48a`), synchronous `/api/collect` credit, reconciliation script
  (`ebceea8`). Losses predating this need the script.
- **2026-07-29** — this report: Mini App signer/identity split surfaces as
  "already collected but still prompted". Identity-union gate implemented
  (§9).

## 9. Resolution (what shipped)

The §6 design, implemented as a read-time identity union with per-wallet
provenance untouched:

- **`lib/passUnion.ts`** (new, pure/redis-free — the `lib/gateFlags` testable
  pattern): `planUnionCheck` (lowercase, first-seen dedup, caller-first,
  capped at `MAX_UNION_WALLETS = 10`) and `parseLedgerBalance` (Upstash
  string/number dual-form parse, clamp at 0 — now shared by
  `getValidBalance`).
- **`lib/addressUnion.ts` → `expandToGateWallets(address)`**: the caller plus
  its FC-verified siblings via the existing `expandToFidSiblings`, planned and
  capped; **fails degraded to `[address]`** on any lookup failure (the union
  only ever widens access from affirmative FC data). Smart wallets excluded —
  validity credits only ever land on recipient EOAs.
- **`lib/pass-validity.ts`**: `getValidBalances` (ONE MGET for N wallets) and
  `hasValidPassForAny` — MGET ledger prefilter, then the full `hasValidPass`
  (blacklist + taint + live `balanceOfBatch` clamp) only on positive-ledger
  wallets. The prefilter is exact, not heuristic: the ledger never reconciles
  upward, so `ledger <= 0 ⇒ hasValidPass = false` and skipping cannot change
  the verdict. Single-wallet input delegates straight to `hasValidPass` — a
  non-FC caller's path is byte-identical to before.
- **`lib/gate.ts` `hasGateAccess`**: unchanged admin / disabled /
  pass-collection-target bypasses, then `expandToGateWallets` →
  **identity-scoped pass-blacklist** (any listed union member denies — with
  union grants, a signer-only blacklist would be hoppable via a sibling
  wallet; same closure principle as hidden-profiles) →
  `hasValidPassForAny`. One choke point fixes every enforcement caller:
  `/api/mint`, `/api/write` (mint-proxy), `/api/collections` (create-form),
  `/api/agent/prepare-mint` — and dissolves the §3 signer-vs-session
  inconsistency, since both subjects resolve to the same union.
- **`/api/pass-validity?scope=identity`**: union-summed ledger read, zeroed if
  any union member is pass-blacklisted — mirrors `hasGateAccess` exactly so
  the CTA can never disagree with the server verdict. The default per-address
  scope is untouched (ProfileView's per-token badge is genuinely per-wallet).
- **`hooks/usePassGate.ts`**: probes with `scope=identity`.
- **`scripts/verify-pass-union.ts`** (wired into `verify:flows`): pins the
  plan ordering/dedup/cap invariants and the Upstash dual-representation
  parse (the same regression class `verify-gate-flags.ts` guards).

Deliberately NOT done, per §6's rejected-alternatives table: no on-chain
balance shortcut, no mirror credits to the host wallet, no session-subject
swap in mint-proxy. Scenario-B lost credits (§4) remain a data repair
(`scripts/reconcile-pass-validity.mjs` / admin grant), not a code path — the
union must not launder a wallet whose credit was legitimately never earned.
