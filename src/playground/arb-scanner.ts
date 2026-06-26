import "dotenv/config";
import pgPool, { getPoolsByTokens, saveArbitrageOpportunity } from "../database";
import { RaydiumDex, WhirlpoolDex, MeteoraDex } from "../dex";
import { RateLimiter } from "../utils/RateLimiter";
import { Pool, PoolPrice } from "../types";

/**
 * Arbitrage opportunity SCANNER (detection only — no transactions).
 *
 * Loop: pick a cross-DEX pair from the DB → poll its pools' on-chain prices for
 * one minute, printing any cross-DEX spread above the threshold → move to the
 * next pair. Repeats forever.
 *
 * ── How the pair is picked (the "best way") ─────────────────────────────────────
 * Arbitrage requires the SAME pair quoted on at least two DIFFERENT DEXes that are
 * each actually tradeable, so we only count pools clearing the per-leg liquidity floor
 * (`liquidity >= MIN_POOL_LIQUIDITY_USD`) and keep pairs where ≥2 DISTINCT DEXes remain.
 * Among those we:
 *   1. Drop pairs whose fillable pools don't span ≥2 DEXes — a "spread" against a dust
 *      pool isn't executable, it's just stale/noisy data.
 *   2. Rank by 24h VOLUME desc — high turnover means active trading, which is what
 *      actually produces transient cross-DEX spreads. (Ranking by liquidity instead
 *      surfaces SOL/USDC-style pairs that are heavily arbitraged already → tiny
 *      spreads. Flip ORDER BY if you prefer executability over opportunity rate.)
 *
 * ── RPC budget (constant-k Operator plan) ───────────────────────────────────────
 * getAccountInfo / getMultipleAccounts ≈ 5 req/s. Each price fetch costs 1 account
 * read (Whirlpool, Meteora, Raydium CLMM) or 2 (Raydium CPMM/AMM — pool + vaults).
 * Every fetch goes through a RateLimiter sized below that cap, so the loop self-paces
 * and never trips the limit. We poll (not WebSocket subscriptions) because the plan
 * caps concurrent WS connections at 10.
 */

// ── Tunables (env-overridable for quick testing) ────────────────────────────────
const MONITOR_MS = Number(process.env.MONITOR_MS ?? 60_000);     // 1 minute per pair
// Per-LEG floor: every pool we actually trade through must hold real depth, otherwise
// the quote is unfillable (e.g. a $0.000001 Meteora bin) and the "spread" is an artifact.
// The pair-level SUM(liquidity) filter above can't catch this — it hides a dead leg
// behind a liquid one. Defaults assume a $1k trade; raise with TRADE_USD.
const MIN_POOL_LIQUIDITY_USD = Number(process.env.MIN_POOL_LIQUIDITY_USD ?? 1_000);
// Any gross spread above this is treated as bad/stale data, not a real opportunity.
const MAX_SANE_GROSS_PCT = Number(process.env.MAX_SANE_GROSS_PCT ?? 50);
const MIN_NET_SPREAD_PCT = Number(process.env.MIN_NET_SPREAD_PCT ?? 0.5);
const CANDIDATE_LIMIT = Number(process.env.CANDIDATE_LIMIT ?? 50);
const POOLS_PER_DEX = Number(process.env.POOLS_PER_DEX ?? 1);    // top-N most-liquid pools per DEX to watch
const POLL_GAP_MS = Number(process.env.POLL_GAP_MS ?? 500);      // breather between snapshots
const MAX_ACCOUNT_RPS = Number(process.env.MAX_ACCOUNT_RPS ?? 5); // Operator plan account-read cap
const TRADE_USD = Number(process.env.TRADE_USD ?? 1_000);        // notional per arb leg, for slippage modelling

const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const config = { rpcUrl, commitment: "processed" as const };
const adapters: Record<string, RaydiumDex | WhirlpoolDex | MeteoraDex> = {
    Raydium: new RaydiumDex(config),
    Whirlpool: new WhirlpoolDex(config),
    Meteora: new MeteoraDex(config),
};

// Stay safely under the account-read cap (80% of it).
const rateLimiter = new RateLimiter(Math.max(1, Math.floor(MAX_ACCOUNT_RPS * 0.8)));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Account reads a single price fetch will issue, so we can budget the rate limiter. */
function rpcCost(p: Pool): number {
    return p.dex === "Raydium" && (p.poolType === "cpmm" || p.poolType === "amm") ? 2 : 1;
}

/**
 * A liquid pair can have hundreds of pools (USDC/WSOL has ~160). Polling all of
 * them would blow the RPC budget, so keep only the top-N most-liquid pools per DEX
 * — cross-DEX arbitrage only needs one representative price per venue.
 */
function selectPoolsToWatch(pools: Pool[]): Pool[] {
    const byDex = new Map<string, Pool[]>();
    for (const p of pools) {
        // Drop unfillable pools up front: a leg below the floor can't absorb the trade,
        // so its quote is noise and any spread against it is a phantom opportunity.
        if ((p.liquidity || 0) < MIN_POOL_LIQUIDITY_USD) continue;
        const list = byDex.get(p.dex) ?? [];
        list.push(p);
        byDex.set(p.dex, list);
    }
    const picked: Pool[] = [];
    for (const list of byDex.values()) {
        list.sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0));
        picked.push(...list.slice(0, POOLS_PER_DEX));
    }
    return picked;
}

interface Candidate {
    mintA: string;
    mintB: string;
    poolCount: number;
    dexCount: number;
    totalLiquidity: number;
    totalVolume: number;
}

async function getCandidatePairs(limit: number): Promise<Candidate[]> {
    const res = await pgPool.query(
        `SELECT
            LEAST(token_a_mint, token_b_mint)    AS mint_a,
            GREATEST(token_a_mint, token_b_mint) AS mint_b,
            COUNT(*)                             AS pool_count,
            COUNT(DISTINCT dex)                  AS dex_count,
            SUM(liquidity)                       AS total_liquidity,
            SUM(COALESCE(volume_24h, 0))         AS total_volume
         FROM pools
         WHERE liquidity >= $2                       -- only count fillable pools toward the criteria below
         GROUP BY mint_a, mint_b
         HAVING COUNT(DISTINCT dex) > 1              -- ≥2 DEXes that are each actually tradeable
         ORDER BY total_volume ASC 
         LIMIT $1`,
        [limit, MIN_POOL_LIQUIDITY_USD]
    );
    return res.rows.map((r) => ({
        mintA: r.mint_a,
        mintB: r.mint_b,
        poolCount: Number(r.pool_count),
        dexCount: Number(r.dex_count),
        totalLiquidity: parseFloat(r.total_liquidity),
        totalVolume: parseFloat(r.total_volume),
    }));
}

interface Quote {
    dex: string;
    address: string;
    price: number;   // normalized: mintB per mintA
    fee: number;     // fraction (e.g. 0.0025)
    liquidity: number;
}

/** Fetch every pool's current price once, normalized to "mintB per mintA". */
async function snapshot(pools: Pool[], mintA: string): Promise<Quote[]> {
    const results = await Promise.all(
        pools.map(async (p): Promise<Quote | null> => {
            try {
                for (let i = 0; i < rpcCost(p); i++) await rateLimiter.acquire();
                const pp: PoolPrice = await adapters[p.dex].getPoolPrice(p.address, p.poolType);
                const price = pp.tokenAMint === mintA ? pp.price : 1 / pp.price;
                if (!isFinite(price) || price <= 0) return null;
                return { dex: p.dex, address: p.address, price, fee: p.fee || 0, liquidity: p.liquidity || 0 };
            } catch {
                return null;
            }
        })
    );
    return results.filter((q): q is Quote => q !== null);
}

interface Opportunity {
    buy: Quote;
    sell: Quote;
    grossPct: number;     // mid-price spread (no costs)
    feePct: number;       // LP fees on both legs
    impactPct: number;    // modelled price impact (slippage) on both legs
    netPct: number;       // executable net after fees + impact, at TRADE_USD
}

/**
 * Modelled price impact (slippage) of pushing `tradeUsd` through one leg, using a
 * constant-product curve with the pool's TVL as depth: a side holds ≈ TVL/2, and the
 * first-order impact of a trade of size N against reserve R is N/R = 2·N/TVL.
 *
 * This is intentionally CONSERVATIVE for concentrated-liquidity pools (CLMM/DLMM),
 * which have more depth near the current price than constant-product implies — so it
 * over-states slippage and won't flag opportunities that aren't really there. Swap to
 * each SDK's tick/bin-exact quote when promoting this from detector to executor.
 */
function impactFraction(tradeUsd: number, liquidityUsd: number): number {
    if (liquidityUsd <= 0) return 1; // unknown depth → assume fully eaten
    return Math.min(0.99, (2 * tradeUsd) / liquidityUsd);
}

/** Best cross-DEX opportunity in a snapshot: buy low on one DEX, sell high on another. */
function bestCrossDex(quotes: Quote[], tradeUsd: number): Opportunity | null {
    let best: Opportunity | null = null;
    for (const buy of quotes) {
        for (const sell of quotes) {
            if (buy.dex === sell.dex) continue;
            if (sell.price <= buy.price) continue; // only the profitable direction

            const grossPct = (sell.price / buy.price - 1) * 100;
            // A four/five-figure-% "spread" is bad data (dead pool, stale or mis-scaled
            // price), not arb — drop it before it pollutes the results.
            if (grossPct > MAX_SANE_GROSS_PCT) continue;

            // Each leg must be able to absorb the trade. If TVL is too thin the trade eats
            // the whole pool: impactFraction saturates at its cap, so the "executable" price
            // is fictional. Require real depth on both legs (≥ trade size) before trusting it.
            if (buy.liquidity < tradeUsd || sell.liquidity < tradeUsd) continue;

            // Buying pushes the price up (pay more), selling pushes it down (receive less).
            const impBuy = impactFraction(tradeUsd, buy.liquidity);
            const impSell = impactFraction(tradeUsd, sell.liquidity);
            const buyExec = buy.price * (1 + impBuy);
            const sellExec = sell.price * (1 - impSell);

            const feePct = (buy.fee + sell.fee) * 100;                  // fees are fractions
            const impactPct = (impBuy + impSell) * 100;
            const netPct = (sellExec / buyExec - 1) * 100 - feePct;     // executable net after impact + fees

            if (!best || netPct > best.netPct) {
                best = { buy, sell, grossPct, feePct, impactPct, netPct };
            }
        }
    }
    return best;
}

async function monitorPair(c: Candidate): Promise<number> {
    const allPools = (await getPoolsByTokens(c.mintA, c.mintB)).filter((p) => adapters[p.dex]);
    const pools = selectPoolsToWatch(allPools);
    const dexes = new Set(pools.map((p) => p.dex));
    // Fewer than 2 fillable DEXes left after the liquidity floor → nothing to compare.
    // Return -1 (vs 0) so the caller can report "skipped" instead of "watched, no opp".
    if (dexes.size < 2) return -1;

    const sample = pools[0];
    const [symA, symB] =
        sample.tokenAMint === c.mintA
            ? [sample.tokenASymbol, sample.tokenBSymbol]
            : [sample.tokenBSymbol, sample.tokenASymbol];

    console.log(`\n${"═".repeat(70)}`);
    console.log(`🔎  ${symA || c.mintA.slice(0, 6)} / ${symB || c.mintB.slice(0, 6)}`);
    console.log(`    watching ${pools.length}/${allPools.length} pools dexes=${[...dexes].join(",")} ` +
        `liq=$${Math.round(c.totalLiquidity).toLocaleString()} vol24h=$${Math.round(c.totalVolume).toLocaleString()}`);
    console.log(`    watching for ${Math.round(MONITOR_MS / 1000)}s …`);

    const deadline = Date.now() + MONITOR_MS;
    let found = 0;
    let lastPrinted = ""; // dedupe identical consecutive opportunities

    while (Date.now() < deadline) {
        const quotes = await snapshot(pools, c.mintA);
        if (quotes.length >= 2) {
            const op = bestCrossDex(quotes, TRADE_USD);
            if (op && op.netPct >= MIN_NET_SPREAD_PCT) {
                const sig = `${op.buy.dex}->${op.sell.dex}@${op.netPct.toFixed(2)}`;
                if (sig !== lastPrinted) {
                    found++;
                    lastPrinted = sig;
                    const t = new Date().toLocaleTimeString();
                    console.log(
                        `  💰 [${t}] BUY ${op.buy.dex}@${op.buy.price.toPrecision(6)} → ` +
                        `SELL ${op.sell.dex}@${op.sell.price.toPrecision(6)} | ` +
                        `gross ${op.grossPct.toFixed(3)}% − fees ${op.feePct.toFixed(3)}% − ` +
                        `slip ${op.impactPct.toFixed(3)}% = NET ${op.netPct.toFixed(3)}% @ $${TRADE_USD}`
                    );

                    // Persist the opportunity (date/hour are stamped by the DB defaults).
                    try {
                        await saveArbitrageOpportunity({
                            tokenAMint: c.mintA,
                            tokenBMint: c.mintB,
                            tokenASymbol: symA,
                            tokenBSymbol: symB,
                            route: `${op.buy.dex} -> ${op.sell.dex}`,
                            buyDex: op.buy.dex,
                            buyPool: op.buy.address,
                            buyPrice: op.buy.price,
                            sellDex: op.sell.dex,
                            sellPool: op.sell.address,
                            sellPrice: op.sell.price,
                            grossPct: op.grossPct,
                            feePct: op.feePct,
                            impactPct: op.impactPct,
                            netPct: op.netPct,
                            tradeUsd: TRADE_USD,
                        });
                    } catch (e) {
                        console.error("  ⚠️  Failed to save opportunity to DB:", e instanceof Error ? e.message : e);
                    }
                }
            }
        }
        await sleep(POLL_GAP_MS);
    }
    return found;
}

/**
 * Sequentially touch each adapter once before timed monitoring begins. This pays the
 * one-off costs (Raydium SDK load, first-time mint-decimal lookups) up front and
 * spaced out, instead of bursting them inside the first pair's window and tripping
 * the RPC limiter into 429 retries.
 */
async function prewarm(pairs: Candidate[]): Promise<void> {
    console.log("🔥  Pre-warming adapters & decimal cache…");
    const seen = new Set<string>();
    for (const c of pairs) {
        if (seen.size >= 3) break; // one fetch per DEX is enough to load SDKs + common decimals
        const pools = selectPoolsToWatch(
            (await getPoolsByTokens(c.mintA, c.mintB)).filter((p) => adapters[p.dex])
        );
        for (const p of pools) {
            if (seen.has(p.dex)) continue;
            try {
                for (let i = 0; i < rpcCost(p); i++) await rateLimiter.acquire();
                await adapters[p.dex].getPoolPrice(p.address, p.poolType);
                seen.add(p.dex);
            } catch { /* ignore warmup failures */ }
            await sleep(400);
        }
    }
    console.log(`    warmed: ${[...seen].join(", ") || "none"}\n`);
}

async function main() {
    console.log("🚀  Arbitrage SCANNER (detection only — no transactions)");
    console.log(`    monitor=${MONITOR_MS}ms minNet=${MIN_NET_SPREAD_PCT}% ` +
        `minPoolLiq=$${MIN_POOL_LIQUIDITY_USD} maxGross=${MAX_SANE_GROSS_PCT}% ` +
        `tradeSize=$${TRADE_USD} accountRPS≤${MAX_ACCOUNT_RPS}\n`);

    let pairs = await getCandidatePairs(CANDIDATE_LIMIT);
    if (pairs.length === 0) {
        console.log("⚠️  No cross-DEX pairs found in DB. Run 'jobs sync-pools-to-db' first.");
        await pgPool.end();
        return;
    }

    await prewarm(pairs);

    let idx = 0;
    while (true) {
        if (idx >= pairs.length) {
            // Refresh the candidate list (liquidity/volume may have changed) and start over.
            pairs = await getCandidatePairs(CANDIDATE_LIMIT);
            idx = 0;
            if (pairs.length === 0) {
                await sleep(5_000);
                continue;
            }
        }
        const c = pairs[idx++];
        const found = await monitorPair(c);
        if (found > 0) {
            console.log(`  ✅  ${found} opportunity snapshot(s) printed — next pair.`);
        }
        // found < 0 → pair was skipped (no longer 2 fillable DEXes); stay quiet, just move on.
    }
}

process.on("SIGINT", async () => {
    console.log("\n🛑  Shutting down scanner…");
    try { await pgPool.end(); } catch { /* ignore */ }
    process.exit(0);
});

main().catch(async (e) => {
    console.error("❌  Scanner crashed:", e);
    try { await pgPool.end(); } catch { /* ignore */ }
    process.exit(1);
});
