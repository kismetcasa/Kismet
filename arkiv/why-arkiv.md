# Why Arkiv

Kismet's only database is an Upstash Redis instance
([STACK_OVERVIEW.md](../STACK_OVERVIEW.md)). Claim drops could have been a
Redis set per drop. Here is what users would lose if they were.

## If claims lived in Kismet's database instead

1. **Collectors would hold nothing.** A claim would be a row only Kismet can
   see. On Arkiv it is an entity **the collector owns**, carrying the
   collector's own EIP-712 signature, created by Kismet's writer (so
   `$creator` attests Kismet admitted it). A collector can show it to anyone,
   and hand it to another wallet before the drop is delivered, without asking us.
2. **The airdrop would be Kismet's word.** The delivery's recipient list is
   read from Arkiv, and so can anyone's: the airdrop on Base — named in the
   drop's settlement entity — can be checked against the public claim set. In
   Redis we could add or drop a name with one command and nobody could tell.
3. **The terms could move.** A drop entity is `readonly`: its cap, close time
   and artwork cannot change after people claim — not even by Kismet. In
   Redis, changing them is one admin write.
4. **Other apps couldn't build on it.** `kismet.drop.v1` is a public,
   queryable feed. A Farcaster frame, a wallet, or an AI agent (Kismet already
   publishes an agent skill — [`public/agent-skill`](../public/agent-skill/SKILL.md))
   can list open drops and their claims straight from Arkiv, with no Kismet
   API key, rate limit or permission.
5. **Cleanup would be ours.** Kismet keeps hand-trimmed Redis indexes for
   things that end (the `kismetart:sale-ends` zset behind "ending soon"). Drop
   and claim entities expire when they stop being useful; the feed is a query.

## What we kept off Arkiv, and why

| Kept off Arkiv | Where | Why |
|---|---|---|
| The NFT, the airdrop, any money | **Base** | It has to be permanent, show in wallets and trade on marketplaces. The airdrop is Zora `adminMint`, which carries no protocol fee. |
| The artwork while the drop is open | **Swarm** | Images run up to 15 MB; an Arkiv `bytes` attribute holds 128 KiB. Swarm rents storage for a period, which matches a drop's life. |
| The artwork once claimed | **Arweave** (existing mint flow) | Minted art must be permanent. Paying for that only after a drop is claimed is the cost saving. |
| The claim cap and one-claim-per-wallet | **Redis** (atomic Lua) | Arkiv has no conditional write: two claims racing for the last slot would both land. Redis decides; Arkiv records the outcome publicly. |
| Sessions, signature nonces, quotas, rate limits, blocklists | **Redis** | Private, high-churn, useful to nobody else. |
| Who uploaded which Swarm file (2 days) | **Redis** | Only our "open a drop" check needs it. |

## What the user pays, side by side

On a free edition, Zora's protocol fee is the collector's entire price.

| | Free mint on Kismet today | Claim drop |
|---|---|---|
| Collector pays | 0.000111 ETH per edition (≈ $0.30 at the $2,688 ETH of 6 Nov 2026) + Base gas, and needs ETH on Base | **Nothing** — one signature, no ETH needed |
| Collector receives | An ERC-1155 on Base | The same ERC-1155 on Base, by airdrop |
| Artist pays | Nothing (Kismet sponsors the mint) | Nothing to open or mint; the airdrop's Base gas at delivery (≈ $0.001–0.01 per recipient, [`hooks/useAirdrop.ts`](../hooks/useAirdrop.ts)) |
| Kismet pays | Arweave storage (~$32.56/GiB) for every artwork, sold or not | A share of one Swarm batch while the drop is open; Arweave only for drops that got claimed; Arkiv writes (faucet tGLM on testnet; on mainnet GLM, and "a shorter lifetime costs less") |
| Gives up | — | Zora's free-mint rewards (the artist's creator reward and Kismet's referral) on these editions — the artist chooses per drop |
