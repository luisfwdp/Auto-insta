import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../components/ui/primitives";
import { Input } from "../components/ui/fields";
import { DataTable } from "../components/ui/data-table";

vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined })) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("404"); } }));

describe("UI semantics", () => {
  it("prevents accidental submission and duplicate actions while loading", () => {
    const html = renderToStaticMarkup(createElement(Button, { loading: true }, "Save"));
    expect(html).toContain('type="button"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Save");
  });
  it("connects labels, errors and hints without dropping external descriptions", () => {
    const html = renderToStaticMarkup(createElement(Input, { id: "url", label: "URL", hint: "Help", error: "Invalid URL", "aria-describedby": "external", required: true }));
    expect(html).toContain('for="url"');
    expect(html).toContain('aria-describedby="external url-hint url-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('required=""');
    expect(html).toContain('id="url-error"');
  });
  it("exposes empty, loading and failed fetches without showing stale rows", () => {
    const props = { caption: "Examples", columns: [{ id: "name", header: "Name", cell: (row: { id: string }) => row.id, rowHeader: true }], rows: [{ id: "row" }], rowKey: (row: { id: string }) => row.id, emptyTitle: "Nothing here", loadingLabel: "Loading" };
    const ready = renderToStaticMarkup(DataTable(props));
    expect(ready).toContain('<caption>Examples</caption>');
    expect(ready).toContain('scope="row"');
    expect(renderToStaticMarkup(DataTable({ ...props, rows: [] }))).toContain("Nothing here");
    const loading = renderToStaticMarkup(DataTable({ ...props, loading: true }));
    expect(loading).toContain('role="status"');
    expect(loading).not.toContain("<table");
    const error = renderToStaticMarkup(DataTable({ ...props, error: "Fetch failed" }));
    expect(error).toContain('role="alert"');
    expect(error).not.toContain("<table");
  });
  it("gates the gallery before reading request cookies", async () => {
    vi.stubEnv("FEATURE_FLAGS", "-newDesign");
    try {
      const { default: Page } = await import("../app/design-system/components/page");
      const { cookies } = await import("next/headers");
      await expect(Page()).rejects.toThrow("404");
      expect(cookies).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
});
