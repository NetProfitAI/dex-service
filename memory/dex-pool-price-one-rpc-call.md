---
name: dex-pool-price-one-rpc-call
description: Each DEX adapter's getPoolPrice must fetch price in a single RPC round-trip
metadata:
  type: feedback
---

The user requires each DEX adapter's `getPoolPrice` to read price **directly from the network in as few RPC round-trips as possible** (ideally one), not via SDK helpers that fan out to many accounts.

**Why:** This is the price layer for a latency-sensitive arbitrage bot — extra round-trips per pool kill throughput and hit RPC rate limits (public RPC 429s easily).

**How to apply (measured hot-path cost per price fetch):**
- **Raydium** (`getClmmPrice`/`getCpmmPrice`/`getAmmV4Price`): use single-account fetchers (`clmm.getRpcClmmPoolInfos`, `cpmm.getRpcPoolInfo(id,false)`, `liquidity.getRpcPoolInfo`) — NOT `getPoolInfoFromRpc` (fans out to market+vaults). CPMM/AMM are 2 calls (pool + vault token accounts) because reserves live in separate vault accounts; that's inherent unless vault addresses are pre-stored.
- **Whirlpool**: 1 `getAccountInfo` for the pool; token decimals come from the shared static `BaseDex.decimalCache` (cold = 1 + 2 decimal lookups, warm = 1).
- **Meteora DLMM**: do NOT use `DLMM.create` + `getActiveBin` (4 calls every time). Instead fetch the lbPair account once and decode offline with `createProgram`+`decodeAccount(program,"lbPair",data)`, then `price = getPriceOfBinByBinId(activeId, binStep) * 10^(decimalsX - decimalsY)` (all from `@meteora-ag/dlmm`). Subscriptions decode the pushed `accountInfo.data` directly = 0 extra RPC.

Verify RPC counts with a local counting proxy (transport-agnostic) — web3.js 1.98 calls bypass `Connection._rpcRequest` and capture `fetch` at import, so patching those misses calls. A reusable counter lives at `src/playground/count-rpc.ts`. See [[dex-service-arbitrage-goal]].
