import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("404"); } }));
afterEach(() => vi.unstubAllEnvs());

describe("PING CHAT brand review", () => {
  it("stays unavailable while the visual-design flag is off", async () => {
    vi.stubEnv("FEATURE_FLAGS", "-newDesign");
    const { default: Page } = await import("../app/design-system/ping-chat/page");
    expect(Page).toThrow("404");
  });

  it("exposes review copy and editable SVG assets only behind the flag", async () => {
    vi.stubEnv("FEATURE_FLAGS", "newDesign");
    const { default: Page } = await import("../app/design-system/ping-chat/page");
    const html = renderToStaticMarkup(Page());
    expect(html).toContain("PING CHAT by Creator Lab School");
    expect(html).toContain("não publicada");
    for (const file of ["symbol.svg", "logo-horizontal.svg", "logo-compact.svg", "logo-monochrome.svg"]) {
      expect(readFileSync(new URL(`../public/brand/ping-chat/${file}`, import.meta.url), "utf8")).toContain("<svg");
    }
  });
});
