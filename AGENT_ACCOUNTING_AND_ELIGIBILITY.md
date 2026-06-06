# Sub-account accounting & EOA eligibility — verified against Base docs

> Resolves two correctness questions for budgeted collecting, reviewed against the
> current Base docs (Sub Accounts, Spend Permissions, smart-wallet minting) +
> ERC‑7895 + the installed `@base-org/account@2.4.0`. `docs.base.org` blocks
> automated fetch, so claims are triangulated from doc search + the repos/types.

## Q2 — Can EOAs set up sub accounts? **No.**

Sub Accounts are a **Smart Wallet** feature. The architecture is *hierarchical
smart-account ownership*: the **universal account must be a Coinbase Smart Wallet
(Base Account) that OWNS the sub-account** ("the user's universal wallet owns their
app account"; `wallet_addSubAccount` "assumes the account is owned by the universal
wallet"). A plain EOA is not a smart contract account, so it **cannot own a
sub-account, and cannot grant Spend Permissions** (those are granted *by* a smart
wallet — the CDP "create a spend permission" API lives under *evm-smart-accounts*).

Important nuance the docs make explicit:

- The **granter** (the account whose funds are spent / that owns the sub-account)
  **must be a smart wallet**.
- The **spender** (who receives the permission) **can be an EOA *or* a smart
  account**. In our model the spender is the sub-account (a smart account).

So **this whole feature is Base Account / Coinbase Smart Wallet only** — gating on
it is **required, not optional**. EOAs keep per-action collect (one tap each).

> Forward nuance: **ERC‑7702** (2026) lets an EOA be upgraded into a smart wallet;
> an upgraded EOA would then qualify. The practical gate is therefore "is this a
> smart wallet / Base Account?" — which the app already detects
> (`isCoinbaseWebView`, the connector) — not "EOA vs not" in the abstract.

## Q1 — Which accounts are debited and credited? **The user's main account — both.**

With the sub-account as a *popup-less executor*, the accounting is:

| Role | Account | Mechanism |
| --- | --- | --- |
| **Signs** (no popup) | the sub-account | its app/browser key (Mode A) |
| **Debited (funds)** | the **user's universal Base Account** | Auto Spend Permissions: the sub-account spends **directly from the universal account's balance**, auto-pulled per tx, **capped by the Spend Permission**. Confirmed: "when a sub-account has insufficient balance, the parent Base Account is debited." |
| **Credited (the NFT)** | the **user's universal Base Account** | the mint's `mintTo`/`_recipient` set to the **universal** address |
| **Never touched** | Kismet | we hold no key and receive no funds |

The recipient-≠-sender bit is the key correctness point, and it's **documented best
practice**: *"Allowing the recipient to be different than the sender is necessary to
assign the right NFT owner when using a smart contract wallet, paymaster, or account
abstraction"* — i.e. mint with `msg.sender = sub-account` but `mintTo = universal`
so the moment is not "locked in an intermediary account."

Net per collect: the **user's main account loses USDC (≤ the cap) and gains the
moment**; the creator + Kismet referral are paid by the Zora minter exactly as
today; **gas via a paymaster** so there's no ETH debit. The sub-account holds ~0
between txs (it pulls exactly what each mint needs), so the blast radius is the
remaining spend-permission cap.

> This **supersedes the v1 simplification** in `AGENT_SUBACCOUNT_DESIGN.md` §8
> (which used `mintTo = sub-account` to reuse the batch endpoint unchanged). The
> docs confirm `mintTo = universal` is supported and is the correct, seamless
> choice — so we adopt it.

## Best path forward (and why)

1. **Gate the collecting account on Base Account / smart wallet — required.** EOAs
   cannot own sub-accounts or grant Spend Permissions. EOAs get per-action collect
   only (soft "available with a Base Account / in the Base App" note). Detect via
   the connector / `isCoinbaseWebView`. *(7702-upgraded EOAs qualify automatically
   once detected as smart wallets.)*
2. **Accounting: the user's universal account is both debited and credited.** The
   sub-account is a pass-through executor the user owns. Set **`mintTo = universal`**
   so collected moments land in the user's main account/collection (and show in
   their normal Collected profile section). Funds are pulled from the universal
   account within the Spend-Permission cap; **gas via a paymaster** (no ETH debit).
   Kismet is never debited or credited.
3. **Implementation: the sender/recipient split.** The prepare endpoints must
   separate **sender/allowance** (the sub-account — it's `msg.sender`, approves the
   ERC20Minter, and its allowance is what we check) from **recipient** (`mintTo =
   universal`). Add an optional `spender` param to `prepare-collect` /
   `prepare-collect-batch`: when present, read the allowance for `spender` and build
   the `approve` for it, while `mintTo = account` (universal). `inSessionCollect`
   then calls with `account = universal, spender = subAccount`.

**Why this is the right path:** it's non-custodial (Kismet never touches funds),
the accounting is transparent and correct (the user's *own* account pays and
receives, capped on-chain and revocable), it's seamless (moments in the user's main
collection), and it is the **canonical Base Sub Account + Spend Permission +
recipient-≠-sender** pattern — not a workaround.

## What this changes

- `AGENT_UI_WIRING.md` decision 3 (gating): **required**, not preferred — EOAs can't.
- `AGENT_SUBACCOUNT_DESIGN.md` §8 recipient: adopt **`mintTo = universal`** (do the
  sender/recipient split) instead of the v1 sub-account recipient.
- Next build step: the **`spender` param split** on the prepare endpoints +
  `inSessionCollect(account = universal, spender = subAccount)` + a **paymaster** URL.

### Sources
- [Use Sub Accounts](https://docs.base.org/base-account/improve-ux/sub-accounts) ·
  [Sub Accounts concept](https://docs.base.org/identity/smart-wallet/concepts/features/optional/sub-accounts) ·
  [From Session Keys to Sub Accounts](https://blog.base.dev/subaccounts) ·
  [base/sub-account-demo](https://github.com/base/sub-account-demo) · ERC‑7895
- [Use Spend Permissions](https://docs.base.org/base-account/improve-ux/spend-permissions) ·
  [CDP: create a spend permission (evm-smart-accounts)](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/evm-smart-accounts/create-a-spend-permission) ·
  [coinbase/spend-permissions](https://github.com/coinbase/spend-permissions)
- [Signature Mint NFT (recipient ≠ sender)](https://docs.base.org/learn/token-development/nft-guides/signature-mint) ·
  [ERC‑7702 deep dive](https://blog.base.dev/securing-eip-7702-upgrades)
