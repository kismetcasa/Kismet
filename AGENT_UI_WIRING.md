# Agent UI wiring — the smoothest way to surface collect / buy / list + the collecting account

> A UX review of how to wire the agent features into Kismet's existing UI, grounded
> in the real components (`MomentCard`, `CollectAllAction`, `ProfileView`,
> `MintForm`, `MarketCard`/`BuyButton`, `ListButton`, `Nav`, `NotificationFeed`).
> Scoped per current priorities: **collect / buy / list** (no mint), **Base App /
> Base Account** audience.

## Principles

1. **Progressive — nothing changes for the default user.** Per-action collect/buy/
   list stay exactly as they are (one tap). The collecting account is an *opt-in
   upgrade*, never a gate.
2. **Just-in-time activation.** Introduce the collecting account at the moment its
   value is obvious — **while collecting** — not before, and not on unrelated screens.
3. **Base Account-gated (#2).** The collecting account needs a smart wallet. Only
   surface it to Base Account / Coinbase Smart Wallet users (detect via the
   connector / `isCoinbaseWebView`). EOAs keep per-action collect with, at most, a
   soft "better in the Base App" note.
4. **Reuse, don't fork.** Enhance the components that already own these actions.
5. **Seamless continuity.** Popup-less/auto-collected moments must appear in the
   user's normal **Collected** section → mint to the **main collection** (see §5).

## EOA guardrails (no regression)

The collecting account is a smart-wallet-only upgrade, so the per-action path must
stay intact for EOAs. Non-negotiable rules when we build the UI:

1. **The default collect/buy/list path is unchanged for EOAs** — never gate an
   existing action behind a collecting account, and never add a required step to it.
2. **Smart-wallet features are conditionally rendered** — feature-detect the wallet
   (connector / `isCoinbaseWebView`); only show the collecting-account UI when the
   account is smart-wallet-capable.
3. **EOAs get a soft nudge, not a wall** — e.g. "tap-free, budgeted collecting is
   available with a Base Account / in the Base App," with the normal collect button
   still right there.
4. **Shared improvements ship to everyone** — wins that don't need a smart wallet
   (e.g. the 1-tap buy, `AGENT_EOA_IMPROVEMENTS.md` B) apply to EOAs too, so the gap
   narrows from both ends.
5. **No security regression for the gap** — we do **not** weaken EOA flows to close
   the gap (e.g. no max-approve; see `AGENT_EOA_IMPROVEMENTS.md` A).

## The setup-entry question, answered

**Profile button: yes. Post-mint prompt: no. Best contextual trigger: at collect.**

- **Why not post-mint:** minting is a **creator** action — `MintForm`'s done screen
  ("Moment minted · Share to /kismet · View moment") is a *creator* celebrating
  what they made. The collecting account is a **collector** feature (auto-collect
  *others'* work). Prompting it there is an intent mismatch and clutters a
  celebratory moment. (A *separate*, lighter creator angle — "your collectors can
  auto-collect your drops" — is a growth message, not a setup prompt, and doesn't
  belong on the done screen.)
- **Why the profile:** `ProfileView` already has the owner-only, customizable
  surface (sections + edit mode + payments/airdrops panels). It's the natural
  **persistent home** to create/customize/manage the budget, see the ledger, and
  pause/revoke.
- **Why collect is the real trigger:** the value ("skip the per-collect taps") is
  only legible *while collecting*. So the **activation** prompt lives at the first
  collect and on "collect all"/baskets.

**So "both" = profile home (manage) + collect-context offer (activate).** Not
post-mint.

## Feature-by-feature wiring

| Feature | Today | Component(s) | Best presentation |
| --- | --- | --- | --- |
| **Collect (per-action)** | 1 tap per card | `MomentCard` (`useDirectCollect`), `MomentDetailView` | Unchanged default. When a collecting account is active, the *same* button runs **popup-less**; tiny "tap-free" hint. |
| **Collect all / basket** | "collect all (N)" | `CollectAllAction`, `useCollectAll` | The **primary activation point**: active → popup-less batch via the sub-account; not set up → runs as today, then a one-time offer. |
| **Propose (agent picks)** | — | `DiscoverPage`, `FeaturedFeed` | A "Collect picks" affordance: a curated/agent set → one popup-less batch (or one approval if not set up). |
| **Buy (secondary)** | 1 tap | `MarketCard`/`BuyButton`, `MomentDetailView` | **Unchanged** — deliberate, per-action. (Assistant can do "buy the cheapest" via discover; no UI change needed.) |
| **List** | sign | `ListButton` | **Unchanged** — deliberate sign. |
| **Collecting account (sub-account + budget)** | — | **new** owner panel in `ProfileView` + a setup sheet | Profile home (create/customize/budget/ledger/pause/revoke) + collect-context setup sheet. |
| **Scouts (unattended, later)** | — | same profile panel | "Standing scouts" with a policy; activity in notifications. |
| **External AI assistant (Base MCP)** | the skill | a settings card (secondary) | "Connect your AI assistant" — the `mcp.base.org` + skill link for power users. |
| **Auto/scout activity** | — | `NotificationFeed`/`Bell` | "Your collecting account collected 3 (−$7)"; budget-low; paused. |

## The collecting-account surface (profile panel)

An owner-only, Base-Account-gated section in `ProfileView` (sits with the existing
sections/edit affordances). States:

- **Not set up (Base Account user):** *"Set up a collecting account — approve once,
  then collect tap-free up to a budget you set."* → **[Set up]** = one approval
  (create sub-account + USDC budget) via `useCollectingAccount`.
- **Active:** budget remaining this period (`getPermissionStatus.remainingSpend`),
  next reset, **[Adjust] [Pause] [Revoke]**, and a **collect ledger** (recent
  tap-free/auto collects). Later: a **Scouts** sub-panel (policy: collections/
  creators/max price/items per period).
- **EOA / non-smart-wallet:** hidden, or a soft "Available with a Base Account / in
  the Base App" line.

## Collect-context activation (the smooth trigger)

- After a user's **first successful collect**, or when they tap **"collect all"**,
  show a **one-time, dismissible inline offer** (never a blocking modal):
  *"Collecting a lot? Approve once and collect tap-free, up to a budget you set.
  [Set up]"*.
- On **"collect all"**: active account → popup-less batch; otherwise run exactly as
  today and surface the offer afterward.
- Reuse one `CollectingAccountSetupSheet` for both the profile **[Set up]** and this
  offer, so there's a single setup flow.

## Seamless continuity — recipient = main collection

For tap-free/auto collects to appear in the user's existing **Collected** profile
section (no siloed surprise), mint to the **universal/main account**
(`mintTo = universal`), not the sub-account. This reverses the v1 simplification and
needs the prepare endpoints to separate **sender/allowance** (sub-account) from
**recipient** (`mintTo`). Worth it — continuity is the difference between "magic"
and "where did my moments go?".

## End-to-end (Base App)

1. In the Base App, tap **collect** on a moment → one approval (or tap-free if set up).
2. After the first collect, a subtle inline offer → **Set up** → one Base Account
   approval (collecting account + e.g. $20/week USDC).
3. Every collect and **collect all** is now **tap-free** within the budget.
4. **Profile → Collecting account:** "$13 left this week", ledger, Adjust/Pause/Revoke.
5. *(Later)* flip on a **Scout** ("photography under $3, 5/day"); `NotificationFeed`
   reports what it collected.

## Concrete component changes (when we build)

- **New** `CollectingAccountPanel` (profile, owner-only, Base-Account-gated) — wraps
  `useCollectingAccount` (`connect` / `setBudgetAllowance` / status / `revoke`).
- **New** `CollectingAccountSetupSheet` — the one-approval setup, reused by the panel
  and the collect-context offer.
- **Enhance** `CollectAllAction` — budget-aware: popup-less batch when active
  (`collectInSession`), one-time offer after a non-setup use.
- **Enhance** `MomentCard` / `MomentDetailView` collect — popup-less when active;
  "tap-free" hint; first-collect offer.
- **Enhance** `ProfileView` — add the owner-only Collecting account section.
- **Enhance** `NotificationFeed` / `Bell` — scout/auto-collect activity types.
- **Optional** "Connect your AI assistant" card (profile/settings) — external Base
  MCP path, secondary per #2.
- **Gate** all new UI on smart-wallet/Base Account detection (reuse
  `lib/miniAppEnv` / the connector).
- **Leave** `BuyButton`, `ListButton`, `MintForm` unchanged.

## Phasing

1. **Collecting account panel + setup sheet** (Mode A: create + budget) → popup-less
   collect in `CollectAllAction` + `MomentCard`. *(Do the live wallet smoke test
   first — `AGENT_SUBACCOUNT_DESIGN.md` §8.)*
2. **Collect-context one-time offer.**
3. **`mintTo = main collection`** endpoint split (continuity).
4. **Scouts (Mode B)** + notification types.
5. **External assistant connect** card.

## Decisions to confirm

1. **Setup entry:** agree on **profile home + collect-context offer**, and **no
   post-mint prompt** (creator vs collector intent)?
2. **Recipient = main collection** (do the sender/recipient split) so tap-free
   collects show in the user's Collected section?
3. **Gating:** collecting account is **Base Account / smart-wallet only — required**
   (EOAs cannot own sub-accounts or grant Spend Permissions; verified — see
   `AGENT_ACCOUNTING_AND_ELIGIBILITY.md`). EOAs stay per-action with a soft note.
4. **Naming:** "Collecting account" vs "Auto-collect" vs "Kismet wallet" — pick the
   copy.
