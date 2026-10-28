// Requires temporary fixture prepared by prepare-campaign-review.mjs; never production.
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
const require = createRequire(path.join(process.env.CRIAPING_BROWSER_TOOLS || "/tmp/criaping-browser/node_modules", "review.cjs"));
const { chromium } = require("playwright");
const { default: AxeBuilder } = require("@axe-core/playwright");
const pt = JSON.parse(await readFile("lib/i18n/pt-BR.json", "utf8"));
const t = (key) => pt[key] || key;
const enabled = process.argv[2] !== "off";
const base = process.env.CRIAPING_REVIEW_URL || "http://localhost:3000";
const output = "docs/criaping/campaign-screenshots";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const accounts = [{ id: "a1", username: "creator_one", instagramId: "11" }, { id: "a2", username: "creator_two", instagramId: "22" }];
function campaign(id, account, active = true) {
  return { id, name: id === "c1" ? "Material para criadores" : "Guia de conteúdo", instagramAccountId: account.id, instagramAccount: account, isActive: active,
    keywords: ["link"], dmMessage: "Seu material está aqui {link}", postId: "p1", postUrl: "https://www.instagram.com/p/test/", matchAnyPost: false, pendingNextReel: false, matchAnyWord: false, dmTriggerEnabled: false,
    openingDmEnabled: false, openingDmMessage: null, openingDmButtonLabel: null, publicReplyEnabled: false, publicReplyMessages: [], publicReplyMessage: null, requireFollow: false, followUpEnabled: false,
    reportUrl: "/reports/test-report", reportShareEnabled: true, _count: { dmLogs: 3 }, trackedLinks: [{ id: "l1", destinationUrl: "https://example.org", label: "Material", trackedUrl: "https://example.org/r/test" }],
    analytics: { sent: 2, clicks: 1, ctr: 50, failed: 0, skipped: 1, topKeywords: [] } };
}
const results = [];
async function audit(page) {
  const result = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  assert.deepEqual(result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((n) => ({ target: n.target, html: n.html, reason: n.failureSummary })) })), []);
}
async function shot(page, name, device) { await page.evaluate(() => document.fonts.ready); await page.locator("main").evaluate((el) => { el.scrollTop = 0; }); await page.screenshot({ style: "nextjs-portal{display:none!important}", path: `${output}/${name}-${device}.jpg`, type: "jpeg", quality: 80, fullPage: true }); }
try {
 for (const [device, viewport] of [["desktop", { width: 1440, height: 1000 }], ["tablet", { width: 820, height: 1180 }], ["mobile", { width: 390, height: 844 }]]) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let rows = [campaign("c1", accounts[0]), campaign("c2", accounts[1], false)];
  let failAction = false, failList = false, failSave = false, noAccounts = false;
  const mutations = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url());
    const success = (data) => route.fulfill({ json: { success: true, data } });
    if (req.method() !== "GET") {
      mutations.push({ path: url.pathname, id: url.searchParams.get("id"), method: req.method(), body: req.postDataJSON() });
      if (failAction || failSave) return route.fulfill({ status: 403, json: { success: false, error: "Fixture rejected" } });
      const id = url.searchParams.get("id");
      if (url.pathname === "/api/automations/duplicate") { const source = rows.find((c) => c.id === id); const copy = { ...source, id: "copy", name: `${source.name} copy`, isActive: false }; rows.push(copy); return success(copy); }
      if (url.pathname !== "/api/automations") throw Error(`Unexpected mutation: ${url.pathname}`);
      if (req.method() === "DELETE") { rows = rows.filter((c) => c.id !== id); return success({}); }
      if (req.method() === "PATCH") { rows = rows.map((c) => c.id === id ? { ...c, ...req.postDataJSON() } : c); return success(rows.find((c) => c.id === id)); }
      return route.fulfill({ status: 201, json: { success: true, data: { id: "created", ...req.postDataJSON() } } });
    }
    if (url.pathname === "/api/dashboard/stats") return success({ instagramAccounts: noAccounts ? [] : accounts, selectedInstagramAccountId: null });
    if (url.pathname === "/api/automations") {
      if (failList) return route.fulfill({ status: 503, json: { success: false } });
      const selected = url.searchParams.get("instagramAccountId");
      return success(rows.filter((c) => !selected || c.instagramAccountId === selected));
    }
    if (url.pathname === "/api/instagram/profile") return success({ profilePictureUrl: null });
    if (url.pathname === "/api/instagram/posts") { const account = url.searchParams.get("instagramAccountId") || "a1"; return success([{ id: account === "a1" ? "p1" : "p2", media_type: "IMAGE", media_url: "/brand/criaping/symbol.svg", caption: `Publicação de teste ${account}`, permalink: "https://www.instagram.com/p/test/", timestamp: "2026-01-01T00:00:00Z" }]); }
    throw Error(`Unexpected read: ${url.pathname}`);
  });
  // Saving may navigate to the protected list. This fixture does not bypass auth.
  await page.route((url) => url.origin === base && url.pathname === "/campaigns", (route) => route.fulfill({ contentType: "text/html", body: "<title>Fixture destination</title><main>Navigation observed after confirmed save</main>" }));
  const visit = (screen) => page.goto(`${base}/design-system/campaign-review?screen=${screen}`);
  if (!enabled) {
    for (const screen of ["list", "new"]) {
      await visit(`baseline-${screen}`);
      await page.getByText(screen === "list" ? "Material para criadores" : t("When someone comments on"), { exact: true }).first().waitFor();
      await page.waitForLoadState("networkidle");
      await page.locator("main").evaluate((el) => { el.scrollTop = 0; });
      const baseline = await page.screenshot({ fullPage: true, animations: "disabled", style: "nextjs-portal{display:none!important}" });
      await visit(screen);
      await page.getByText(screen === "list" ? "Material para criadores" : t("When someone comments on"), { exact: true }).first().waitFor();
      await page.waitForLoadState("networkidle");
      await page.locator("main").evaluate((el) => { el.scrollTop = 0; });
      const current = await page.screenshot({ fullPage: true, animations: "disabled", style: "nextjs-portal{display:none!important}" });
      await writeFile(`/tmp/criaping-baseline-${screen}-${device}.png`, baseline);
      await writeFile(`/tmp/criaping-current-${screen}-${device}.png`, current);
      const comparison = JSON.parse(execFileSync("python", ["-c", `from PIL import Image, ImageChops
import json,sys
left=Image.open(sys.argv[1]).convert("RGB"); right=Image.open(sys.argv[2]).convert("RGB")
assert left.size==right.size
diff=ImageChops.difference(left,right)
print(json.dumps({"maxChannelDifference":max(v[1] for v in diff.getextrema())}))`, `/tmp/criaping-baseline-${screen}-${device}.png`, `/tmp/criaping-current-${screen}-${device}.png`], { encoding: "utf8" }));
      // Only tolerate 1/255 SVG antialiasing variation; layout/color changes fail.
      assert.ok(comparison.maxChannelDifference <= 1, `Legacy ${screen} changed: ${JSON.stringify(comparison)}`);
      await shot(page, `legacy-${screen}`, device);
    }
    assert.equal(mutations.length, 0);
  } else {
    await visit("list");
    const card = page.getByRole("region", { name: "Material para criadores", exact: true });
    // Card is a labelled section, exposed as region.
    await card.waitFor(); await audit(page); await shot(page, "campaigns", device);
    assert.equal(await page.getByRole("link", { name: t("View report"), exact: true }).first().getAttribute("href"), "/campaigns/c1");
    await page.getByLabel(t("Search campaigns"), { exact: true }).fill("no-match");
    await page.getByText(t("No campaigns match your search."), { exact: true }).waitFor();
    await page.getByLabel(t("Search campaigns"), { exact: true }).fill("");
    await page.getByLabel(t("Status"), { exact: true }).selectOption("paused");
    assert.equal(await page.getByRole("region", { name: "Material para criadores" }).count(), 0);
    await page.getByLabel(t("Status"), { exact: true }).selectOption("all");
    failAction = true;
    await card.getByRole("button", { name: t("Pause"), exact: true }).click();
    await page.getByText(t("Campaign action failed. Nothing was confirmed. Please try again."), { exact: true }).waitFor();
    assert.equal(await card.getByRole("button", { name: t("Pause"), exact: true }).count(), 1);
    failAction = false;
    await card.getByRole("button", { name: t("Pause"), exact: true }).click();
    await card.getByRole("button", { name: t("Activate"), exact: true }).waitFor();
    await card.getByRole("button", { name: t("Duplicate"), exact: true }).click();
    await page.getByRole("region", { name: "Material para criadores copy", exact: true }).waitFor();
    await card.getByRole("button", { name: t("Delete"), exact: true }).click();
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog").count(), 0);
    await card.getByRole("button", { name: t("Delete"), exact: true }).click();
    await page.getByRole("button", { name: t("Confirm deletion"), exact: true }).click();
    await card.waitFor({ state: "hidden" });
    assert.equal(mutations.filter((m) => m.method === "DELETE").length, 1);
    await page.getByRole("combobox", { name: t("Instagram account"), exact: true }).selectOption("a2");
    await page.getByRole("region", { name: "Guia de conteúdo", exact: true }).waitFor();
    assert.match(await page.getByRole("link", { name: t("New Campaign"), exact: true }).getAttribute("href"), /instagramAccountId=a2/);
    if (device === "desktop") {
      failList = true; await visit("list"); await page.getByText(t("Campaigns unavailable"), { exact: true }).waitFor(); await shot(page, "campaigns-error", device);
      failList = false; rows = []; await page.getByRole("button", { name: t("Try again"), exact: true }).click(); await page.getByText(t("No campaigns yet"), { exact: true }).waitFor(); await shot(page, "campaigns-empty", device);
      noAccounts = true; await visit("list"); await page.getByText(t("Connect Instagram"), { exact: true }).first().waitFor(); noAccounts = false;
    }
    rows = [campaign("c1", accounts[0]), campaign("c2", accounts[1], false)];
    mutations.length = 0;
    await visit("new");
    await page.getByLabel(t("Campaign name"), { exact: true }).fill("Primeira automação");
    await page.getByRole("button", { name: /Publicação de teste a1/ }).click();
    await page.getByLabel(t("Instagram account"), { exact: true }).selectOption("a2");
    await page.getByLabel(t("Keywords"), { exact: true }).fill("link, preco");
    await page.getByRole("button", { name: t("Continue"), exact: true }).click();
    await page.getByText(t("Pick a post or reel to trigger the campaign."), { exact: true }).waitFor();
    await page.getByRole("button", { name: /Publicação de teste a2/ }).click();
    await audit(page); await shot(page, "wizard-configuration", device);
    assert.equal(mutations.length, 0);
    await page.getByRole("button", { name: t("Continue"), exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.tagName === "H2");
    await page.getByLabel(t("reply to their comments under the post"), { exact: true }).check();
    await page.getByLabel(t("Public reply {number}").replace("{number}", "1"), { exact: true }).fill("Resposta pública de teste");
    await page.getByLabel(t("an opening DM"), { exact: true }).check();
    await page.getByLabel(t("Opening DM message"), { exact: true }).fill("Olá! Quer o material?");
    await page.getByLabel(t("Opening button label"), { exact: true }).fill("Quero receber");
    await page.getByLabel(t("Main DM message"), { exact: true }).fill("Olá {username}. Aqui está: {link}");
    await page.getByLabel(t("Include a tracked link"), { exact: true }).check();
    await page.getByLabel(t("Link URL"), { exact: true }).fill("https://example.org/material");
    await page.getByLabel(t("Include a second link"), { exact: true }).check();
    await page.getByLabel(t("Second link URL"), { exact: true }).fill("https://example.org/extra");
    await page.getByLabel(t("a follow requirement first"), { exact: true }).check();
    await page.getByLabel(t("Follow prompt message"), { exact: true }).fill("Siga a conta para continuar.");
    await page.getByLabel(t("a follow-up thank-you message"), { exact: true }).check();
    await page.getByLabel(t("Follow-up message"), { exact: true }).fill("Obrigado por acompanhar!");
    await page.getByLabel(t("Follow-up delay in minutes"), { exact: true }).fill("15");
    await audit(page); await shot(page, "wizard-messages", device);
    await page.getByRole("button", { name: t("Continue"), exact: true }).click();
    await page.getByRole("heading", { name: t("Review campaign settings"), exact: true }).waitFor();
    await page.getByLabel(t("Activate after confirmation"), { exact: true }).focus();
    await page.keyboard.press("Space");
    assert.equal(await page.getByLabel(t("Activate after confirmation"), { exact: true }).isChecked(), false);
    await audit(page); await shot(page, "wizard-review", device);
    assert.equal(mutations.length, 0, "Draft created a server write before confirmation");
    await page.getByRole("button", { name: t("Back"), exact: true }).click();
    assert.equal(await page.getByLabel(t("Main DM message"), { exact: true }).inputValue(), "Olá {username}. Aqui está: {link}");
    await page.getByRole("button", { name: t("Continue"), exact: true }).click();
    failSave = true;
    await page.getByRole("button", { name: t("Confirm campaign"), exact: true }).click();
    await page.getByText(t("Could not save the campaign. Check the settings and try again."), { exact: true }).waitFor();
    assert.equal(mutations.length, 1);
    const payload = mutations[0].body;
    assert.equal(payload.instagramAccountId, "a2"); assert.equal(payload.postId, "p2");
    assert.deepEqual(payload.keywords, ["link", "preco"]); assert.equal(payload.isActive, false);
    assert.equal(payload.publicReplyEnabled, true); assert.deepEqual(payload.publicReplyMessages, ["Resposta pública de teste"]);
    assert.equal(payload.openingDmEnabled, true); assert.equal(payload.requireFollow, true);
    assert.equal(payload.followUpDelayMinutes, 15); assert.equal(payload.secondaryDestinationUrl, "https://example.org/extra");
    failSave = false;
    await page.getByRole("button", { name: t("Confirm campaign"), exact: true }).click();
    await page.waitForURL(`${base}/campaigns?instagramAccountId=a2`);
    assert.equal(mutations.length, 2); assert.deepEqual(mutations[1].body, payload);
    // Edit uses the existing PATCH contract and never pretends the account is mutable.
    await visit("edit");
    const selectedAccount = page.getByLabel(t("Instagram account"), { exact: true });
    await selectedAccount.waitFor(); assert.equal(await selectedAccount.isDisabled(), true); assert.equal(await selectedAccount.inputValue(), "a1");
  }
  assert.deepEqual(errors, []);
  results.push({ device, enabled, keyboardAndActions: "passed", pageErrors: errors, evidence: "temporary local fixture with intercepted API responses; no real sends or database writes" });
  await context.close();
 }
} finally { await browser.close(); }
await writeFile(`${output}/checks-${enabled ? "on" : "off"}.json`, JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results));
