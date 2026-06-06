# Agent UX & Wiring — Base MCP + Kismet

> Status: **RESEARCH / UNDERSTANDING** (no Mint/discovery build yet). Two parts:
> (1) how to wire Kismet to Base MCP *correctly*, grounded in the canonical
> `base/skills` repo; (2) the end-to-end user experience for Collect / Buy / List,
> with the friction points and the decisions they surface.
>
> Companion to `AGENT_COMMERCE_DESIGN.md` (architecture) and `agent-skill/`
> (the skill we ship).

---

## Part 1 — How to wire (canonical Base facts)

Sourced from `github.com/base/skills` (branch `master`, `skills/base-mcp/`) — the
source the Base docs point to. `docs.base.org` blocks automated fetch; the raw
repo does not.

### 1.1 `send_calls` is the execution contract

From `references/batch-calls.md`:

- Call shape: `calls: [{ to, value, data }]`
  - `to` — target address, `0x…`, **required**
  - `value` — **hex-encoded wei** (e.g. `"0x0"`), optional
  - `data` — calldata hex, optional
- **`chain` is a top-level parameter**, not per-call. Strings only:
  `base | base-sepolia | ethereum | optimism | polygon | arbitrum | bsc | avalanche`.
- The call the agent makes: `send_calls({ chain: "base", calls: [...] })`.
- Multiple calls (e.g. `approve` + action) collapse into **one** user approval.
- **No `chainId`, capabilities, or builder field** is exposed on `send_calls`.

> **Wiring correction we applied:** our prepare envelopes emitted `value` as a
> decimal string. The contract is **hex wei**. Fixed — `AgentCall.value` is now
> `0x…` and the oracles assert it. Because there's no capabilities passthrough,
> appending our ERC-8021 builder suffix to **calldata** (not as a capability) is
> the correct and only way to keep attribution.

### 1.2 Approval mode

From `references/approval-mode.md`:

- Write tools (`send`, `swap`, `sign`, `send_calls`, plugin txs) return
  `{ approvalUrl, requestId }`.
- Required sequence: **present the link** ("Approve Transaction", neutral) →
  **wait** for the user → **poll `get_request_status` exactly once** → report
  success **only after** confirmation. Never claim success early.
- Call the destination **"Base Account"** (not a hostname/provider).
- CLI hosts (Claude Code, Cursor): auto-open the URL *and* print it. Chat hosts
  (ChatGPT): just present it.

### 1.3 SKILL onboarding & loading

From `SKILL.md`:

- **Onboarding once per conversation:** (1) one–two sentence capability mention;
  (2) **mandatory verbatim disclaimer** — *"By using the Base MCP, you agree to
  the Base Account and Base App Terms of Service. Plugins available in the Base
  repo are authored by Base, not by the third-party protocols they reference."*;
  (3) fetch address/balance only when an op needs it.
- **Detection:** if no Base MCP tools are callable, the server isn't installed →
  point to the quickstart.
- **Local-first, lazy:** read `references/` and `plugins/` from the skill dir;
  fall back to `web_request` against `https://docs.base.org/ai-agents/skills/`
  only if local fails. Load a file only when the task needs it (progressive
  disclosure; `SKILL.md` stays ~100 lines).

### 1.4 The plugin model (how a protocol extends the skill)

From the Overview + `plugins/morpho.md`. A plugin is **one markdown file** with
four sections:

1. **Onboarding gate** — a `STOP`: "complete Base MCP onboarding in `SKILL.md`
   before calling any of this plugin's tools."
2. **Read** — GET endpoints / CLI / read tools returning state.
3. **Prepare** — endpoints that return **unsigned calldata**, with the exact
   response shape so the model knows which fields are `to` / `value` / `data`.
4. **`send_calls` mapping** — turn the prepare response into
   `{ "chain": "base", "calls": [{ "to", "value", "data" }] }`.

Safety constraints every plugin restates: no private keys/local signers; all
signing via Base MCP; chain as a **string** (`base`), not a numeric id; verify
addresses + amounts before presenting the approval.

### 1.5 The allowlist constraint (important)

`references/custom-plugins.md` is really about Base MCP's **`web_request` host
allowlist** (Aerodrome, Avantis, Morpho, …). Key line: *custom / user-supplied
plugins are almost certainly **not** in the allowlist.*

**Implication for Kismet:** the agent cannot assume Base MCP's `web_request` can
reach `*.kismet…`. So our model must be: **the assistant calls Kismet's
`/api/agent/*` endpoints with its own HTTP capability** (Claude/ChatGPT browsing,
Cursor/Claude Code shell `curl`, etc.) and uses **Base MCP only for
`send_calls` / `sign`**. This is already how our skill reads — but we should say
it explicitly, and note that getting Kismet onto Base's allowlist is a separate,
later ask to the Base team (not required for the agent's own-HTTP path).

### 1.6 Packaging decision: custom plugin vs standalone skill

We currently ship a **standalone skill** (`agent-skill/SKILL.md` + `references/`).
That works, but the *idiomatic* wiring per Base is a **custom plugin** — one
`plugins/kismet.md` that layers on the installed `base-mcp` skill and inherits its
onboarding / approval / tone. Trade-offs:

| | Standalone skill (today) | Custom plugin `plugins/kismet.md` (canonical) |
| --- | --- | --- |
| Onboarding/approval/tone | Re-implements them | **Inherits** from base-mcp |
| Install | Its own skill | Dropped alongside base-mcp |
| Footprint | Larger (duplicate rules) | One four-section file |
| Best when | User has *only* the wallet tools | User has the base-mcp skill (the common case) |

**Recommendation:** ship **both**, but make the custom plugin the primary: add
`agent-skill/plugins/kismet.md` in the four-section shape, and slim the standalone
`SKILL.md` to defer onboarding/approval to base-mcp when present. Concretely, to
align with canon we should:

- [ ] Add the **verbatim ToS disclaimer** + a one-line capability mention to our
      onboarding (or defer to base-mcp's).
- [ ] State the **approval loop** in our terms: present "Approve Transaction" →
      wait → poll `get_request_status` **once** → success only after confirm;
      name it **"Base Account"**.
- [x] **`value` as hex wei** in `send_calls` (done).
- [ ] Add a **`plugins/kismet.md`** four-section file (gate → read `discover`/
      `manifest` → prepare `prepare-collect|buy|list` with response shapes →
      `send_calls` mapping).
- [ ] **Serve** the skill + manifest (see 1.7) and **hardcode the Kismet host**
      so the agent doesn't have to ask for it.

### 1.7 Serving + install (the missing "wire")

Two gaps stop an external agent from actually using this today:

1. **The skill/manifest must be fetchable over HTTP.** `agent-skill/` is repo
   source, not served; the manifest links to `BASE/agent-skill/SKILL.md` and
   `BASE/AGENT_COMMERCE_DESIGN.md`, which 404. Fix: serve them (move to `public/`
   or add a tiny route), or publish to a `base/skills`-style repo for
   `npx skills add`.
2. **The agent needs Kismet's origin.** Today the skill says "ask the user."
   Better: hardcode the production host (e.g. from `NEXT_PUBLIC_SITE_URL`) in the
   skill/plugin and the manifest, so `discover`/`prepare-*` URLs are absolute.

Install paths (from the quickstart) once served: Claude (`mcp.base.org` connector
+ skill upload or paste-the-URL), ChatGPT (Connector + skill), Cursor/Claude Code
(`claude mcp add … https://mcp.base.org`, `npx skills add …`).

---

## Part 2 — End-to-end user experience

### 2.1 Runtimes (where the user is)

| Runtime | Wallet | Approval surface | Notes |
| --- | --- | --- | --- |
| **Base App** assistant | the app's Base Account | **in-app**, no context switch | Flagship — smoothest. The Base App *is* the Base Account. |
| Claude / ChatGPT (web/desktop/mobile) | Base Account via `mcp.base.org` | opens Base Account to approve | Agent uses its own browsing to hit Kismet endpoints. |
| Cursor / Claude Code (CLI) | Base Account via `mcp.base.org` | auto-opens the approval URL | Uses shell `curl` for Kismet endpoints. |
| Kismet mini-app **inside** Base App | same Base Account | in-app | The mini-app and the assistant share one wallet; the assistant can act on what the user is viewing. |

The `/api/agent/*` endpoints are identical across all of these — only *who calls
them* and *where the approval renders* differ.

### 2.2 Cold start (once)

1. Connect Base MCP (`https://mcp.base.org`). First wallet-tool use shows a Base
   Account consent: *"Allow <client> to access your account"* → **view address/
   balances** + **prepare transactions for you to review**. One tap.
2. Install/point at the Kismet skill (or plugin). The assistant shows the **ToS
   disclaimer** once.
3. The assistant calls **`get_wallets`** → the user's Base Account address. That
   address is `account`/`seller`/`mintTo` for everything after.

### 2.3 Walkthroughs

Legibility note: "approval" = a Base Account tx confirmation; "signature" = a
message/typed-data signature. Both are taps in Base Account.

#### Collect — *"Collect the latest moment in 0xabc… for me"* — **1 approval**

1. Agent `get_wallets` → `account`.
2. (optional) `GET /api/agent/discover?kind=collect&collection=0xabc…&account=…`
   → a row with a `nextAction`.
3. Agent `POST /api/agent/prepare-collect { collection, tokenId, account }`.
   Server reads the live sale on-chain → ETH or USDC, the price, eligibility.
4. Agent shows: *"Collect 1× ‘Sunset #3’ for $5.00 (+ ~$0.00 fee)."*
5. Agent `send_calls({ chain:"base", calls })`. USDC's `approve`+`mint` are
   **one** approval. → `approvalUrl` → user taps **Approve** in Base Account →
   agent polls `get_request_status` once → confirmed (txHash).
6. Agent `POST /api/collect { …, txHash }` (on-chain-verified, idempotent).
7. *"Collected — it's in your Base Account."*

#### Buy — *"Buy the cheapest listing of token 7 in 0xabc…"* — **1 approval**

1. `get_wallets` → `account`.
2. `GET /api/agent/discover?kind=listings&collection=0xabc…&account=…` → pick the
   row whose `tokenId` is 7 → `listingId`.
3. `POST /api/agent/prepare-buy { listingId, account }`.
4. *"Buy ‘Title’ from 0x71Dc…7244 for 0.01 ETH."*
5. `send_calls` → **Approve** → confirmed (txHash).
6. **Mark filled** (no signature): `PATCH /api/listings/{id} { status:"filled", txHash }`.
   The backend re-decodes `OrderFulfilled` from the txHash (matched to this
   listing's order) and derives the buyer from it.
7. *"Purchased."*

> **Resolved:** the "mark filled" PATCH no longer needs a buyer signature — the
> on-chain receipt is the binding proof and the buyer is read from the event, so
> Buy is a single approval. (The web BuyButton still sends its signature; that
> path is unchanged.)

#### List — *"List my ‘Sunset #3’ for 0.02 ETH"* (paste a URL works) — **2 taps first time, 1 after**

1. `get_wallets` → `account` (must hold the token).
2. `POST /api/agent/prepare-list { url|collection+tokenId, account, price, currency }`.
   Server reads ownership, approval state, royalty, Seaport counter.
3. *"List ‘Sunset #3’ for 0.02 ETH. First listing here → one-time approval, then
   sign."*
4. If first listing on the collection: `send_calls([setApprovalForAll])` →
   **Approve**. (Skipped forever after.)
5. `sign(typedData)` → the Seaport order signature (no funds).
6. `POST /api/listings { …, signature }` (re-validates shape, sig, royalty).
7. *"Listed for 0.02 ETH (30-day expiry)."*

### 2.4 Friction & gaps inventory

| Friction | Where | Mitigation / decision |
| --- | --- | --- |
| Agent doesn't know the Kismet host | every verb | Hardcode the production origin in skill/plugin + manifest (1.7). |
| Skill/manifest not served | install | Serve `agent-skill/` + doc, or publish a skills repo (1.7). |
| ~~Buy needs a 2nd tap (mark-filled)~~ | Buy step 6 | **Resolved** — txHash-only filled; buyer derived from the OrderFulfilled event. |
| List can be 2 taps the first time | List step 4–5 | Inherent (approval + signature); explain it in the summary (done). |
| "Cheapest listing of token 7" | discovery | Free discover returns rows; ranking/filters are basic — the curated x402 tier is the upgrade. |
| Token lands in the **smart wallet** | all | Correct + intended, but tell the user the Base Account is the holder (safety.md covers it). |
| Mint needs media + Creator Pass | Mint (deferred) | Open: hosted-URL vs server upload; Pass-gated audience. |
| Paid discovery = a signature per call | x402 (future) | Tight `maxPayment`; batch/curate so it's occasional, not per-item. |

### 2.5 The flagship happy path (Base App)

A collector in the Base App, browsing Kismet (mini-app), types to the assistant:
*"collect this and list my older one for 0.02 ETH."* The assistant resolves the
wallet, prepares both actions, and shows two summaries. The user taps **Approve**
(collect) and **Sign** (list) — in-app, no app-switch — and both land against the
same Base Account. That's the experience to optimize for; everything in Part 1 is
in service of making those two taps trustworthy and correct.

---

## Open decisions (your call)

1. **Packaging:** reshape into a canonical **`plugins/kismet.md`** custom plugin
   (recommended), keep the standalone skill, or both?
2. **Serving:** where should the skill + manifest live so agents can fetch them —
   `public/` on the Kismet app, or a separate `npx skills`-installable repo?
3. **Kismet host:** confirm the production origin to hardcode into the
   skill/manifest.
4. ~~**Buy 2nd tap**~~ — **Done:** txHash-only "mark filled"; Buy is one approval.
5. **Priority runtime:** optimize first for the **Base App** in-app experience,
   or the external Claude/ChatGPT connector?
6. **List approval scope:** keep the standard collection-wide `setApprovalForAll`
   to Seaport (industry norm, what the web app already does), or add an optional
   auto-revoke for cautious sellers? (See safety note below.)
