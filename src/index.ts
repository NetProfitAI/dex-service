
import "dotenv/config";
import { initDatabase } from "./database";
import path from "path";
import fs from "fs";

async function main() {
    // 1. Parse arguments: node src/index.ts <folder> <script> [...args]
    const args = process.argv.slice(2);

    if (args.length < 2) {
        printUsage();
        return;
    }

    const folder = args[0]; // e.g. "jobs" or "entries"
    const scriptName = args[1]; // e.g. "sync-pools-to-db" or "arbitrage"
    const remainingArgs = args.slice(2);

    // 3. Resolve file path
    const scriptPath = path.join(__dirname, folder, `${scriptName}.ts`);
    const scriptPathJS = path.join(__dirname, folder, `${scriptName}.js`);

    if (!fs.existsSync(scriptPath) && !fs.existsSync(scriptPathJS)) {
        console.error(`\n❌ Error: Script not found at ${scriptPath}`);
        console.log(`Available ${folder}:`);
        listAvailableScripts(folder);
        return;
    }

    // 4. Dynamic Import and Execution
    try {
        console.log(`🚀 Executing: ${folder}/${scriptName} ...\n`);

        // Use require() for dynamic loading or dynamic import()
        const module = await import(scriptPath.endsWith('.ts') ? scriptPath : scriptPathJS);

        // Find the "main" function or whatever is exported. 
        // We'll look for a default export or a specifically named export that matches the filename or "run" or "main"
        const runner = module.default || module.main || module.run || Object.values(module).find(v => typeof v === 'function');

        if (typeof runner !== 'function') {
            console.error(`❌ Error: No executable function found in ${scriptName}. Make sure to export a function.`);
            return;
        }

        // Execute with remaining arguments
        await runner(...remainingArgs);

    } catch (err) {
        console.error(`❌ Execution failed:`, err);
        process.exit(1);
    }
}

function listAvailableScripts(folder: string) {
    const dirPath = path.join(__dirname, folder);
    if (!fs.existsSync(dirPath)) {
        console.log("  (Folder not found)");
        return;
    }
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
    files.forEach(f => console.log(`  - ${f.replace(/\.(ts|js)$/, '')}`));
}

function printUsage() {
    console.log("\n📖  Usage:");
    console.log("  npm run dev <folder> <script-name> [...args]");
    console.log("\nExamples:");
    console.log("  npm run dev jobs sync-pools-to-db");
    console.log("  npm run dev entries arbitrage So1111... EPjFW...");
    console.log("");
}

main().catch((err) => {
    console.error("Fatal Error:", err);
    process.exit(1);
});
