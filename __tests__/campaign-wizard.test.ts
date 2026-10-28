import { describe, expect, it } from "vitest";
import { validateCampaignDraft, type CampaignDraft } from "../components/campaign-validation";

const draft: CampaignDraft = {
  selectedAccountId: "account-1", triggerScope: "specific", postId: "post-1", matchMode: "specific", keywords: ["link"], name: "Campaign", dmMessage: "Here is your material",
  openingDmEnabled: false, openingDmMessage: "", openingDmButtonLabel: "", publicReplyEnabled: false, publicReplyMessages: [""],
  trackedDestinationUrl: "", secondaryDestinationUrl: "", linkButtonLabel: "Open", secondaryButtonLabel: "Second",
  requireFollow: false, followPromptMessage: "", followPromptButtonLabel: "Following", followUpEnabled: false, followUpMessage: "", followUpDelayMinutes: 0,
};
describe("campaign wizard preflight against existing API limits", () => {
  it("does not require messages before the configuration step is complete", () => {
    expect(validateCampaignDraft({ ...draft, dmMessage: "" }, 0)).toBeNull();
    expect(validateCampaignDraft({ ...draft, dmMessage: "" }, 1)).toBe("Add the DM with the link.");
  });
  it.each(["specific", "any", "next"] as const)("supports %s without inventing a new trigger", (scope) => {
    expect(validateCampaignDraft({ ...draft, triggerScope: scope, postId: scope === "specific" ? "post-1" : null })).toBeNull();
  });
  it("requires account, post when specific, and keywords unless matching any word", () => {
    expect(validateCampaignDraft({ ...draft, selectedAccountId: "" })).toBe("Connect an Instagram account first.");
    expect(validateCampaignDraft({ ...draft, postId: null })).toBe("Pick a post or reel to trigger the campaign.");
    expect(validateCampaignDraft({ ...draft, keywords: [] })).toBe("Add at least one keyword, or switch to any word.");
    expect(validateCampaignDraft({ ...draft, matchMode: "any", keywords: [] })).toBeNull();
  });
  it("checks keyword, name, message and opening button limits", () => {
    expect(validateCampaignDraft({ ...draft, keywords: Array(11).fill("link") })).not.toBeNull();
    expect(validateCampaignDraft({ ...draft, keywords: ["x".repeat(51)] })).not.toBeNull();
    expect(validateCampaignDraft({ ...draft, name: "x".repeat(101) })).not.toBeNull();
    expect(validateCampaignDraft({ ...draft, dmMessage: "x".repeat(1001) })).not.toBeNull();
    expect(validateCampaignDraft({ ...draft, openingDmEnabled: true })).toBe("Your opening DM needs a message and a button label.");
    expect(validateCampaignDraft({ ...draft, openingDmEnabled: true, openingDmMessage: "Hello", openingDmButtonLabel: "x".repeat(65) })).not.toBeNull();
  });
  it("validates both actual link destinations without requiring a link-only campaign", () => {
    expect(validateCampaignDraft(draft)).toBeNull();
    expect(validateCampaignDraft({ ...draft, trackedDestinationUrl: "https://example.org", secondaryDestinationUrl: "https://example.org/second" })).toBeNull();
    expect(validateCampaignDraft({ ...draft, secondaryDestinationUrl: "not a URL" })).toBe("Enter valid link URLs.");
    expect(validateCampaignDraft({ ...draft, linkButtonLabel: "x".repeat(21) })).not.toBeNull();
  });
  it("keeps optional follow settings compatible with existing server defaults", () => {
    expect(validateCampaignDraft({ ...draft, requireFollow: true, followPromptMessage: "" })).toBeNull();
    expect(validateCampaignDraft({ ...draft, followUpEnabled: true, followUpDelayMinutes: 1440 })).toBeNull();
    for (const value of [-1, 1441, 1.5, NaN]) expect(validateCampaignDraft({ ...draft, followUpEnabled: true, followUpDelayMinutes: value })).toBe("Follow-up delay must be between 0 and 1440 minutes.");
    expect(validateCampaignDraft({ ...draft, publicReplyEnabled: true, publicReplyMessages: Array(11).fill("Hi") })).not.toBeNull();
  });
  it("does not mutate the draft or persist anything", () => {
    const original = structuredClone(draft);
    validateCampaignDraft(draft);
    expect(draft).toEqual(original);
  });
});
