
import { getPoolsByTokens } from "../database";
import { RaydiumDex, WhirlpoolDex, MeteoraDex } from "../dex";
import { DexConfig } from "../types";
import { RateLimiter } from "../utils/RateLimiter";

// ─── Shared Instances ─────────────────────────────────────────────────────────

const config: DexConfig = {
    rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    commitment: "processed" // For speed
};

const adapters = {
    Raydium: new RaydiumDex(config),
    Whirlpool: new WhirlpoolDex(config),
    Meteora: new MeteoraDex(config),
};

const rateLimiter = new RateLimiter(50); // 50 RPS limit

// ─── Logic ─────────────────────────────────────────────────────────────────────

/**
 * Main execution function for entries/arbitrage.ts
 */
export async function arbitrage(mint1: string, mint2: string): Promise<void> {
    if (!mint1 || !mint2) {
        console.error("❌ Error: Missing token mint addresses.");
        console.log("Usage: npm run dev entries arbitrage <mint1> <mint2>");
        return;
    }

    console.log(`\n🔍 Searching for arbitrage opportunities: ${mint1} / ${mint2} ...`);

    // 1. Get pools from DB
    const poolsInDb = await getPoolsByTokens(mint1, mint2);
    if (poolsInDb.length < 2) {
        console.log("⚠️ Not enough pools found for the given pair (need at least 2 pools).");
        return;
    }

    console.log(`✅  Found ${poolsInDb.length} pools in DB for this pair.`);

    // 2. Fetch prices from on-chain (Rate-limited)
    const pricePromises = poolsInDb.map(async (p) => {
        const adapter = (adapters as any)[p.dex];
        if (!adapter) {
            console.error(`❌ No adapter found for DEX: ${p.dex}`);
            return null;
        }

        try {
            await rateLimiter.acquire();
            const poolPrice = await adapter.getPoolPrice(p.address, p.poolType);

            let normalizedPrice: number;
            if (poolPrice.tokenAMint === mint1) {
                normalizedPrice = poolPrice.price;
            } else {
                normalizedPrice = 1 / poolPrice.price;
            }

            return {
                dex: p.dex,
                address: p.address,
                price: normalizedPrice,
                priceRaw: poolPrice.price,
                tokenAMint: mint1,
                tokenBMint: mint2,
                fee: p.fee || 0,
                liquidity: p.liquidity,
            };
        } catch (e) {
            console.error(`❌ Failed to fetch price for ${p.dex} pool ${p.address}:`, e);
            return null;
        }
    });

    const prices = (await Promise.all(pricePromises)).filter((p): p is NonNullable<typeof p> => p !== null);

    if (prices.length < 2) {
        console.log("⚠️ Not enough price data available to compare.");
        return;
    }

    // 3. Search for Arbitrage
    prices.sort((a, b) => a.price - b.price);

    const cheapest = prices[0];
    const mostExpensive = prices[prices.length - 1];

    console.log("\n--- Prices (B/A) ---");
    prices.forEach(p => console.log(`${p.dex}: ${p.price.toFixed(6)} | Liq: $${p.liquidity?.toLocaleString()}`));

    const diff = ((mostExpensive.price / cheapest.price) - 1) * 100;
    const estimatedFees = (cheapest.fee + mostExpensive.fee) / 100;

    if (diff > estimatedFees) {
        console.log("\n💰 ARBITRAGE OPPORTUNITY FOUND! 💰");
        console.log(`Buy on  : ${cheapest.dex} (${cheapest.address}) at ${cheapest.price.toFixed(6)}`);
        console.log(`Sell on : ${mostExpensive.dex} (${mostExpensive.address}) at ${mostExpensive.price.toFixed(6)}`);
        console.log(`Gross Profit: ${diff.toFixed(2)}%`);
        console.log(`Est. Net   : ${(diff - estimatedFees).toFixed(2)}%`);
    } else {
        console.log(`\nNo significant arbitrage found (Diff: ${diff.toFixed(2)}%, Fees: ${estimatedFees.toFixed(2)}%)`);
    }
}

// Rename findArbitrageOpportunities to arbitrage export to make it easier to discover via dynamic import
export const findArbitrageOpportunities = arbitrage;
