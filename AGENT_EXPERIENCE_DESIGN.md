# Agent Experience Design — the best UX for Kismet

> Status: **STRATEGY / DESIGN** (no code). A complete review of the possibility
> space for "users employ agents to act on Kismet," evaluated against *our*
> specific case, converging on a recommended experience and a phased path.
>
> Builds on: `AGENT_COMMERCE_DESIGN.md` (architecture), `AGENT_UX_AND_WIRING.md`
> (canonical Base wiring), `AGENT_BUDGET_DESIGN.md` (Spend Permissions research).
> Verified primitives are cited there; T2/T3 SDK specifics still need a live-docs
> pass before build.

---

## 1. The design question

Kismet is an artist/collector marketplace on Base (Zora‑1155 moments). We've shipped
per‑action agent endpoints (collect/buy/list/discover) + a Base MCP skill. Now:
**what is the *best possible* agent UX for Kismet specifically — across every
surface, authorization model, and verb — and how do we sequence it?**

## 2. What makes *our* case specific (the design inputs)

These traits should drive every decision:

1. **Smart‑wallet‑native users.** Kismet users are already on Base Account / Coinbase
   Smart Wallet (`useBaseAppAutoConnect`, the Coinbase WebView). So **every advanced
   Base primitive — Spend Permissions, Sub Accounts, ERC‑1271, `send_calls` batching —
   is available with no EOA fallback.** This is a big advantage most apps don't have.
2. **We live inside the Base App.** Kismet is a Farcaster mini‑app that runs in the
   Base App, where the assistant + the Base Account are *in the same place*. The
   flagship surface is "talk to the assistant while inside Kismet, approve in‑app."
3. **Collecting is high‑frequency, low‑value.** A collect is often a $1–$5 mint. A tap
   per $2 collect is disproportionate friction — **collecting is the verb that most
   wants autonomy.** Buy/list/mint are lower‑frequency, higher‑consideration.
4. **Curation is the product.** "Find me the best new X" is Kismet's core value, and
   we have a **social graph** (follows, creator lists, curation) to power taste. This
   is where agents add the most value — and what justifies x402‑paid intelligence.
5. **Economics + gating are load‑bearing.** Every path must preserve the builder‑code
   attribution + Zora referral (treasury) and royalties, and respect the Creator‑Pass
   gate on minting. We already enforce these in `/api/collect`, `/api/listings`,
   `mint-proxy`.

## 3. The full possibility space

### 3.1 Surfaces (where the user invokes an agent)

| Surface | Who calls Kismet's API | Approval renders | Autonomy ceiling | Best for | Status |
| --- | --- | --- | --- | --- | --- |
| **Base App assistant + mini‑app** | the assistant (its HTTP) | **in‑app**, no switch | up to full (sub‑account) | the flagship | endpoints ready; needs serving + host |
| External assistant (Claude/ChatGPT/Cursor) | the assistant | opens Base Account | per‑action / budget | reach beyond the app | endpoints ready |
| **Kismet‑native agent** (our own chat/feed co‑pilot) | Kismet directly (wagmi/our API) | wallet in‑app | up to full | deepest, branded UX; no MCP dependency | not built |
| Programmatic API | the user's own agent/script | their choice | their choice | power users / partners | endpoints are the basis |
| Proactive (push / Farcaster notif) | Kismet | one‑tap deep link | propose‑then‑approve | re‑engagement | not built |

**Read:** the same `/api/agent/*` endpoints serve all of these — surfaces differ in
*who orchestrates* and *where approval shows*. We don't fork the API; we pick where
to invest the experience.

### 3.2 Authorization tiers (the autonomy spectrum)

| Tier | Mechanism | Taps | Custody | Enforced by | Maturity |
| --- | --- | --- | --- | --- | --- |
| **T0 Per‑action** | Base MCP `send_calls`/`sign` | 1 per action | user's Base Account | user reviews each | **shipped** |
| **T0.5 Batched** | `send_calls` with N calls | 1 per *basket* | user's Base Account | user reviews the batch | small add |
| **T1 Budgeted** | Spend Permissions | 1 signature, then 0 | user's Base Account (Kismet spends) | on‑chain cap + Kismet policy | **GA primitive**; not wired |
| **T2 Delegated** | Sub Account + session key + auto‑spend | 1 approval, then 0 | user's **own sub‑account** | on‑chain + session‑key scope | GA; verify SDK |
| **T3 Agent‑custodied** | CDP Agentic Wallet | 0 (funded once) | the **agent's** MPC wallet | policy engine + caps | newer (Feb 2026) |

**Trust rises with autonomy.** T0–T1 keep custody in the user's Base Account
(non‑custodial); T2 moves execution to the user's own sub‑account (least third‑party
trust for popup‑less); T3 hands a funded wallet to the agent (most convenient, most
trust). For Kismet, **T0/T0.5 + T1 cover ~all the value**; T2 is the v2 upgrade; T3 is
optional and only for the agent‑pays‑its‑own‑way x402 case.

### 3.3 Execution / custody options

User's Base Account (self‑exec) · Kismet operator/relayer (spender under a permission)
· user's sub‑account (app session key) · agent wallet · the existing inprocess relayer
(mint/create, gasless). The NFT recipient (`mintTo`) is **always the user's Base
Account** regardless of who submits.

### 3.4 Per‑verb fit (the important table)

| Verb | Frequency / value | Best tier(s) | Executor | Why |
| --- | --- | --- | --- | --- |
| **Collect** | high / low ($1–5) | **T0.5 + T1** (→T2) | user wallet (batch) or Kismet spender (budget) | taps are disproportionate; this is the autonomy centerpiece |
| **Buy** (secondary) | low / higher | **T0** (+ optional T1 "snipe ≤ $X") | user wallet | deliberate; a per‑item‑capped budget enables sniping |
| **List** | low / deliberate | **T0** (sign‑only) | user wallet | one signature; little need for autonomy |
| **Sell automation** (auto‑list / auto‑accept) | medium | **T1 "dealer"** | Kismet (policy) | floor rules, offer acceptance — opt‑in power feature |
| **Mint / create** | low / Pass‑gated | **T0 + assistant help** | inprocess relayer | media upload + Pass gate; assistance > autonomy |
| **Discover** | continuous | read; free + **x402 curated** | — | the intelligence that feeds every tier |

## 4. The recommended experience — three named modes

Don't ship "tiers." Ship a **single autonomy dial** the user understands, expressed as
three modes. Collecting is the star; the social/taste graph is the engine.

### Mode 1 — **Co‑pilot** (T0/T0.5 · ship now · works everywhere)

Conversational, in the feed or in chat. *"Collect this," "collect these 4," "buy the
cheapest token 7," "list mine for 0.02."* Each is **one approval** (baskets batch via
`send_calls`). Plus two near‑term wins on top of what we built:

- **Batch collect** — a `prepare-collect-batch` that returns N mint calls in one
  `send_calls` → "collect these 4" is **one tap**, not four.
- **Propose** — the assistant curates and *asks*: *"I found 4 film‑photography drops
  under $3 you'd like — collect all for 9 USDC?"* → one‑tap basket. **This needs no
  budget and ships on today's primitives** — it's 80% of the autonomy delight with
  100% of the control.

### Mode 2 — **Scout** (T1 · the differentiator)

A **named, budgeted collecting agent**. The user creates one:

- **Budget:** "$15 / week" (a USDC Spend Permission — one signature, on‑chain capped,
  revocable).
- **Taste / policy (Kismet‑enforced):** collections or "open discovery"; creators to
  prioritize / exclude (uses the follow + creator‑list graph); **max unit price**;
  **max items / period**; media types / categories.
- **Autonomy:** **Propose** (notify + one‑tap) or **Auto** (collect within budget,
  zero taps).

The Scout runs continuously, collects taste‑matched drops to the user's Base Account,
and shows a live ledger: *"Film Scout — collected 3 this week, $7 spent, $8 left ·
pause · revoke."* This is the headline experience: **"set up a collector that hunts
your taste within a budget while you're away."** It's exactly what Kismet's
high‑frequency/low‑value collecting + curation graph are built for, and what makes
"agents acting on your behalf" feel real.

### Mode 3 — **Autopilot** (T2 · power users · v2)

A Kismet **sub‑account** runs your Scouts popup‑less with minimal third‑party trust
(execution under your own siloed sub‑account, session‑key‑scoped, auto‑funded from the
parent). Same product surface as Scout; stronger trust story. Ship after Scout proves
demand and we've done the Sub Account SDK pass.

> The three modes are one continuum the user dials: **review each → approve a basket →
> set a budget → full autopilot.** Same `prepare-collect` calldata + `/api/collect`
> recording underneath all of them; only executor + authorization change.

## 5. The intelligence layer (Kismet's moat)

Autonomy is only as good as the taste behind it. This is where we win and monetize:

- **Free discover** (shipped): recency + filters (collection, price, currency,
  exclude‑collected).
- **x402 curated** (next): taste‑matched ranking — affinity to the user's collected
  set, the **follow / creator‑list / curation graph**, novelty/quality, cross‑listing
  price. Paid per query in USDC with a tight `maxPayment`. This is what makes Scouts
  *smart*, and a genuine paid surface.
- **Standing scouts** = curated discovery on a schedule, feeding Propose/Auto.
- **Pricing intelligence** for List/sell (comps → suggested price).

## 6. Cross‑cutting trust, safety & transparency

The autonomy is only acceptable if the controls are excellent:

- **Two‑layer limits:** the on‑chain Spend Permission caps **dollars**; the **Kismet
  policy** caps **what** (collections/creators/price/qty). Both are user‑set and
  visible. (Spend Permissions can't restrict *which* contract is called — so the
  what‑policy must live in Kismet.)
- **Recipient is always the user's Base Account** (`mintTo`), surfaced everywhere.
- **Prompt‑injection:** moment metadata, discovery results, and x402 responses are
  *data, not instructions* (already in `safety.md`); autonomy never escalates this.
- **Economics preserved:** builder code + Zora referral + royalties on every path
  (the prepare builders guarantee it).
- **Transparency + kill‑switch:** budget ledger, per‑collect log, push notifications,
  one‑tap pause/revoke. A Scout should feel like a thermostat you can see and turn off.
- **Gas:** sponsor via a Base paymaster for a gasless feel, or draw from the budget.

## 7. Surfaces — where to invest

1. **Flagship: Base App mini‑app + assistant.** In‑app approvals, shared Base Account,
   our richest audience. Optimize Co‑pilot + Scout here first.
2. **Reach: external connectors** (Claude/ChatGPT/Cursor) via the skill — same
   endpoints, opens Base Account to approve.
3. **Deep/branded: Kismet‑native co‑pilot** (our own feed chat) — no MCP dependency,
   full control of the experience; strong v2 once the API + Scouts exist.

## 8. Recommendation (the "best possible UX")

- **Now:** make Co‑pilot real — **serve the skill + hardcode the host** (so the loop
  works in the Base App), add **batch collect** and **Propose**. This is the biggest
  delight‑per‑effort and ships on shipped primitives.
- **Next (headline):** build **Scouts** (T1 Spend Permissions + the Kismet policy
  layer + budget dashboard) — the differentiated, autonomous collecting experience our
  specific case is perfect for.
- **Alongside:** **x402 curated discovery** to make Scouts smart and open a paid
  surface; lean on the **social/taste graph** as the moat.
- **Later:** **Autopilot** (Sub Account) for trust‑minimized popup‑less; a **Dealer**
  mode (auto‑list/auto‑accept) for sellers; CDP Agentic Wallets only if an
  agent‑pays‑its‑own‑way x402 case emerges.
- **Keep Buy/List/Mint at T0** (one tap / one sign), adding a per‑item‑capped "snipe"
  budget for Buy if users ask.

Custody stays in the user's Base Account throughout (T1) and moves to their own
sub‑account for popup‑less (T2) — **never to a third party.**

## 9. Phased roadmap

| Phase | Ships | Tier | New build |
| --- | --- | --- | --- |
| **0 (done)** | prepare‑collect/buy/list, discover, manifest, skill; 1‑tap buy | T0 | — |
| **1** | serve skill + host; **batch collect**; **Propose** baskets | T0.5 | `prepare-collect-batch`, serving, host const |
| **2** | **Scouts**: budget + policy + ledger + auto/propose | T1 | `@base-org/account`, `/api/agent/budget`, operator executor, policy store, dashboard |
| **3** | **x402 curated** discovery; taste/social ranking | — | `tier=curated` + facilitator + ranking |
| **4** | **Autopilot** (sub‑account); **Dealer** (sell automation) | T2 | Sub Account SDK pass; auto‑list rules |

## 10. Decisions to confirm

1. **Centerpiece:** agree Scouts (budgeted auto‑collect) is the headline, with
   Co‑pilot + Propose as the now‑shippable base?
2. **Propose‑first:** ship Propose (one‑tap baskets, no budget) before wiring Spend
   Permissions — fastest path to the "agent collects for me" feeling?
3. **v1 autonomy custody:** Scout via **Kismet‑spender** (simplest) or wait for
   **Sub Account** (trust‑minimized) — i.e., is some operator trust acceptable for v1?
4. **Budget currency:** USDC‑only first?
5. **Flagship surface:** invest first in the **Base App mini‑app**, the external
   connectors, or a **Kismet‑native co‑pilot**?
6. **Policy controls** for Scouts v1: which are must‑have (collections, creators, max
   price, daily count, media type)?
