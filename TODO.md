# TODO — dex-service (Solana cross-DEX arbitrage)

Status of the price/arbitrage layer and the work still ahead. Detection works; this
list is the path from **detector → executor**.

## Done
- [x] Pool sync for all 3 DEXes (`jobs/sync-pools-to-db`) — Raydium, Whirlpool, Meteora.
- [x] Single-RPC `getPoolPrice` per adapter (Meteora decodes the lbPair offline; Whirlpool/Meteora warm = 1 read; Raydium CPMM/AMM = 2 because reserves live in vault accounts).
- [x] Arb **scanner** (`src/playground/arb-scanner.ts`) — picks volume-ranked cross-DEX pairs, polls top pool per DEX, prints opportunities for ~1 min/pair, detection only.
- [x] Rate-limit compliance with constant-k **Operator** plan (account reads ≤5/s, polling instead of WS since WS is capped at 10).
- [x] Pre-warm adapters/decimal cache to avoid cold-start 429 burst.
- [x] Size-aware net % via a conservative constant-product slippage model (`TRADE_USD`).

## Next: executor-stage accuracy
- [ ] **Exact SDK swap quotes behind a mid-price screen.** Keep the cheap mid-price
      poll as tier-1; when gross spread clears a screen threshold, run tier-2 exact
      quotes on just the two candidate pools and report executable net:
  - [ ] Raydium CPMM → `CurveCalculator.swapBaseInput` (reserves + fee rates from `cpmm.getRpcPoolInfo(id, true)`).
  - [ ] Raydium AMM v4 → constant-product from `liquidity.getRpcPoolInfo` reserves.
  - [ ] Raydium CLMM → `PoolUtils.computeAmountOut` (needs tick arrays + epochInfo).
  - [ ] Whirlpool → `swapQuoteByInputToken` from `@orca-so/whirlpools-core` (needs tick arrays).
  - [ ] Meteora DLMM → `dlmm.swapQuote(inAmount, swapForY, slippage, binArrays)` (needs bin arrays via `getBinArrayForSwap`).
  - [ ] Budget the extra tick/bin reads against the 5/s cap (tier-2 fires rarely, so OK).
- [ ] Round-trip simulation: start with `TRADE_USD` of quote token → buy base on cheap
      DEX → sell base on expensive DEX → net = end/start − 1, including both legs.

## Correctness / cleanup
- [ ] **Fee-unit bug** in `src/entries/arbitrage.ts`: fees are stored as fractions but
      the threshold divides by 100 (`(fee1+fee2)/100`) — should be `*100`. Makes the
      one-shot `entries/arbitrage` flag almost every spread. (The scanner already
      handles fees correctly.)
- [ ] Account for **priority/Jito fees** and rent/ATA costs in net profit, not just LP fees.
- [ ] Verify the **real-time subscription** path (`processes/search/realtime.ts` and
      each adapter's `subscribeToPrice`) against a live trade — only `getPoolPrice`
      (one-shot) has been verified so far.

## Detector polish (optional)
- [ ] Make tier-1 screen vs tier-2 quote thresholds configurable.
- [ ] Persist detected opportunities (DB/log) for backtesting which pairs actually pay.
- [ ] Consider ranking pairs by volume/liquidity (turnover) instead of raw volume.

## Out of scope for now
- Transaction building / signing / submission (explicitly detection-only at this stage).
