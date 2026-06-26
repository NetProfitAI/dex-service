import "dotenv/config";
import { RaydiumDex, WhirlpoolDex, MeteoraDex } from "../../dex";
import pgPool, { getPoolsByTokens, getTopLiquidityPairs } from "../../database";
import { PoolPrice } from "../../types";

/**
 * Real-time Arbitrage Search Process.
 * 
 * This process uses Solana RPC subscriptions (onAccountChange) to monitor prices
 * synchronously as trades happen on-chain.
 * 
 * LIMIT: 10 subscriptions (configured for top 10 most liquid pools among cross-dex pairs).
 */

const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const raydium = new RaydiumDex({ rpcUrl });
const whirlpool = new WhirlpoolDex({ rpcUrl });
const meteora = new MeteoraDex({ rpcUrl });

const adapters: Record<string, any> = {
    Raydium: raydium,
    Whirlpool: whirlpool,
    Meteora: meteora
};

// State to keep track of live prices and subscriptions
const livePrices: Map<string, PoolPrice> = new Map(); // poolAddress -> priceData
const pairMints: Map<string, { mintA: string, mintB: string }> = new Map(); // poolAddress -> pair info
const activeSubscriptions: number[] = [];

async function startRealtimeSearch() {
    console.log("🚀 Starting REAL-TIME arbitrage search (using RPC Subscriptions)...\n");

    try {
        // 1. Get the top liquid pairs (ones that exist on multiple DEXes)
        const topPairs = await getTopLiquidityPairs(20);
        
        let subscriptionCount = 0;
        const maxSubscriptions = 10;

        console.log(`📊 Selecting top pools for monitoring (Limit: ${maxSubscriptions})...`);

        for (const pair of topPairs) {
            if (subscriptionCount >= maxSubscriptions) break;

            const pools = await getPoolsByTokens(pair.mint_a, pair.mint_b);
            // Sort by liquidity to pick the best ones
            const sortedPools = pools.sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0));

            for (const pool of sortedPools) {
                if (subscriptionCount >= maxSubscriptions) break;
                if (!adapters[pool.dex]) continue;

                console.log(`📡 Subscribing to ${pool.dex.padEnd(10)} | ${pool.address} | ${pool.tokenASymbol}/${pool.tokenBSymbol}`);
                
                try {
                    // Initialize with current price
                    const initialPrice = await adapters[pool.dex].getPoolPrice(pool.address, pool.poolType);
                    updatePrice(pool.address, initialPrice, pair.mint_a, pair.mint_b);

                    // Subscribe to real-time updates
                    const subId = await adapters[pool.dex].subscribeToPrice(
                        pool.address,
                        (newPrice: PoolPrice) => {
                            updatePrice(pool.address, newPrice, pair.mint_a, pair.mint_b);
                            checkArbitrage(pair.mint_a, pair.mint_b);
                        },
                        pool.poolType
                    );
                    
                    activeSubscriptions.push(subId);
                    pairMints.set(pool.address, { mintA: pair.mint_a, mintB: pair.mint_b });
                    subscriptionCount++;
                } catch (err) {
                    console.error(`❌ Failed to subscribe to pool ${pool.address}:`, err);
                }
            }
        }

        console.log(`\n✅ Successfully subscribed to ${subscriptionCount} pools.`);
        console.log("👀 Standing by for real-time price updates...\n");

    } catch (error) {
        console.error("❌ Error starting realtime search:", error);
    }
}

function updatePrice(poolAddress: string, priceData: PoolPrice, targetMintA: string, targetMintB: string) {
    // Normalize price to MintB per MintA
    let normalizedPrice = priceData.price;
    if (priceData.tokenAMint !== targetMintA && priceData.price > 0) {
        normalizedPrice = 1 / priceData.price;
    }

    livePrices.set(poolAddress, {
        ...priceData,
        price: normalizedPrice
    });
}

function checkArbitrage(mintA: string, mintB: string) {
    // Find all active prices for this pair
    const relevantPrices: PoolPrice[] = [];
    
    for (const [addr, data] of livePrices.entries()) {
        const info = pairMints.get(addr);
        if (info && info.mintA === mintA && info.mintB === mintB) {
            relevantPrices.push(data);
        }
    }

    if (relevantPrices.length < 2) return;

    // Sort by price
    relevantPrices.sort((a, b) => a.price - b.price);

    const lowest = relevantPrices[0];
    const highest = relevantPrices[relevantPrices.length - 1];

    if (lowest.price <= 0) return;

    const spreadPercent = ((highest.price - lowest.price) / lowest.price) * 100;

    // Filter out same DEX arbitrage (usually not what we want here) and set threshold
    if (spreadPercent > 0.5 && lowest.dex !== highest.dex) {
        console.log(`\n[${new Date().toLocaleTimeString()}] 🚨 REAL-TIME OP FOUND!`);
        console.log(`Spread: ${spreadPercent.toFixed(3)}%`);
        console.log(`Buy:  ${lowest.dex.padEnd(10)} | ${lowest.price.toFixed(6)}`);
        console.log(`Sell: ${highest.dex.padEnd(10)} | ${highest.price.toFixed(6)}`);
    }
}

// Cleanup on exit
process.on("SIGINT", async () => {
    console.log("\n🛑 Shutting down. Cleaning up subscriptions...");
    // Since we used different adapters, we should technically call unsubscribe on each,
    // but Solana Connection is shared, so we can just exit or call removeAllListeners.
    process.exit();
});

startRealtimeSearch();
