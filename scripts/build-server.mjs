// Bundles the HQ server into one ESM file for the npm package. node_modules
// stay external (installed as the package's runtime dependencies).
import { build } from "esbuild";

await build({
  entryPoints: { main: "server/main.ts", kitchen: "server/kitchen.ts" },
  outdir: "dist-server",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  sourcemap: false,
  logLevel: "warning",
});
console.log("built dist-server/main.mjs and dist-server/kitchen.mjs");
