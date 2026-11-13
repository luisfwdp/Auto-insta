/** Story mention and reaction webhooks, with anonymised Meta payloads. */
import { describe, expect, it } from "vitest";
import { parseMessageEvents, parseReactionEvents, parseStoryMentionEvents } from "@/lib/meta/webhook";

const wrap = (messaging: unknown[]) => ({ object: "instagram", entry: [{ id: "acct_1", messaging }] }) as never;

describe("parseStoryMentionEvents", () => {
  it("reads a story_mention attachment", () => {
    const payload = wrap([
      {
        sender: { id: "user_9" },
        recipient: { id: "acct_1" },
        message: { mid: "mid_1", attachments: [{ type: "story_mention", payload: { url: "https://cdn.example/expiring" } }] },
      },
    ]);
    expect(parseStoryMentionEvents(payload)).toEqual([{ instagramAccountId: "acct_1", messageId: "mid_1", senderId: "user_9" }]);
    // No text, so it never reaches the keyword-DM path.
    expect(parseMessageEvents(payload)).toEqual([]);
  });

  it("ignores echoes, other attachments, the account itself and other objects", () => {
    expect(
      parseStoryMentionEvents(
        wrap([
          { sender: { id: "user_9" }, message: { mid: "a", is_echo: true, attachments: [{ type: "story_mention" }] } },
          { sender: { id: "user_9" }, message: { mid: "b", attachments: [{ type: "image" }] } },
          { sender: { id: "acct_1" }, message: { mid: "c", attachments: [{ type: "story_mention" }] } },
        ])
      )
    ).toEqual([]);
    expect(parseStoryMentionEvents({ object: "page", entry: [] } as never)).toEqual([]);
  });
});

describe("parseReactionEvents", () => {
  it("reads a reaction and drops its removal", () => {
    const payload = wrap([
      { sender: { id: "user_9" }, recipient: { id: "acct_1" }, reaction: { mid: "mid_7", action: "react", reaction: "love", emoji: "❤" } },
      { sender: { id: "user_9" }, recipient: { id: "acct_1" }, reaction: { mid: "mid_7", action: "unreact" } },
    ]);
    expect(parseReactionEvents(payload)).toEqual([
      { instagramAccountId: "acct_1", messageId: "mid_7", senderId: "user_9", reaction: "love", emoji: "❤" },
    ]);
  });

  it("ignores a reaction with no target message or from the account itself", () => {
    expect(
      parseReactionEvents(
        wrap([
          { sender: { id: "user_9" }, reaction: { action: "react", reaction: "love" } },
          { sender: { id: "acct_1" }, reaction: { mid: "m", action: "react" } },
        ])
      )
    ).toEqual([]);
  });
});
