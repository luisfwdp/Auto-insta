import { describe, expect, it } from "vitest";
import { monthDays, publicationIsInMonth } from "@/components/publishing/programming-workspace";

describe("publishing calendar navigation", () => {
  it("builds the selected month instead of fixing the calendar to today", () => {
    const days = monthDays(new Date(2032, 1, 1));
    expect(days.filter((day) => day !== null)).toHaveLength(29);
    expect(days.at(-1)).toBe(29);
  });

  it("does not show publications from the same month in another year", () => {
    expect(publicationIsInMonth("2031-02-10T12:00:00.000Z", new Date(2031, 1, 1))).toBe(true);
    expect(publicationIsInMonth("2032-02-10T12:00:00.000Z", new Date(2031, 1, 1))).toBe(false);
  });
});
