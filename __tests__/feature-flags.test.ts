import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FEATURE_FLAGS,
  getEnabledFeatureFlags,
  isFeatureEnabled,
} from "../lib/feature-flags";

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("feature flags", () => {
  it("uses each flag's default when FEATURE_FLAGS is unset", () => {
    vi.stubEnv("FEATURE_FLAGS", "");
    for (const [flag, { default: fallback }] of Object.entries(FEATURE_FLAGS)) {
      expect(isFeatureEnabled(flag as keyof typeof FEATURE_FLAGS)).toBe(fallback);
    }
  });

  it("keeps unfinished features off by default", () => {
    vi.stubEnv("FEATURE_FLAGS", "");
    expect(isFeatureEnabled("newDesign")).toBe(false);
    expect(isFeatureEnabled("commentsCenter")).toBe(false);
    expect(isFeatureEnabled("zernioIntegration")).toBe(true);
  });

  it("turns flags on by name and off with a leading minus", () => {
    vi.stubEnv("FEATURE_FLAGS", " newDesign , -zernioIntegration,contacts");
    expect(isFeatureEnabled("newDesign")).toBe(true);
    expect(isFeatureEnabled("contacts")).toBe(true);
    expect(isFeatureEnabled("zernioIntegration")).toBe(false);
    expect(isFeatureEnabled("reportsV2")).toBe(false);
  });

  it("ignores unknown and empty entries instead of failing", () => {
    vi.stubEnv("FEATURE_FLAGS", "removedFlag,,-alsoGone,commentsCenter");
    expect(isFeatureEnabled("commentsCenter")).toBe(true);
    expect(getEnabledFeatureFlags()).not.toHaveProperty("removedFlag");
  });

  it("lists every flag with its resolved value", () => {
    vi.stubEnv("FEATURE_FLAGS", "workspaceSwitcher");
    expect(getEnabledFeatureFlags()).toEqual({
      newDesign: false,
      workspaceSwitcher: true,
      commentsCenter: false,
      contacts: false,
      reportsV2: false,
      zernioIntegration: true,
    });
  });
});
