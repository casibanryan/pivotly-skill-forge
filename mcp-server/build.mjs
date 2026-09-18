/**
 * Bundles the MCP server into a single dependency-free file at dist/index.js.
 *
 * Why bundle rather than just `tsc`: the plugin is distributed by syncing/cloning this
 * repo, and `node_modules/` is gitignored. Plain tsc output still carries
 * `import ... from "@modelcontextprotocol/sdk/..."`, so on a fresh sync Node cannot
 * resolve it and the server dies at startup with ERR_MODULE_NOT_FOUND — the host reports
 * only that the connection closed, and every forge_* tool silently disappears.
 *
 * Bundling inlines the SDK and zod, so the committed dist/index.js runs on any machine
 * with Node 18+ and nothing installed. That is what makes the plugin zero-install.
 *
 * Run: npm run build   (typechecks with tsc, then bundles here)
 */

import { build, context } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outfile = join(root, "dist", "index.js");
const watch = process.argv.includes("--watch");

/**
 * Some transitive dependencies are CommonJS and expect `require` / `__dirname` to exist.
 * An ESM bundle has neither, so recreate them at the top of the output.
 */
const banner = [
  'import { createRequire as __skillForgeCreateRequire } from "node:module";',
  'import { fileURLToPath as __skillForgeFileURLToPath } from "node:url";',
  'import { dirname as __skillForgeDirname } from "node:path";',
  "const require = __skillForgeCreateRequire(import.meta.url);",
  "const __filename = __skillForgeFileURLToPath(import.meta.url);",
  "const __dirname = __skillForgeDirname(__filename);",
].join("\n");

const options = {
  entryPoints: [join(root, "src", "index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  banner: { js: banner },
  legalComments: "none",
  logLevel: "info",
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[build] watching src/ …");
} else {
  await build(options);
  const bytes = readFileSync(outfile).byteLength;

  // Fail loudly if anything survived as an unresolved bare import: that would reintroduce
  // the exact ERR_MODULE_NOT_FOUND this bundle exists to prevent.
  const source = readFileSync(outfile, "utf8");
  const bare = [...source.matchAll(/^\s*(?:import|export)[^;]*?from\s*["']([^"'.][^"']*)["']/gm)]
    .map((m) => m[1])
    .filter((spec) => !spec.startsWith("node:"));
  if (bare.length) {
    console.error(`[build] FAILED — unbundled runtime imports remain: ${[...new Set(bare)].join(", ")}`);
    process.exit(1);
  }

  console.log(`[build] dist/index.js — ${(bytes / 1024).toFixed(0)} KB, no runtime dependencies`);
}
