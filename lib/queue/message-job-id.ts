export function messageJobId(instagramAccountId: string, messageId: string) {
  // BullMQ forbids colons in IDs. Encoding keeps distinct mids distinct.
  return `message_${instagramAccountId}_${Buffer.from(messageId).toString("base64url")}`;
}
