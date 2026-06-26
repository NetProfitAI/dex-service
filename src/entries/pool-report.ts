import "dotenv/config";
import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import pgPool from "../database";
import { RaydiumDex, WhirlpoolDex, MeteoraDex } from "../dex";
import { PoolPrice } from "../types";

/**
 * Full pool report generator.
 *
 *   npm run dev entries pool-report <dex> <poolId>
 *   e.g. npm run dev entries pool-report Meteora 4tN1E9jWftNPv2eFeTbGTDRFYCPH8Sauo3q5N2AJnQXn
 *
 * Combines the on-chain live price (via the DEX adapter) with the DB snapshot
 * (liquidity, 24h volume, fee/commission, decimals) and a few derived metrics
 * (inverse price, turnover, modelled slippage at several trade sizes), then writes
 * a Markdown report to reports/. Detection/inspection only — no transactions.
 */

const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const connection = new Connection(rpcUrl, "processed");

const adapters: Record<string, RaydiumDex | WhirlpoolDex | MeteoraDex> = {
    Raydium: new RaydiumDex({ rpcUrl }),
    Whirlpool: new WhirlpoolDex({ rpcUrl }),
    Meteora: new MeteoraDex({ rpcUrl }),
};

/** Accept "meteora", "METEORA", "Meteora" → canonical adapter key. */
function canonicalDex(input: string): string | null {
    const key = Object.keys(adapters).find((k) => k.toLowerCase() === input.toLowerCase());
    return key ?? null;
}

/** Same constant-product impact model the arb scanner uses, for consistency. */
function impactFraction(tradeUsd: number, liquidityUsd: number): number {
    if (liquidityUsd <= 0) return 1;
    return Math.min(0.99, (2 * tradeUsd) / liquidityUsd);
}

async function mintDecimals(mint: string): Promise<number | null> {
    try {
        const info = await connection.getParsedAccountInfo(new PublicKey(mint));
        return (info.value?.data as any)?.parsed?.info?.decimals ?? null;
    } catch {
        return null;
    }
}

interface DbRow {
    dex: string;
    address: string;
    token_a_mint: string;
    token_b_mint: string;
    token_a_name: string | null;
    token_b_name: string | null;
    token_a_symbol: string | null;
    token_b_symbol: string | null;
    liquidity: string | null;
    volume_24h: string | null;
    fee: string | null;
    pool_type: string | null;
    updated_at: Date | null;
}

function fmtUsd(n: number | null): string {
    if (n === null || !isFinite(n)) return "n/a";
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtNum(n: number | null | undefined, sig = 8): string {
    if (n === null || n === undefined || !isFinite(n)) return "n/a";
    return n.toPrecision(sig).replace(/\.?0+$/, "");
}

export default async function poolReport(dexArg?: string, poolId?: string): Promise<void> {
    if (!dexArg || !poolId) {
        console.error("❌  Usage: npm run dev entries pool-report <dex> <poolId>");
        console.error("    dex ∈ Raydium | Whirlpool | Meteora");
        await pgPool.end();
        process.exit(1);
    }

    const dex = canonicalDex(dexArg);
    if (!dex) {
        console.error(`❌  Unknown dex "${dexArg}". Expected one of: ${Object.keys(adapters).join(", ")}`);
        await pgPool.end();
        process.exit(1);
    }

    console.log(`🔍  Building report for ${dex} pool ${poolId} …`);

    // 1. DB snapshot (metadata, liquidity, fee, volume). Pool may legitimately not be in DB.
    const res = await pgPool.query<DbRow>(
        `SELECT * FROM pools WHERE address = $1 AND dex = $2 LIMIT 1`,
        [poolId, dex]
    );
    const db = res.rows[0] ?? null;
    if (!db) {
        console.warn(`⚠️  Pool not found in DB for dex=${dex}. Report will use live data only (no liquidity/fee/volume).`);
    }

    // 2. Live on-chain price.
    let price: PoolPrice | null = null;
    let priceError: string | null = null;
    try {
        price = await adapters[dex].getPoolPrice(poolId, db?.pool_type ?? undefined);
    } catch (e) {
        priceError = e instanceof Error ? e.message : String(e);
        console.warn(`⚠️  Live price fetch failed: ${priceError}`);
    }

    // 3. Decimals for both mints (cheap on-chain reads).
    const mintA = price?.tokenAMint || db?.token_a_mint || "";
    const mintB = price?.tokenBMint || db?.token_b_mint || "";
    const [decA, decB] = await Promise.all([
        mintA ? mintDecimals(mintA) : Promise.resolve(null),
        mintB ? mintDecimals(mintB) : Promise.resolve(null),
    ]);

    // 4. Derived metrics.
    const liquidity = db?.liquidity != null ? parseFloat(db.liquidity) : null;
    const volume24h = db?.volume_24h != null ? parseFloat(db.volume_24h) : null;
    const feeFraction = db?.fee != null ? parseFloat(db.fee) : null;
    const turnover = liquidity && liquidity > 0 && volume24h != null ? volume24h / liquidity : null;
    const priceBperA = price?.price ?? null;
    const priceAperB = priceBperA && priceBperA > 0 ? 1 / priceBperA : null;

    const symA = db?.token_a_symbol || mintA.slice(0, 6) || "TOKEN_A";
    const symB = db?.token_b_symbol || mintB.slice(0, 6) || "TOKEN_B";

    // Slippage model at a ladder of trade sizes (constant-product, same as scanner).
    const tradeSizes = [100, 1_000, 10_000, 100_000];
    const slippageRows = tradeSizes.map((t) => {
        const imp = liquidity != null ? impactFraction(t, liquidity) : null;
        return { trade: t, impactPct: imp != null ? imp * 100 : null };
    });

    // Health flags — ties into the staleness/liveness discussion.
    const flags: string[] = [];
    if (liquidity != null && liquidity < 1_000) flags.push(`🔴 **Thin liquidity** (${fmtUsd(liquidity)}) — likely unfillable for a meaningful trade.`);
    if (volume24h != null && volume24h === 0) flags.push("🔴 **Zero 24h volume** — pool is untraded; its quoted price may be stale/frozen.");
    if (turnover != null && turnover < 0.01 && (volume24h ?? 0) > 0) flags.push(`🟡 **Very low turnover** (${(turnover * 100).toFixed(2)}% of TVL/day) — thinly traded.`);
    if (db?.updated_at) {
        const ageHrs = (Date.now() - new Date(db.updated_at).getTime()) / 3_600_000;
        if (ageHrs > 24) flags.push(`🟡 **Stale DB snapshot** — liquidity/volume figures are ${ageHrs.toFixed(0)}h old (run sync-pools-to-db).`);
    }
    if (priceError) flags.push(`🔴 **Live price unavailable** — ${priceError}`);
    if (flags.length === 0) flags.push("🟢 No obvious red flags.");

    const now = new Date();
    const explorer = `https://solscan.io/account/${poolId}`;

    // ── Compose Markdown ──────────────────────────────────────────────────────
    const md = `# Pool Report — ${symA}/${symB}

| | |
|---|---|
| **DEX** | ${dex} |
| **Pool type** | ${db?.pool_type ?? "n/a"} |
| **Pool address** | \`${poolId}\` |
| **Explorer** | [Solscan](${explorer}) |
| **Generated** | ${now.toISOString()} |
| **DB snapshot age** | ${db?.updated_at ? `${((Date.now() - new Date(db.updated_at).getTime()) / 3_600_000).toFixed(1)}h (updated ${new Date(db.updated_at).toISOString()})` : "not in DB"} |

## Health

${flags.map((f) => `- ${f}`).join("\n")}

## Tokens

| Side | Symbol | Name | Mint | Decimals |
|------|--------|------|------|----------|
| A (base)  | ${symA} | ${db?.token_a_name ?? "n/a"} | \`${mintA || "n/a"}\` | ${decA ?? "n/a"} |
| B (quote) | ${symB} | ${db?.token_b_name ?? "n/a"} | \`${mintB || "n/a"}\` | ${decB ?? "n/a"} |

## Live Price (on-chain)

| Metric | Value |
|--------|-------|
| Price (${symB} per 1 ${symA}) | ${fmtNum(priceBperA)} |
| Inverse (${symA} per 1 ${symB}) | ${fmtNum(priceAperB)} |
| Fetched at | ${price?.fetchedAt ?? "n/a"} |
| Source | ${dex} adapter (${db?.pool_type ?? "auto-detected"}) |

## Liquidity, Volume & Commission (DB snapshot)

| Metric | Value |
|--------|-------|
| Liquidity (TVL) | ${fmtUsd(liquidity)} |
| 24h Volume | ${fmtUsd(volume24h)} |
| Turnover (24h vol ÷ TVL) | ${turnover != null ? `${(turnover * 100).toFixed(2)}% / day` : "n/a"} |
| Fee / commission | ${feeFraction != null ? `${(feeFraction * 100).toFixed(4)}% (${Math.round(feeFraction * 10_000)} bps)` : "n/a"} |

## Modelled Slippage (constant-product estimate)

Price impact of pushing a one-sided trade through this pool, using TVL as depth
(\`impact ≈ 2 × tradeUSD ÷ TVL\`, capped at 99%). Conservative for concentrated
liquidity; replace with SDK bin/tick-exact quotes before trusting for execution.

| Trade size | Est. price impact |
|------------|-------------------|
${slippageRows.map((r) => `| ${fmtUsd(r.trade)} | ${r.impactPct != null ? `${r.impactPct.toFixed(2)}%` : "n/a"} |`).join("\n")}

---
*Generated by \`entries/pool-report\`. Figures labelled “DB snapshot” are only as fresh
as the last \`sync-pools-to-db\` run; the live price is read directly from chain.*
`;

    // ── Write file ────────────────────────────────────────────────────────────
    const reportsDir = path.join(__dirname, "..", "..", "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const fileName = `${dex}_${poolId.slice(0, 8)}_${stamp}.md`;
    const filePath = path.join(reportsDir, fileName);
    fs.writeFileSync(filePath, md, "utf8");

    console.log(`\n✅  Report written to reports/${fileName}`);
    console.log(`    ${symA}/${symB} | price ${fmtNum(priceBperA)} ${symB}/${symA} | ` +
        `liq ${fmtUsd(liquidity)} | vol24h ${fmtUsd(volume24h)} | ` +
        `fee ${feeFraction != null ? `${(feeFraction * 100).toFixed(3)}%` : "n/a"}`);

    await pgPool.end();
    process.exit(0);
}

if (require.main === module) {
    const [, , dexArg, poolId] = process.argv;
    poolReport(dexArg, poolId);
}
