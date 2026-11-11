import { describe, expect, it } from "vitest";
import { matchesStoryReplyScope, storyIdFromPermalink } from "@/lib/automation/story-reply-scoping";

const storyUrl = "https://www.instagram.com/stories/luispagodinsta/4028147829863364233?utm_source=ig_story_item_share";

describe("Story reply campaign scoping", () => {
  it("extracts the story id from an official Instagram permalink", () => {
    expect(storyIdFromPermalink(storyUrl)).toBe("4028147829863364233");
    expect(storyIdFromPermalink("https://example.com/stories/user/123")).toBeNull();
    expect(storyIdFromPermalink("http://instagram.com/stories/user/123")).toBeNull();
  });

  it("responds only when the webhook identifies the selected story", () => {
    const postUrl = storyUrl;
    const postId = "4028147829863364233";
    expect(matchesStoryReplyScope({ postUrl, postId, incomingStoryId: postId })).toBe(true);
    expect(matchesStoryReplyScope({ postUrl, postId, incomingStoryId: "other" })).toBe(false);
    expect(matchesStoryReplyScope({ postUrl, postId, incomingStoryId: undefined })).toBe(false);
    expect(matchesStoryReplyScope({ postUrl, postId: "wrong", incomingStoryId: postId })).toBe(false);
  });

  it("preserves normal keyword-DM behavior for existing non-story campaigns", () => {
    expect(matchesStoryReplyScope({ postUrl: null, postId: null, incomingStoryId: undefined })).toBe(true);
    expect(matchesStoryReplyScope({ postUrl: "https://www.instagram.com/p/ABC/", postId: "123", incomingStoryId: undefined })).toBe(true);
  });
});
