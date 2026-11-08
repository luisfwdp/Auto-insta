import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("session and diagnostics UX", () => {
  it("offers an explicit sign-out action with pending feedback", async () => {
    const source = await readFile("components/logout-button.tsx", "utf8");
    expect(source).toContain('signOut({ callbackUrl: "/login" })');
    expect(source).toContain('type="button"');
    expect(source).toContain('aria-busy={pending || undefined}');
    expect(source).toContain('t("Sign out")');
  });

  it("always leaves the diagnostics loading state and exposes a retry", async () => {
    const source = await readFile("app/(dashboard)/diagnostics/page.tsx", "utf8");
    expect(source).toContain("} finally {");
    expect(source).toContain("if (active) setLoading(false);");
    expect(source).toContain('role="alert"');
    expect(source).toContain('t("Try again")');
    expect(source).toContain('aria-label={t("Loading diagnostics")}');
  });
});
