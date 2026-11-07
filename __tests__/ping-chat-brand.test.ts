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
    expect(html).toContain("PING <em>CHAT</em>");
    expect(html).toContain("by Creator Lab School");
    expect(html).toContain("não publicada");
    expect(html).toContain("Sidebar");
    expect(html).toContain("Login");
    expect(html).toContain("Dashboard");
    for (const file of ["symbol.svg", "symbol-16.svg", "favicon.svg", "logo-horizontal.svg", "logo-horizontal-on-light.svg", "logo-compact.svg", "logo-monochrome-light.svg", "logo-monochrome-dark.svg"]) {
      expect(readFileSync(new URL(`../public/brand/ping-chat/${file}`, import.meta.url), "utf8")).toContain("<svg");
    }
  });

  it("uses dedicated optical masters and explicit surface variants", () => {
    const small = readFileSync(new URL("../public/brand/ping-chat/symbol-16.svg", import.meta.url), "utf8");
    const favicon = readFileSync(new URL("../public/brand/ping-chat/favicon.svg", import.meta.url), "utf8");
    expect(small).toContain('viewBox="0 0 16 16"');
    expect(favicon).toContain('viewBox="0 0 32 32"');
    expect(small.match(/<path/g)).toHaveLength(2);
    expect(favicon.match(/<path/g)).toHaveLength(3);
    expect(readFileSync(new URL("../public/brand/ping-chat/logo-horizontal-on-light.svg", import.meta.url), "utf8")).toContain("#0B0B0B");
    expect(readFileSync(new URL("../public/brand/ping-chat/logo-horizontal.svg", import.meta.url), "utf8")).toContain("#F5F5F5");
  });

  it("keeps the approved font licenses versioned and contrast-safe", () => {
    for (const file of ["Sora-OFL.txt", "Inter-OFL.txt"]) {
      expect(readFileSync(new URL(`../app/fonts/criaping/${file}`, import.meta.url), "utf8")).toContain("SIL Open Font License, Version 1.1");
    }
    const luminance = (hex: string) => {
      const values = hex.match(/../g)!.map((part) => { const value = parseInt(part, 16) / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; });
      return .2126 * values[0] + .7152 * values[1] + .0722 * values[2];
    };
    const contrast = (a: string, b: string) => { const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (light + .05) / (dark + .05); };
    expect(contrast("F5F5F5", "0B0B0B")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("0B0B0B", "C7FF2F")).toBeGreaterThanOrEqual(4.5);
  });

  it("applies the approved identity to the public landing and legacy product surfaces", () => {
    const landing = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
    const landingCss = readFileSync(new URL("../app/landing.css", import.meta.url), "utf8");
    const tokens = readFileSync(new URL("../app/criaping-tokens.css", import.meta.url), "utf8");

    expect(landing).toContain("/brand/ping-chat/logo-horizontal.svg");
    expect(landing).toContain("Conversa que ativa.");
    expect(landing).not.toContain("OpenReply");
    expect(landingCss).toContain("--or-orange: #c7ff2f");
    expect(landingCss).toContain("--or-paper: #0b0b0b");
    expect(tokens).toContain("--color-surface: var(--cp-surface)");
    expect(tokens).toContain('[data-design="criaping"] .zernio-sponsor');
  });
});
