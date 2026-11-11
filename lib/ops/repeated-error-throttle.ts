/**
 * Coalesces a hot loop of identical process errors without depending on the
 * failing service itself. A changed error is always reported immediately.
 */
export function createRepeatedErrorThrottle(windowMs: number) {
  let lastMessage: string | null = null;
  let lastReportedAt = Number.NEGATIVE_INFINITY;

  return (message: string, now = Date.now()): boolean => {
    if (message !== lastMessage || now - lastReportedAt >= windowMs) {
      lastMessage = message;
      lastReportedAt = now;
      return true;
    }
    return false;
  };
}
