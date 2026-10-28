import type { StaticMessageKey } from "@/lib/i18n";

export type CampaignDraft = {
  selectedAccountId: string; triggerScope: "specific" | "any" | "next"; postId: string | null;
  matchMode: "specific" | "any"; keywords: string[]; name: string; dmMessage: string;
  openingDmEnabled: boolean; openingDmMessage: string; openingDmButtonLabel: string;
  publicReplyEnabled: boolean; publicReplyMessages: string[];
  trackedDestinationUrl: string; secondaryDestinationUrl: string; linkButtonLabel: string; secondaryButtonLabel: string;
  requireFollow: boolean; followPromptMessage: string; followPromptButtonLabel: string;
  followUpEnabled: boolean; followUpMessage: string; followUpDelayMinutes: number;
};
// UI checks mirror the existing API limits; the server remains authoritative.
export function validateCampaignDraft(draft: CampaignDraft, step = 2): StaticMessageKey | null {
  if (!draft.selectedAccountId) return "Connect an Instagram account first.";
  if (draft.triggerScope === "specific" && !draft.postId) return "Pick a post or reel to trigger the campaign.";
  if (draft.matchMode === "specific" && !draft.keywords.length) return "Add at least one keyword, or switch to any word.";
  if (draft.name.trim().length > 100 || (draft.matchMode === "specific" && (draft.keywords.length > 10 || draft.keywords.some((k) => k.length > 50)))) return "Use up to 10 keywords of 50 characters and a name of up to 100 characters.";
  if (step === 0) return null;
  if (!draft.dmMessage.trim()) return "Add the DM with the link.";
  if (draft.openingDmEnabled && (!draft.openingDmMessage.trim() || !draft.openingDmButtonLabel.trim())) return "Your opening DM needs a message and a button label.";
  if (draft.dmMessage.length > 1000 || (draft.openingDmEnabled && draft.openingDmMessage.length > 1000) || (draft.publicReplyEnabled && (draft.publicReplyMessages.length > 10 || draft.publicReplyMessages.some((m) => m.length > 1000))) || (draft.requireFollow && draft.followPromptMessage.length > 1000) || (draft.followUpEnabled && draft.followUpMessage.length > 1000)) return "Messages allow up to 1000 characters and public replies allow up to 10 variations.";
  if ((draft.openingDmEnabled && draft.openingDmButtonLabel.length > 64) || draft.linkButtonLabel.trim().length > 20 || draft.secondaryButtonLabel.trim().length > 20 || (draft.requireFollow && draft.followPromptButtonLabel.trim().length > 20)) return "Link and follow buttons allow 20 characters; the opening button allows 64.";
  for (const url of [draft.trackedDestinationUrl, draft.secondaryDestinationUrl]) {
    if (!url.trim()) continue;
    try { new URL(url.trim()); } catch { return "Enter valid link URLs."; }
  }
  if (draft.followUpEnabled && (!Number.isInteger(draft.followUpDelayMinutes) || draft.followUpDelayMinutes < 0 || draft.followUpDelayMinutes > 1440)) return "Follow-up delay must be between 0 and 1440 minutes.";
  return null;
}
