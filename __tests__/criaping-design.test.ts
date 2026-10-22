import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isFeatureEnabled } from "../lib/feature-flags";

vi.mock("next/font/local", () => ({
  default: ({ variable }: { variable: string }) => ({ variable }),
}));
vi.mock("@vercel/analytics/next", () => ({ Analytics: () => null }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("404"); } }));

afterEach(() => vi.unstubAllEnvs());

describe("CRIA PING opt-in boundary", () => {
  it.each(["", "-newDesign", "unknownFlag"])("preserves legacy root and hides preview for %s", async (flags) => {
    vi.stubEnv("FEATURE_FLAGS", flags);
    const { default: Layout } = await import("../app/layout");
    const { default: Preview } = await import("../app/design-system/page");
    const html = renderToStaticMarkup(Layout({ children: "legacy" }));
    expect(html).toContain('<html lang="en" class="h-full dark">');
    expect(html).not.toContain("data-design");
    expect(html).not.toContain("--font-criaping");
    expect(Preview).toThrow("404");
  });

  it("enables tokens and the review page only with newDesign", async () => {
    vi.stubEnv("FEATURE_FLAGS", "newDesign");
    const { default: Layout } = await import("../app/layout");
    const { default: Preview } = await import("../app/design-system/page");
    const html = renderToStaticMarkup(Layout({ children: createElement(Preview) }));
    expect(isFeatureEnabled("newDesign")).toBe(true);
    expect(html).toContain('data-design="criaping"');
    expect(html).toContain("--font-criaping-sora");
    expect(html).toContain('lang="pt-BR"');
    expect(html).toContain("/brand/criaping/logo-horizontal.svg");
  });
});

const css = readFileSync(new URL("../app/criaping-tokens.css", import.meta.url), "utf8");
function token(name: string): string {
  const value = css.match(new RegExp(`--cp-${name}:\\s*([^;]+);`))?.[1];
  if (!value) throw new Error(`Unknown color token: ${name}`);
  const alias = value.match(/^var\(--cp-([\w-]+)\)$/);
  return alias ? token(alias[1]) : value;
}
function luminance(hex: string): number {
  const rgb = hex.slice(1).match(/../g)!.map((v) => {
    const c = parseInt(v, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(token(a)), luminance(token(b))].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("WCAG AA token pairings", () => {
  for (const surface of ["background", "surface", "surface-hover"]) {
    it.each(["text", "text-muted", "success", "error", "warning", "info"])(`%s text on ${surface}`, (foreground) => {
      expect(contrast(foreground, surface)).toBeGreaterThanOrEqual(4.5);
    });
    it(`control border and focus on ${surface}`, () => {
      expect(contrast("control-border", surface)).toBeGreaterThanOrEqual(3);
      expect(contrast("focus", surface)).toBeGreaterThanOrEqual(3);
    });
  }
  it.each(["action", "action-hover", "action-pressed"])("black text on %s", (background) => {
    expect(contrast("on-action", background)).toBeGreaterThanOrEqual(4.5);
  });
});
