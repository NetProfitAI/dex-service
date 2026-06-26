import "dotenv/config";
import pgPool from "../database";
import { RaydiumDex, WhirlpoolDex, MeteoraDex } from "../dex";

/**
 * One-off: re-check every stored arbitrage_opportunities row against LIVE on-chain
 * prices (via SOLANA_RPC_URL) to see whether the spread is real or a stale/empty-pool
 * artifact. Detection-only — no transactions.
 */

const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const config = { rpcUrl, commitment: "processed" as const };
const adapters: Record<string, RaydiumDex | WhirlpoolDex | MeteoraDex> = {
    Raydium: new RaydiumDex(config),
    Whirlpool: new WhirlpoolDex(config),
    Meteora: new MeteoraDex(config),
};

/** Live price of a pool, normalized to "mintB per mintA" for the given pair. */
async function livePrice(dex: string, pool: string, poolType: string | undefined, mintA: string): Promise<number | null> {
    try {
        const pp = await adapters[dex].getPoolPrice(pool, poolType);
        const price = pp.tokenAMint === mintA ? pp.price : 1 / pp.price;
        return isFinite(price) && price > 0 ? price : null;
    } catch (e) {
        console.log(`    ⚠️  ${dex} ${pool} fetch failed: ${e instanceof Error ? e.message : e}`);
        return null;
    }
}

async function main() {
    console.log(`🔗  RPC: ${rpcUrl.split("?")[0]}...\n`);

    const { rows } = await pgPool.query(`
        SELECT o.*, bp.pool_type AS buy_type, sp.pool_type AS sell_type,
               bp.liquidity AS buy_liq, sp.liquidity AS sell_liq
        FROM arbitrage_opportunities o
        LEFT JOIN pools bp ON bp.address = o.buy_pool  AND bp.dex = o.buy_dex
        LEFT JOIN pools sp ON sp.address = o.sell_pool AND sp.dex = o.sell_dex
        ORDER BY o.detected_at
    `);

    for (const r of rows) {
        console.log("═".repeat(78));
        console.log(`#${r.id}  ${r.token_a_symbol}/${r.token_b_symbol}  route ${r.route}  (detected ${r.detected_at.toISOString()})`);
        console.log(`    STORED: buy ${r.buy_dex}@${Number(r.buy_price).toExponential(4)}  ` +
            `sell ${r.sell_dex}@${Number(r.sell_price).toExponential(4)}  ` +
            `gross ${Number(r.gross_pct).toLocaleString()}%  net ${Number(r.net_pct).toLocaleString()}%`);
        console.log(`    DB liquidity: buy=$${r.buy_liq ?? "?"}  sell=$${r.sell_liq ?? "?"}`);

        const [liveBuy, liveSell] = await Promise.all([
            livePrice(r.buy_dex, r.buy_pool, r.buy_type, r.token_a_mint),
            livePrice(r.sell_dex, r.sell_pool, r.sell_type, r.token_a_mint),
        ]);

        console.log(`    LIVE:   buy ${r.buy_dex}=${liveBuy === null ? "n/a" : liveBuy.toExponential(4)}  ` +
            `sell ${r.sell_dex}=${liveSell === null ? "n/a" : liveSell.toExponential(4)}`);

        if (liveBuy !== null && liveSell !== null) {
            const liveGross = (liveSell / liveBuy - 1) * 100;
            console.log(`    LIVE GROSS SPREAD: ${liveGross.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`);
            const verdict =
                Math.abs(liveGross) > 100 ? "🚩 ABSURD — almost certainly a dead/stale pool, not real arb"
                : liveGross > 1 ? "🤔 plausible spread — worth a depth-aware (tick/bin-exact) re-check"
                : "✅ no meaningful live spread — the stored opp was transient/stale";
            console.log(`    VERDICT: ${verdict}`);
        } else {
            console.log(`    VERDICT: 🚩 one or both pools un-priceable on-chain right now (likely empty/closed).`);
        }
        console.log();
    }

    await pgPool.end();
}

main().catch(async (e) => {
    console.error("crashed:", e);
    try { await pgPool.end(); } catch { /* ignore */ }
    process.exit(1);
});
