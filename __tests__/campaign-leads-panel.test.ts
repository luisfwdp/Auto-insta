import { describe, expect, it } from "vitest";
import { removeLeadFromPage } from "@/components/campaign-leads";

const contact = (id: string) => ({ id, name: "Contato de teste", email: "fixture@example.test", phone: "00000000", createdAt: "" });
const page = {
  leads: [contact("latest"), contact("prior-page"), contact("current-cursor")],
  links: [],
  nextCursor: "current-cursor",
};

describe("deleting a captured contact from a paginated list", () => {
  it("keeps rows from previously loaded pages and the current cursor", () => {
    const updated = removeLeadFromPage(page, "prior-page");
    expect(updated.leads.map(({ id }) => id)).toEqual(["latest", "current-cursor"]);
    expect(updated.nextCursor).toBe("current-cursor");
  });

  it("advances from a surviving row after the cursor contact is deleted", () => {
    const updated = removeLeadFromPage(page, "current-cursor");
    expect(updated.leads.map(({ id }) => id)).toEqual(["latest", "prior-page"]);
    expect(updated.nextCursor).toBe("prior-page");
  });

  it("can fetch again after removing the final loaded row when more contacts remain", () => {
    const loaded = { ...page, leads: [contact("current-cursor")] };
    expect(removeLeadFromPage(loaded, "current-cursor")).toMatchObject({
      leads: [], nextCursor: null, restartPagination: true,
    });
    expect(removeLeadFromPage({ ...loaded, nextCursor: null }, "current-cursor").restartPagination).toBeUndefined();
  });
});
