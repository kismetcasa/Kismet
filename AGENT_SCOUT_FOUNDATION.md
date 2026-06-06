# Scout Foundation — budgeted auto-collect, built for scale

> Status: **FOUNDATION SHIPPED (engine + batch), executor pending infra.** This is
> the V2 ("Scout") base from `AGENT_EXPERIENCE_DESIGN.md`, built so the on-chain
> executor + UI plug in without reworking the core. Pure logic is executed in CI
> (`npm run verify:agent`); on-chain pieces are isolated behind an interface.

## Why this shape

The risky, untestable parts of budgeted autonomy (operator key, paymaster,
`SpendPermissionManager.spend()`, the live mint) are **decisions + infra**, not
logic. The parts that must be *exactly right* — budget accounting that mirrors
the on-chain period cap, and the "what to collect" policy — are **pure logic**.
So we built and **exhaustively tested the pure core now**, and put the on-chain
execution behind a swappable seam. That's the strongest foundation: correctness
locked in, custody/runtime deferred without rework.

## What's shipped (tested)

| Piece | File | Tested by |
| --- | --- | --- |
| **Scout engine** — budget accounting + policy decisions + run planning | `lib/agent/scout/engine.ts` | `scripts/verify-agent-scout.ts` (runs the **real** engine via Node type-stripping — 30 assertions) |
| **Executor seam** — custody-agnostic interface | `lib/agent/scout/executor.ts` | typecheck |
| **Batch collect** — N mints in one approval (Propose / Co-pilot) | `lib/agent/collectBatch.ts`, `app/api/agent/prepare-collect-batch` | `scripts/verify-agent-collect-batch.mjs` (viem oracle) |

`npm run verify:agent` runs every agent verifier (collect/buy/list/batch calldata
oracles, the skill consistency check, and the executing scout-engine test) and is
wired into `npm run check`.

## The engine (the core)

Pure, **zero imports** (native BigInt) → unit-testable and identical for Propose
and Auto. It owns:

- **Budget accounting** mirroring `SpendPermissionManager`: `periodStartFor` aligns
  to `start + k·period`; `rollUsage` resets cumulative spend + item count at each
  period boundary; `remainingAllowance` never exceeds what the on-chain cap allows
  — so we never plan a spend that would revert.
- **Policy decisions** (`evaluateCandidate`): ordered gates — paused → permission
  window → currency → collection/creator allow+block → media type → already-collected
  → per-item price → per-period item cap → remaining budget — each with an explicit
  `SkipReason`.
- **Run planning** (`planRun`): greedily accepts an ordered candidate list,
  accumulating spend + count so the per-period **dollar** and **item** caps hold
  across the whole basket; dedupes within the run; returns `toCollect`,
  `projectedSpend`, and the `endUsage` to persist.

**Two-layer safety:** the Spend Permission caps *dollars* on-chain; the engine's
policy caps *what* (Spend Permissions can't restrict which contract is called). Both
are user-set; the engine is the single source of truth for the "what."

## The executor seam (custody-agnostic)

`ScoutExecutor.collect(scout, candidate) → { txHash }` is the **only** place keys /
paymaster / on-chain spend touch the flow. Two implementations drop in unchanged:

- **KismetSpenderExecutor (v1):** Kismet operator is the permission `spender`; per
  collect it `spend()`s the price from the user's Base Account, then mints with
  `mintTo = scout.owner`. Simplest; operator trusted within the on-chain cap.
- **SubAccountExecutor (v2):** runs under the user's own app sub-account (session
  key + Auto Spend Permissions), popup-less, minimal third-party trust.

Either way: reuse the `prepare-collect` builders (builder code + Zora referral
preserved) and record via the existing `/api/collect`.

## What's next (infra + decisions, not core logic)

1. **Grant flow** — add `@base-org/account`; `/api/agent/budget` (grant via
   `requestSpendPermission`, `status` via `getPermissionStatus`/`fetchPermissions`,
   `revoke`). One signature sets the budget.
2. **Scout store** — persist Scouts + `BudgetUsage` + a collect ledger (Redis,
   following `lib/listings.ts` patterns): keys per owner, indexed for the dashboard.
3. **Executor impl** — `KismetSpenderExecutor` (operator key + paymaster) behind the
   seam; wire `planRun → executor.collect → /api/collect`, persisting `endUsage`.
4. **Discovery feed** — candidates from `/api/agent/discover` (free now; x402 curated
   next) → `planRun`. Propose mode surfaces `toCollect` for one-tap (batch endpoint,
   shipped); Auto mode executes it.
5. **Dashboard** — remaining budget, ledger, pause/revoke.

### Open decisions (gate the executor, not the engine)

- v1 custody: KismetSpender vs SubAccount.
- Budget currency: USDC-only first?
- Gas: paymaster vs charge-to-budget.
- Verify the `SpendPermissionManager` address + `@base-org/account` signatures
  against live docs before wiring (see `AGENT_BUDGET_DESIGN.md`).
