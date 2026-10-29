// Requires the temporary fixture from prepare-instagram-accounts-review.mjs.
// All API data is intercepted locally; no production API or mutation is used.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(
  path.join(
    process.env.CRIAPING_BROWSER_TOOLS || "/tmp/criaping-browser/node_modules",
    "review.cjs",
  ),
);
const { chromium } = require("playwright");
const { default: AxeBuilder } = require("@axe-core/playwright");
const base = process.env.CRIAPING_REVIEW_URL || "http://127.0.0.1:3000";
const output = "docs/criaping/instagram-accounts-screenshots";
await mkdir(output, { recursive: true });

const accounts = [
  {
    id: "ig-1",
    username: "creator_lab",
    instagramId: "17840000000000001",
    name: "Creator Lab",
    provider: "META",
    tokenExpiresAt: "2026-12-20T12:00:00.000Z",
    webhookSubscribed: true,
  },
  {
    id: "ig-2",
    username: "escola_criativa",
    instagramId: "17840000000000002",
    name: "Escola Criativa",
    provider: "META",
    tokenExpiresAt: null,
    webhookSubscribed: false,
  },
];

const report = [];
const browser = await chromium.launch({ args: ["--no-sandbox"] });

async function audit(page) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "horizontal overflow",
  );
  const result = await new AxeBuilder({ page })
    .include("main")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  assert.deepEqual(
    result.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map(({ target }) => target),
    })),
    [],
  );
}

async function screenshot(page, name, device) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `${output}/${name}-${device}.jpg`,
    type: "jpeg",
    quality: 82,
    fullPage: true,
    animations: "disabled",
    style: "nextjs-portal{display:none!important}",
  });
}

try {
  for (const [device, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["tablet", { width: 820, height: 1180 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    const mutations = [];
    let statsScenario = "connected";
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());

    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== "GET") {
        mutations.push({ method: request.method(), path: url.pathname });
        if (url.pathname === "/api/instagram/disconnect") {
          return route.fulfill({
            status: 409,
            json: { success: false, error: "Fixture rejected" },
          });
        }
        throw new Error(`Unexpected mutation: ${request.method()} ${url.pathname}`);
      }

      if (url.pathname === "/api/dashboard/stats") {
        if (statsScenario === "session") {
          return route.fulfill({
            status: 401,
            json: { success: false, error: "Fixture unauthorized" },
          });
        }
        return route.fulfill({
          json: {
            success: true,
            data: {
              workspace: { name: "Creator Lab", dmsSentThisPeriod: 12 },
              instagramAccount:
                statsScenario === "empty" ? null : accounts[0],
              instagramAccounts:
                statsScenario === "empty" ? [] : accounts,
            },
          },
        });
      }
      if (url.pathname === "/api/workspace/members") {
        return route.fulfill({
          json: {
            success: true,
            data: {
              currentUserRole: "OWNER",
              members: [],
              invitations: [],
            },
          },
        });
      }
      if (url.pathname === "/api/zernio/settings") {
        return route.fulfill({
          json: {
            success: true,
            data: { configured: false, profiles: [], accounts: [] },
          },
        });
      }
      throw new Error(`Unexpected read: ${url.pathname}`);
    });

    const visit = (count = 2) =>
      page.goto(`${base}/design-system/instagram-accounts-review?count=${count}`);

    statsScenario = "connected";
    await visit(2);
    await page.getByRole("heading", { name: "Contas do Instagram" }).waitFor();
    await audit(page);
    await screenshot(page, "connected", device);
    assert.match(
      await page
        .getByRole("link", { name: "Criar campanha" })
        .first()
        .getAttribute("href"),
      /instagramAccountId=ig-1/,
    );

    statsScenario = "empty";
    await visit(0);
    await page.getByText("Nenhuma conta do Instagram conectada").waitFor();
    await audit(page);
    await screenshot(page, "empty", device);

    statsScenario = "session";
    await visit(0);
    await page.getByRole("link", { name: "Entrar novamente" }).waitFor();
    await audit(page);
    await screenshot(page, "session-expired", device);

    if (device === "desktop") {
      statsScenario = "connected";
      await visit(2);
      await page
        .getByRole("button", { name: "Desconectar", exact: true })
        .first()
        .click();
      await page.getByText("A operação foi recusada.", { exact: false }).waitFor();
      await audit(page);
      await screenshot(page, "operation-refused", device);
    }

    assert.deepEqual(errors, []);
    assert.deepEqual(
      mutations.filter(({ path }) => path !== "/api/instagram/disconnect"),
      [],
    );
    report.push({
      device,
      axe: "passed",
      overflow: false,
      pageErrors: errors,
      mockedMutations: mutations,
    });
    await context.close();
  }
} finally {
  await browser.close();
}

await writeFile(`${output}/checks.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
