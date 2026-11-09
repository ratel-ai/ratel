// The visible text of a list of pages, read with the installed Chrome (temporary parity harness,
// RTL-45; from the platform split audit).
//
//   node page-text.mjs <puppeteer dir> <base url> <out dir> <prefix> <name=/path> [...]
//
// `<puppeteer dir>` is a folder with puppeteer-core installed: it is not a dependency of this
// repository, side-by-side.sh installs it in its work folder.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [browserDir, base, outDir, prefix, ...pages] = process.argv.slice(2);
const puppeteer = createRequire(join(browserDir, "package.json"))("puppeteer-core");
const chrome = process.env.PARITY_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({ executablePath: chrome, headless: "new", args: ["--window-size=1440,1000"] });
for (const spec of pages) {
  const name = spec.slice(0, spec.indexOf("="));
  const path = spec.slice(spec.indexOf("=") + 1);
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  let status = 0;
  let text = "";
  try {
    const response = await page.goto(base + path, { waitUntil: "networkidle2", timeout: 120000 });
    status = response?.status() ?? 0;
    // Lazily loaded parts (the freshness line, the tour) arrive after the first paint.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    text = await page.evaluate(() => document.body.innerText);
  } catch (error) {
    text = `NAVIGATION FAILED ${String(error).slice(0, 200)}`;
  }
  writeFileSync(join(outDir, `${prefix}${name}.txt`), `STATUS ${status}\nTITLE ${await page.title().catch(() => "")}\n\n${text}\n`);
  console.log(`${prefix}${name} ${status} ${path}`);
  await page.close();
}
await browser.close();
