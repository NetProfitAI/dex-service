
export class RateLimiter {
    private tokens: number;
    private lastRefill: number;
    private maxTokens: number;
    private refillRate: number; // tokens per millisecond

    constructor(requestsPerSecond: number) {
        this.maxTokens = requestsPerSecond;
        this.tokens = requestsPerSecond;
        this.refillRate = requestsPerSecond / 1000;
        this.lastRefill = Date.now();
    }

    async acquire(): Promise<void> {
        this.refill();
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return;
        }

        const waitTime = (1 - this.tokens) / this.refillRate;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return this.acquire();
    }

    private refill() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
        this.lastRefill = now;
    }
}
