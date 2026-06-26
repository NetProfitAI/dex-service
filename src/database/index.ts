import "dotenv/config";
import { Pool as PGPool } from "pg";
import { Pool as DexPool } from "../types";
import fs from "fs";
import path from "path";

const pgPool = new PGPool({
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME || "dex_service",
});

export async function initDatabase() {
    const schemaPath = path.join(__dirname, "schema.sql");
    const schema = fs.readFileSync(schemaPath, "utf8");
    await pgPool.query(schema);
    console.log("✅ Database schema initialized.");
}

export async function truncatePools() {
    await pgPool.query("TRUNCATE TABLE pools");
    console.log("🧹  Pools table truncated.");
}


export async function savePools(pools: DexPool[]) {
    // Filter out pools without liquidity
    const filteredPools = pools.filter(p => (p.liquidity || 0) > 0);

    if (filteredPools.length === 0) {
        console.log("⚠️ No pools with liquidity found to save.");
        return;
    }

    const client = await pgPool.connect();
    let successfulInserts = 0;

    try {
        const batchSize = 2000;
        for (let i = 0; i < filteredPools.length; i += batchSize) {
            const batch = filteredPools.slice(i, i + batchSize);

            const values: any[] = [];
            const placeholders: string[] = [];

            let paramIndex = 1;
            for (const pool of batch) {
                placeholders.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, CURRENT_TIMESTAMP)`);
                values.push(
                    pool.dex,
                    pool.address,
                    pool.tokenAMint,
                    pool.tokenBMint,
                    pool.tokenAName,
                    pool.tokenBName,
                    pool.tokenASymbol,
                    pool.tokenBSymbol,
                    pool.liquidity,
                    pool.volume24h,
                    pool.fee,
                    pool.poolType
                );
            }

            const batchQuery = `
                INSERT INTO pools (
                    dex, address, token_a_mint, token_b_mint, 
                    token_a_name, token_b_name, token_a_symbol, token_b_symbol, 
                    liquidity, volume_24h, fee, pool_type, updated_at
                ) VALUES ${placeholders.join(', ')}
                ON CONFLICT (dex, address) DO UPDATE SET
                    token_a_name = EXCLUDED.token_a_name,
                    token_b_name = EXCLUDED.token_b_name,
                    token_a_symbol = EXCLUDED.token_a_symbol,
                    token_b_symbol = EXCLUDED.token_b_symbol,
                    liquidity = EXCLUDED.liquidity,
                    volume_24h = EXCLUDED.volume_24h,
                    fee = EXCLUDED.fee,
                    pool_type = EXCLUDED.pool_type,
                    updated_at = CURRENT_TIMESTAMP;
            `;

            try {
                await client.query(batchQuery, values);
                successfulInserts += batch.length;
            } catch (innerError) {
                console.error(`⚠️  Batch insert failed, falling back to individual inserts:`, innerError instanceof Error ? innerError.message : innerError);

                // Fallback to one-by-one for this batch
                const singleQuery = `
                    INSERT INTO pools (
                        dex, address, token_a_mint, token_b_mint, 
                        token_a_name, token_b_name, token_a_symbol, token_b_symbol, 
                        liquidity, volume_24h, fee, pool_type, updated_at
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP
                    )
                    ON CONFLICT (dex, address) DO UPDATE SET
                        token_a_name = EXCLUDED.token_a_name,
                        token_b_name = EXCLUDED.token_b_name,
                        token_a_symbol = EXCLUDED.token_a_symbol,
                        token_b_symbol = EXCLUDED.token_b_symbol,
                        liquidity = EXCLUDED.liquidity,
                        volume_24h = EXCLUDED.volume_24h,
                        fee = EXCLUDED.fee,
                        pool_type = EXCLUDED.pool_type,
                        updated_at = CURRENT_TIMESTAMP;
                `;

                for (const pool of batch) {
                    try {
                        await client.query(singleQuery, [
                            pool.dex,
                            pool.address,
                            pool.tokenAMint,
                            pool.tokenBMint,
                            pool.tokenAName,
                            pool.tokenBName,
                            pool.tokenASymbol,
                            pool.tokenBSymbol,
                            pool.liquidity,
                            pool.volume24h,
                            pool.fee,
                            pool.poolType
                        ]);
                        successfulInserts++;
                    } catch (fallbackError) {
                        console.error(`⚠️  Skipping pool ${pool.address} on ${pool.dex} due to error:`, fallbackError instanceof Error ? fallbackError.message : fallbackError);
                    }
                }
            }
        }
        console.log(`✅ Saved ${successfulInserts} pools to database out of ${filteredPools.length} attempted (filtered ${pools.length - filteredPools.length} 0-liquidity pools).`);
    } catch (e) {
        console.error("❌ Fatal error saving pools:", e);
    } finally {
        client.release();
    }
}


export async function getPoolsByTokens(mintA: string, mintB: string): Promise<DexPool[]> {
    const res = await pgPool.query(
        `SELECT * FROM pools 
         WHERE (token_a_mint = $1 AND token_b_mint = $2) 
            OR (token_a_mint = $2 AND token_b_mint = $1)`,
        [mintA, mintB]
    );

    return res.rows.map(row => ({
        dex: row.dex,
        address: row.address,
        tokenAMint: row.token_a_mint,
        tokenBMint: row.token_b_mint,
        tokenAName: row.token_a_name,
        tokenBName: row.token_b_name,
        tokenASymbol: row.token_a_symbol,
        tokenBSymbol: row.token_b_symbol,
        liquidity: parseFloat(row.liquidity),
        volume24h: parseFloat(row.volume_24h),
        fee: parseFloat(row.fee),
        poolType: row.pool_type
    }));
}


export async function getAllPools(): Promise<DexPool[]> {
    const res = await pgPool.query("SELECT * FROM pools");
    return res.rows.map(row => ({
        dex: row.dex,
        address: row.address,
        tokenAMint: row.token_a_mint,
        tokenBMint: row.token_b_mint,
        tokenAName: row.token_a_name,
        tokenBName: row.token_b_name,
        tokenASymbol: row.token_a_symbol,
        tokenBSymbol: row.token_b_symbol,
        liquidity: parseFloat(row.liquidity),
        volume24h: parseFloat(row.volume_24h),
        fee: parseFloat(row.fee),
        poolType: row.pool_type
    }));
}

export async function getTopLiquidityPairs(limit: number = 10): Promise<any[]> {
    const res = await pgPool.query(
        `SELECT 
            LEAST(token_a_mint, token_b_mint) as mint_a,
            GREATEST(token_a_mint, token_b_mint) as mint_b,
            COUNT(*) as pool_count,
            SUM(liquidity) as total_liquidity
         FROM pools
         GROUP BY mint_a, mint_b
         HAVING COUNT(*) > 1
         ORDER BY total_liquidity DESC
         LIMIT $1`,
        [limit]
    );
    return res.rows;
}

/**
 * A detected cross-DEX arbitrage opportunity, ready to be persisted.
 * `detected_at` / `detected_date` / `detected_hour` are filled in by the DB defaults.
 */
export interface ArbitrageOpportunityRecord {
    tokenAMint: string;
    tokenBMint: string;
    tokenASymbol?: string;
    tokenBSymbol?: string;
    route: string;        // e.g. "Raydium -> Whirlpool"
    buyDex: string;
    buyPool: string;
    buyPrice: number;
    sellDex: string;
    sellPool: string;
    sellPrice: number;
    grossPct?: number;
    feePct?: number;
    impactPct?: number;
    netPct?: number;
    tradeUsd?: number;
}

export async function saveArbitrageOpportunity(op: ArbitrageOpportunityRecord): Promise<void> {
    await pgPool.query(
        `INSERT INTO arbitrage_opportunities (
            token_a_mint, token_b_mint, token_a_symbol, token_b_symbol,
            route, buy_dex, buy_pool, buy_price,
            sell_dex, sell_pool, sell_price,
            gross_pct, fee_pct, impact_pct, net_pct, trade_usd
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
        )`,
        [
            op.tokenAMint,
            op.tokenBMint,
            op.tokenASymbol ?? null,
            op.tokenBSymbol ?? null,
            op.route,
            op.buyDex,
            op.buyPool,
            op.buyPrice,
            op.sellDex,
            op.sellPool,
            op.sellPrice,
            op.grossPct ?? null,
            op.feePct ?? null,
            op.impactPct ?? null,
            op.netPct ?? null,
            op.tradeUsd ?? null,
        ]
    );
}

export default pgPool;
