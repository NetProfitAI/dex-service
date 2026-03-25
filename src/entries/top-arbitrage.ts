
import { getTopLiquidityPairs } from "../database";
import { findArbitrageOpportunities } from "../entries/arbitrage";

/**
 * Job to fetch the top 10 most liquid token pairs and run arbitrage search on them.
 * This identifies the best opportunities based on where the money is.
 */
export async function run(): Promise<void> {
    console.log("🚀  Fetching top 10 most liquid pairs for arbitrage search...\n");

    try {
        const topPairs = await getTopLiquidityPairs(10);

        if (topPairs.length === 0) {
            console.log("⚠️ No pairs with multisource liquidity found in DB. Run 'sync-pools-to-db' first.");
            return;
        }

        console.log(`✅  Found ${topPairs.length} top pairs. Starting batch search...\n`);

        for (let i = 0; i < topPairs.length; i++) {
            const pair = topPairs[i];
            console.log(`\n[${i + 1}/10] Checking Pair: ${pair.mint_a} / ${pair.mint_b}`);
            console.log(`📊  Total Cross-DEX Liquidity: $${parseFloat(pair.total_liquidity).toLocaleString()}`);
            console.log(`🏦  Available Pools: ${pair.pool_count}`);

            try {
                // Run the arbitrage search for this pair
                await findArbitrageOpportunities(pair.mint_a, pair.mint_b);
            } catch (err) {
                console.error(`❌  Error checking pair ${i + 1}:`, err);
            }

            console.log("------------------------------------------------------------------");
        }

        console.log("\n✨  Batch arbitrage search complete.");

    } catch (err) {
        console.error("❌  Failed to run top arbitrage search:", err);
    }
}

export default run;
