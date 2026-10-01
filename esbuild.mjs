import { context } from "esbuild";

const args = new Set(process.argv.slice(2));

const production = args.has("--production");
const watch = args.has("--watch");

async function main() {
    const ctx = await context({
        entryPoints: ["src/extension.ts"],
        bundle: true,
        external: ["vscode"],
        outdir: "out",
        platform: "node",
        target: "node20",
        format: "cjs",
        sourcemap: !production,
        minify: production,
        logLevel: "info",
    });

    try {
        await ctx.rebuild();

        if (watch) {
            await ctx.watch();
            console.log("Watching for changes...");
        } else {
            await ctx.dispose();
        }
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
        await ctx.dispose();
    }

    const shutdown = async () => {
        await ctx.dispose();
        process.exit();
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
