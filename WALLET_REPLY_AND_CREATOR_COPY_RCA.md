# Wallet replies that never arrive, and the missing artist copy — RCA (2026-10-24)

Reported by frankiestyles (Telegram, 2026-10-21 → 23), minting and airdropping
from **Zen** (Firefox-based) on desktop with the **Rainbow** extension; the same
artist on Safari (Rainbow mobile over WalletConnect) succeeded.

| # | Symptom | Root cause | Fixed by |
|---|---------|------------|----------|
| 1 | Mint: "Free signature" approved in the wallet, toast stays on "Confirm in wallet…" (twice, 10–15 min each) | Rainbow sends the reply to the wrong tab | `lib/walletPrompt.ts` focus gate, every prompt via `hooks/useWallet.ts` |
| 2 | Airdrop: approved, **landed on-chain**, form stays on "Confirm airdrop in wallet…" | The reply never reached the page (same class as 1; exact trigger not reproduced) | `lib/airdropLanded.ts`: the airdrop is confirmed from its on-chain mint |
| 3 | "Mint a copy to myself" on, edition of 22 (`0x3618…c472/2`, "unholy coast"): no copy | In Process's relay drops the copy whenever a supply is set | `lib/creatorCopy.ts` + `hooks/useCreatorCopy.ts`: Kismet sends it from the artist's wallet |
| 3b | Same rule makes every Kismet **1/1** a free public mint of its single edition (price forced to 0, copy dropped) | as 3 | 1/1s are created with their sale closed (`ONE_OF_ONE_SALE`) |
| 3c | A 1/1 whose currency was left on USDC fails at the relay | Zora's ERC20Minter refuses price 0 (`PricePerTokenTooLow`) | `ONE_OF_ONE_SALE` is fixed-price ETH |

## 1 — Rainbow routes replies by focus, not by sender

rainbow-me/browser-extension v1.6.13, `src/core/messengers/internal/tab.ts`: when
a provider request reaches the background, it looks up
`tabs.query({ active: true, lastFocusedWindow: true })` and later sends the
reply to **that** tab — `sender.tab`, the tab that asked, is ignored. If the
looked-up tab is not an http page (the focused window is Rainbow's own popup),
it falls back to a cached tab, or to none. Pending requests are also keyed by
the page's request id, a per-page counter starting at 0 shared by every tab.

Kismet's mint asks for the intent signature **on its own** when a
minutes-long upload finishes. If the artist is looking at another tab then,
the reply goes there and the page waits forever.

Executed, not just read: Rainbow's real messenger and pending-request store,
bundled from source and run in isolated contexts over a simulated
WebExtension bus (scratch harness, not committed). Results: Kismet active →
reply arrives; another tab active → reply delivered to that tab, Kismet
pending forever; focused window not an http tab → reply lost; two tabs both
at id 0 → approving one resolves both with the same payload; Kismet's guard
in front of case 2 → request held until the tab is focused, reply arrives.

**What Frankie remembers (2026-10-24).** The failing Zen mint went
"straight to the free signature", with no uploading or Arweave step: the
resume path (a second attempt with the same file in the same browser reuses
the upload, `lib/arweave/uploadPersistence`). That puts the signature at most
~25 s (`MINT_MEDIA_VERIFY_BUDGET_MS`) after the click, so "another tab was
active" is the less likely trigger for that attempt. The case that fits is
the one where the focused window is not a web tab: `ensureSession` opens a
Rainbow window for its sign-in signature first, and if that window still
has focus — or Rainbow's background restarted and lost its cached tab —
when the intent request arrives, the reply goes nowhere (harness case 3).
The focus gate covers that case too: while Rainbow's window has focus,
`document.hasFocus()` is false and the request waits for the page. Each
stall is now reported (`[client-error] wallet_stall`: connector, whether the
page waited for focus, focus at send and now), so the next occurrence names
its trigger.

**Fix.** Every wallet prompt goes through `hooks/useWallet.ts` (eslint
`no-restricted-imports` bans wagmi's prompt hooks elsewhere):

- *Focus gate* — for extension (injected) connectors, the request is sent
  only while this page is visible and focused, so this tab is the active tab
  of the focused window when the extension receives it. A click passes at
  once; a request raised in the background waits for the artist to return.
  Not applied to WalletConnect (relay to this page's socket), Base Account
  (popup answers its opener), the Farcaster host or Coinbase WebViews.
- *Stall notice* — after 60 s without a reply, say so. A signature can be
  asked again (no on-chain effect; first answer wins). A transaction never is
  — the notice says to check the wallet's activity first.

`scripts/verify-wallet-prompt.ts` runs the guard against a scripted page.

## 2 — the airdrop

The airdrop is raised by a click, so the gate alone doesn't explain it; the
exact trigger (a split view, Glance, Rainbow's popup still focused, its
background restarting mid-approval) could not be reproduced without Zen.
Whatever loses the reply, the mint is public: each recipient's `adminMint`
emits `TransferSingle(operator = sender, from = 0x0, to, id)`. `useAirdrop`
reads the head before asking the wallet and races the reply against those
logs; whichever comes first gives the tx hash, which `notifyAirdrop` needs.
`scripts/verify-airdrop-landed.ts`.

## 3 — the artist copy

`in_process_api` `src/lib/moment/createTokenParam.ts`:

```ts
mintToCreatorCount: token.maxSupply === undefined ? token.mintToCreatorCount : 0,
```

The copy (an `adminMint` to `account`) only survives for open editions. The
In Process airdrop endpoint can't stand in for it: it authenticates by API
key, so under Kismet's shared key it acts as Kismet's account, not the
artist's (also why `useAirdrop` bypasses it). Zora's `reduceSupply` is
callable only by the timed-sale strategy, so "mint open, cap later" is out.

**Fix.** For a limited edition with the toggle on, MintForm checks before
any upload that the artist's wallet holds ADMIN or MINTER on the collection
(the artist is `defaultAdmin` of their own collections and of the ones In
Process deploys), and after the relay mint reads the artist's balance —
nothing is sent if they already hold one, so this stops by itself if In
Process changes the rule — then sends `adminMint(artist, tokenId, 1)` from
the artist's wallet. A refusal or revert leaves the artwork minted and says
how to send the copy later (Mint → Airdrop, own address).

A 1/1 is created with `ONE_OF_ONE_SALE` (fixed-price ETH, `saleEnd = 1`): no
one can take the single edition while the copy is on its way. `getSaleWindow`
shows no "Ended Jan 1, 1970" for that marker; collect gating still reads it
closed, and once the copy lands the page shows "sold out". The agent
`prepare-mint` summary no longer promises a copy for a limited edition.
`scripts/verify-creator-copy.ts`.

**Upstream.** The one-line change in In Process (keep `mintToCreatorCount`
when `maxSupply` is set) would make the copy atomic with the mint and free;
Kismet's balance check makes that change safe to ship at any time.

**Existing affected artworks** (limited editions minted with the toggle on,
and 1/1s): the artist can send the copy from Mint → Airdrop to their own
address. 1/1s minted before this fix still have an open free sale of their
single edition until someone, or the artist, takes it.

## Not covered here

"unholy coast" also shows **no preview** on its artwork page. That is a
different path (metadata → gateways → renderer) and needs the token's live
metadata to diagnose; it was not reachable from the environment this RCA
was written in.
