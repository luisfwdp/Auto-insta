// Optional tools: see docs/criaping/ui-components.md. No product dependencies.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const require = createRequire(process.env.CRIAPING_BROWSER_TOOLS ? path.join(process.env.CRIAPING_BROWSER_TOOLS, "review.cjs") : import.meta.url);
const { chromium } = require("playwright");
const { default: AxeBuilder } = require("@axe-core/playwright");
const enabled = process.argv[2] === "on";
const base = process.env.CRIAPING_REVIEW_URL || "http://localhost:3000";
const output = "docs/criaping/ui-screenshots";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const report = [];
async function audit(page) {
  // Locale changes stream metadata after the translated content.
  await page.waitForFunction(() => document.title.trim().length > 0);
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  assert.deepEqual(result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) })), []);
}
try {
  for (const [device, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    const mutations = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => { if (r.url().includes("/api/") && r.method() !== "GET") mutations.push(r.url()); });
    const response = await page.goto(`${base}/design-system/components`);
    assert.equal(response.status(), enabled ? 200 : 404);
    if (enabled) {
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.locator("h1").textContent(), "Biblioteca de componentes");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await audit(page);
      await page.screenshot({ path: `${output}/components-on-${device}.png`, fullPage: true });
      const toggle = page.getByRole("switch", { name: "Ativar exemplo", exact: true });
      await toggle.focus(); await page.keyboard.press("Space");
      assert.equal(await toggle.isChecked(), true);
      const trigger = page.getByRole("button", { name: "Abrir diálogo de exemplo" });
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      assert.equal(await page.getByLabel("Observação de exemplo").evaluate((el) => el === document.activeElement), true);
      await page.keyboard.press("Shift+Tab");
      assert.equal(await page.getByRole("button", { name: "Fechar exemplo", exact: true }).evaluate((el) => el === document.activeElement), true);
      await page.keyboard.press("Tab");
      await audit(page);
      await page.screenshot({ path: `${output}/dialog-on-${device}.png`, fullPage: true });
      for (let n = 0; n < 5; n++) {
        await page.keyboard.press("Tab");
        assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true);
      }
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
      assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
      await trigger.click(); await page.getByRole("button", { name: "Fechar exemplo", exact: true }).click();
      assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
      await page.getByRole("tab", { name: "Pronto", exact: true }).focus();
      for (const name of ["Estado de carregamento", "Estado vazio", "Erro", "Pronto"]) {
        await page.keyboard.press("ArrowRight");
        assert.equal(await page.getByRole("tab", { name, exact: true }).getAttribute("aria-selected"), "true");
      }
      await page.keyboard.press("End");
      assert.equal(await page.getByRole("tab", { name: "Erro", exact: true }).getAttribute("aria-selected"), "true");
      await page.keyboard.press("Home");
      await page.getByRole("button", { name: "Mostrar feedback de exemplo" }).click();
      assert.equal(await page.getByRole("status").filter({ hasText: "Exemplo salvo." }).count(), 1);
      await page.getByRole("button", { name: "Dispensar notificação" }).click();
      const name = page.getByLabel("Nome de exemplo", { exact: true });
      await name.fill("Rascunho de teste");
      await page.getByRole("button", { name: "Salvar exemplo", exact: true }).click();
      assert.equal(await page.getByRole("status").filter({ hasText: "Exemplo salvo." }).count(), 1);
      const language = page.locator("header select");
      for (const [locale, heading] of [["en", "Component library"], ["zh-TW", "元件庫"], ["pt-BR", "Biblioteca de componentes"]]) {
        await language.selectOption(locale);
        await page.getByRole("heading", { name: heading, exact: true }).waitFor();
        assert.equal(await page.locator('input[name="example-name"]').inputValue(), "Rascunho de teste");
        await audit(page);
      }
      assert.deepEqual(mutations, []);
    } else {
      assert.equal(await page.locator("html").getAttribute("data-design"), null);
      await page.screenshot({ path: `${output}/components-off-${device}.png`, fullPage: true });
    }
    await context.clearCookies();
    const fonts = [];
    page.on("request", (r) => { if (r.url().includes("woff2")) fonts.push(r.url()); });
    await page.goto(`${base}/login`);
    await page.waitForLoadState("networkidle");
    if (!enabled) assert.deepEqual(fonts, []);
    await page.screenshot({ path: `${output}/login-${enabled ? "on" : "off"}-${device}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    report.push({ device, enabled, status: response.status(), axe: enabled ? "passed, including dialog and locales" : "N/A", keyboard: enabled ? "passed" : "N/A", pageErrors: errors, mutations });
    await context.close();
  }
} finally { await browser.close(); }
await writeFile(`${output}/checks-${enabled ? "on" : "off"}.json`, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
