"use client";

import { Analytics } from "@vercel/analytics/next";
import { sanitizeAnalyticsEvent } from "@/lib/analytics/privacy";

export default function PrivacyAnalytics() {
  return <Analytics beforeSend={sanitizeAnalyticsEvent} />;
}
