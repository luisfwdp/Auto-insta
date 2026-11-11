/**
 * Scope keyword-triggered DM campaigns to exactly one Instagram Story.
 *
 * Backwards compatible: an existing post-specific or any-post campaign without
 * a /stories/{username}/{storyId} permalink still matches ordinary DMs.
 * For a Story campaign, postId is the story ID from the permalink and the
 * message webhook must supply message.reply_to.story.id.
 */
export function storyIdFromPermalink(permalink: string | null | undefined): string | null {
  if (!permalink) return null;
  try {
    const url = new URL(permalink);
    if (url.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(url.hostname.toLowerCase())) return null;
    return /^\/stories\/[^/]+\/([0-9]+)\/?$/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function matchesStoryReplyScope({
  postUrl,
  postId,
  incomingStoryId,
}: {
  postUrl: string | null;
  postId: string | null;
  incomingStoryId: string | undefined;
}): boolean {
  const scopedStoryId = storyIdFromPermalink(postUrl);
  if (!scopedStoryId) return true;
  // Never let a malformed/mismatched target accidentally become global.
  return Boolean(incomingStoryId) && postId === scopedStoryId && incomingStoryId === scopedStoryId;
}
