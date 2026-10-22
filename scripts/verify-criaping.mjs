// Optional review tools, installed outside the application's dependencies.
// CRIAPING_BROWSER_TOOLS=/tmp/criaping-browser/node_modules node scripts/verify-criaping.mjs on
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const require = createRequire(process.env.CRIAPING_BROWSER_TOOLS
  ? path.join(process.env.CRIAPING_BROWSER_TOOLS, "review.cjs") : import.meta.url);
const { chromium } = require("playwright");
const { default: AxeBuilder } = require("@axe-core/playwright");
const enabled = process.argv[2] === "on";
const base = process.env.CRIAPING_REVIEW_URL || "http://localhost:3000";
const output = "docs/criaping/screenshots";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const results = [];
try {
  for (const [device, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const response = await page.goto(`${base}/design-system`);
    assert.equal(response.status(), enabled ? 200 : 404);
    if (enabled) {
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.locator("html").getAttribute("data-design"), "criaping");
      assert.equal(await page.locator("main").getAttribute("lang"), "pt-BR");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.keyboard.press("Tab");
      assert.equal(await page.locator("a:focus").textContent(), "Pular para os fundamentos");
      await page.keyboard.press("Enter");
      assert.equal(new URL(page.url()).hash, "#foundations");
      await page.goto(`${base}/design-system`);
      await page.evaluate(() => document.fonts.ready);
      const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      assert.deepEqual(audit.violations.map(({ id }) => id), []);
      await page.screenshot({ path: `${output}/tokens-on-${device}.png`, fullPage: true });
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(await page.locator("html").evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--cp-duration"))), 0);
      results.push({ device, preview: 200, axeViolations: 0, keyboard: "passed", overflow: false, reducedMotion: "passed", pageErrors: errors });
    } else {
      assert.equal(await page.locator("html").getAttribute("data-design"), null);
      assert.equal(await page.locator("html").evaluate((el) => getComputedStyle(el).getPropertyValue("--cp-background")), "");
      await page.screenshot({ path: `${output}/tokens-off-${device}.png`, fullPage: true });
      results.push({ device, preview: 404, tokens: "absent", pageErrors: errors });
    }
    // The operational/public migration has not started: verify legacy login
    // styling and that no new font binary is fetched with the flag off.
    const fonts = [];
    page.on("request", (request) => { if (/woff2/.test(request.url())) fonts.push(request.url()); });
    const login = await page.goto(`${base}/login`);
    assert.equal(login.status(), 200);
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(255, 255, 255)");
    if (!enabled) assert.deepEqual(fonts, []);
    await page.screenshot({ path: `${output}/login-${enabled ? "on" : "off"}-${device}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  await browser.close();
}
await writeFile(`${output}/verification-${enabled ? "on" : "off"}.json`, JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results));
