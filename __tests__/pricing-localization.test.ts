import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveLocale } from "../lib/i18n";

const pricing = readFileSync(new URL("../app/pricing/page.tsx", import.meta.url), "utf8");
const switcher = readFileSync(new URL("../components/language-switcher.tsx", import.meta.url), "utf8");

describe("Portuguese-first pricing", () => {
  it("uses Brazilian Portuguese when no supported cookie is present", () => {
    expect(resolveLocale(undefined)).toBe("pt-BR");
    expect(resolveLocale("unsupported")).toBe("pt-BR");
  });

  it("publishes all early-access prices with a billing disclaimer", () => {
    expect(pricing).toContain('price:"R$ 29"');
    expect(pricing).toContain('price:"R$ 59"');
    expect(pricing).toContain('price:"R$ 129"');
    expect(pricing).toContain("A cobrança ainda não está ativa");
  });

  it("offers Portuguese and English in the visible language control", () => {
    expect(switcher).toContain('value="pt-BR"');
    expect(switcher).toContain('value="en"');
    expect(switcher).not.toContain('value="zh-TW"');
  });
});
