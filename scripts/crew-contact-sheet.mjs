// Renders docs/crew-variants-contact-sheet.png: every crew character (base designs and the
// Feature 09 variants) in both art styles, at kitchen scale, at 4× and as a roster portrait.
//
//   node scripts/crew-contact-sheet.mjs [out.png]
//
// The sheet is painted by the app's own code (scripts/crew-contact-sheet.page.ts imports the
// backends, sprites and portrait painter from src/galley). esbuild bundles that page, a headless
// Chrome runs it once from a temp folder and exits; no server is started. Set CHROME_BIN when
// Chrome is not at the macOS default path.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(ROOT, "docs", "crew-variants-contact-sheet.png"));
const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chrome)) {
  console.error(`No Chrome at ${chrome}. Set CHROME_BIN to a Chrome or Chromium binary.`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "crew-sheet-"));
try {
  await build({
    entryPoints: [join(ROOT, "scripts", "crew-contact-sheet.page.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    outfile: join(dir, "page.js"),
    logLevel: "warning",
  });
  writeFileSync(join(dir, "index.html"), '<!doctype html><meta charset="utf-8"><body><script src="page.js"></script></body>');
  const dom = execFileSync(
    chrome,
    ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${join(dir, "profile")}`, "--dump-dom", pathToFileURL(join(dir, "index.html")).href],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );
  const png = /data-png="data:image\/png;base64,([^"]+)"/.exec(dom)?.[1];
  if (!png) throw new Error("The page produced no PNG (see scripts/crew-contact-sheet.page.ts).");
  writeFileSync(out, Buffer.from(png, "base64"));
  console.log(`wrote ${out}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
