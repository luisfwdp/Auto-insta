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

  it("keeps leap years and the Sunday-first weekday columns aligned", () => {
    expect(monthDays(new Date(2026, 10, 18))[0]).toBe(1);
    const days = monthDays(new Date(2027, 1, 1));
    expect(days[0]).toBeNull();
    expect(days[1]).toBe(1);
    expect(days.filter(day => day !== null)).toHaveLength(28);
  });

  it("uses local dates at midnight boundaries, including December to January", () => {
    const localMidnight = new Date(2031, 11, 31, 23, 59).toISOString();
    expect(publicationIsInMonth(localMidnight, new Date(2031, 11, 1))).toBe(true);
    expect(publicationIsInMonth(localMidnight, new Date(2032, 0, 1))).toBe(false);
    expect(publicationIsInMonth("invalid", new Date(2031, 11, 1))).toBe(false);
  });
});
