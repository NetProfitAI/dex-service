---
name: dex-service-arbitrage-goal
description: dex-service exists to power a Solana cross-DEX arbitrage bot
metadata:
  type: project
---

The `dex-service` project (NetProfit) is the data/price layer for a **Solana cross-DEX arbitrage bot**. The goal is to detect price discrepancies for the same token pair across Raydium, Whirlpool (Orca), and Meteora and act on them.

Pipeline that already exists:
- `jobs/sync-pools-to-db` — populates the `pools` table from each DEX's pool list (foundation; must run first).
- `entries/arbitrage <mint1> <mint2>` — one-shot spread check for a pair (pulls candidate pools from DB, fetches on-chain prices).
- `entries/top-arbitrage` — batch over the top-10 most-liquid cross-DEX pairs.
- `processes/search/realtime.ts` — live `onAccountChange` RPC subscriptions on the top-10 pools, flags spreads as they happen.

Known gaps for a *real* bot (as of 2026-06-12): detection uses mid/spot price (reserve ratio) with **no slippage/price-impact or trade-size modeling**, and `entries/arbitrage.ts` has a fee-unit bug (fees stored as fractions but threshold divides by 100 → spreads almost always flagged). See [[dex-pool-price-one-rpc-call]].
