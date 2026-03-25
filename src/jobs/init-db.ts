
import { initDatabase } from "../database";

/**
 * Job to initialize the database schema.
 * Can be run with: npm run dev jobs init-db
 */
export async function run(): Promise<void> {
    console.log("🛠️  Initializing database schema...");
    try {
        await initDatabase();
        console.log("✅ Initialization complete.");
    } catch (err) {
        console.error("❌ Database initialization failed:", err);
    }
}

export default run;
