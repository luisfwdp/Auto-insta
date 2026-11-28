export function isDirectMessageOnly(campaign: {
  dmTriggerEnabled: boolean;
  matchAnyPost: boolean;
  pendingNextReel: boolean;
  postId: string | null;
}) {
  return campaign.dmTriggerEnabled === true && campaign.matchAnyPost === false
    && campaign.pendingNextReel === false && campaign.postId === null;
}
