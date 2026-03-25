# dex-service

A Node.js / TypeScript service that fetches current pool prices from multiple Solana DEX protocols.

## Supported DEXes

| DEX | SDK | Pool Types |
|---|---|---|
| **Raydium** | `@raydium-io/raydium-sdk-v2` | CLMM, CPMM, AMM v4/v5 |
| **Orca Whirlpool** | `@orca-so/whirlpools-client` + `@orca-so/whirlpools-core` | CLMM |
| **Meteora** | `@meteora-ag/dlmm` | DLMM |

## Architecture

```
BaseDex (abstract)
├── RaydiumDex   – auto-detects CLMM / CPMM / AMM v4
├── WhirlpoolDex – Orca Whirlpool CLMM
└── MeteoraDex   – Meteora DLMM (active-bin price)
```

Every adapter exposes a single method:

```ts
getPoolPrice(poolAddress: string): Promise<PoolPrice>
```

`PoolPrice` is a plain object:

```ts
interface PoolPrice {
  dex:         string;   // e.g. "Raydium"
  poolAddress: string;
  price:       number;   // tokenB per tokenA
  tokenAMint:  string;
  tokenBMint:  string;
  fetchedAt:   string;   // ISO-8601
}
```

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy and edit the env file
cp .env.example .env
# set SOLANA_RPC_URL (public or private endpoint)

# 3. Run the demo
npm run dev
```

The demo in `src/index.ts` queries a hard-coded SOL/USDC pool on each DEX and
prints the results to stdout. Replace the pool addresses with any pool you want
to monitor.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Run with ts-node (no compile step) |
| `npm run dev:watch` | Auto-restart on file changes |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled output |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana JSON-RPC endpoint |

> **Note:** The public mainnet endpoint is heavily rate-limited. For production
> use, supply a private RPC from [Helius](https://helius.dev/),
> [QuickNode](https://quicknode.com/), or similar.
