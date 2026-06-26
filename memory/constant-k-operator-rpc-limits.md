---
name: constant-k-operator-rpc-limits
description: User's Solana RPC provider is constant-k on the Operator plan; key rate limits
metadata:
  type: reference
---

The user runs an **Operator** plan on **constant-k** (https://www.constant-k.com/plan_limits/) as their Solana RPC provider. Binding limits for this project:

- **getAccountInfo / getMultipleAccounts / getTransaction / simulateTransaction / getSlot ≈ 5 req/s** ← the constraint that matters: every price fetch is an account read.
- Lightweight methods (getBalance, getTokenAccountBalance, getEpochInfo, getHealth, isBlockhashValid, getRecentPrioritizationFees, getFeeForMessage, etc.) = **50 req/s**.
- **sendTransaction = 15 req/s**.
- **WebSocket concurrent connections = 10 per API key** (caps onAccountChange subscriptions).
- Limits apply **per location** (New York + Frankfurt), so using both ~doubles them.

**How to apply:** keep sustained account reads under ~5/s (rate-limit with headroom); prefer polling over WS when >10 pools; batch with getMultipleAccounts where possible. Used by the arb scanner ([[dex-service-arbitrage-goal]]) and the single-RPC price design ([[dex-pool-price-one-rpc-call]]).
