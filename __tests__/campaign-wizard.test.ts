import { describe, expect, it } from "vitest";
import { campaignTriggerFields, validateCampaignDraft, type CampaignDraft } from "../components/campaign-validation";
import { matchesStoryReplyScope } from "@/lib/automation/story-reply-scoping";

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
  it("maps a DM-only campaign to a keyword trigger with no post", () => {
    expect(campaignTriggerFields({ triggerScope: "dm", postId: "stale-post", postUrl: "https://www.instagram.com/reel/test/", dmTriggerEnabled: false })).toEqual({
      postId: null, postUrl: null, matchAnyPost: false, pendingNextReel: false, dmTriggerEnabled: true,
    });
    expect(validateCampaignDraft({ ...draft, triggerScope: "dm", postId: null }, 0)).toBeNull();
    expect(validateCampaignDraft({ ...draft, triggerScope: "dm", postId: null, matchMode: "any" }, 0)).toBe("Add at least one keyword for a DM-only campaign.");
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

  it("maps a Story selection to the existing API fields and the worker's exact Story scope", () => {
    const storyDraft = { ...draft, triggerScope: "story" as const, postId: "123456789", postUrl: "https://www.instagram.com/stories/creator_one/123456789/?utm_source=share" };
    expect(validateCampaignDraft(storyDraft)).toBeNull();
    const payload = campaignTriggerFields({ ...storyDraft, dmTriggerEnabled: false });
    expect(payload).toEqual({
      postId: "123456789", postUrl: storyDraft.postUrl,
      matchAnyPost: false, pendingNextReel: false, dmTriggerEnabled: true,
    });
    expect(matchesStoryReplyScope({ ...payload, incomingStoryId: "123456789" })).toBe(true);
    expect(matchesStoryReplyScope({ ...payload, incomingStoryId: "987654321" })).toBe(false);
    expect(matchesStoryReplyScope({ ...payload, incomingStoryId: undefined })).toBe(false);
  });

  it.each([
    null, "", "https://example.com/stories/user/123456789/",
    "https://instagram.com.evil.test/stories/user/123456789/",
    "http://instagram.com/stories/user/123456789/",
    "https://www.instagram.com/p/ABC/", "https://www.instagram.com/stories/user/not-an-id/",
  ])("rejects unsupported Story input before moving past configuration: %s", (postUrl) => {
    expect(validateCampaignDraft({ ...draft, triggerScope: "story", postUrl, postId: "123456789" }, 0))
      .toBe("Enter the original HTTPS Instagram Story link with its numeric Story ID.");
  });

  it("rejects a Story ID that no longer matches the pasted link", () => {
    expect(validateCampaignDraft({ ...draft, triggerScope: "story", postId: "old-id", postUrl: "https://www.instagram.com/stories/creator/123456789/" }, 0))
      .toBe("Enter the original HTTPS Instagram Story link with its numeric Story ID.");
  });

  it("does not retain Story targeting when returning to any-post or next-post campaigns", () => {
    for (const triggerScope of ["any", "next"] as const) {
      expect(campaignTriggerFields({ triggerScope, postId: "123456789", postUrl: "https://www.instagram.com/stories/creator/123456789/", dmTriggerEnabled: false }))
        .toEqual({ postId: null, postUrl: null, matchAnyPost: triggerScope === "any", pendingNextReel: triggerScope === "next", dmTriggerEnabled: false });
    }
  });
});
