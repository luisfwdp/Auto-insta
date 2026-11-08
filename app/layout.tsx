import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import "./criaping-tokens.css";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { criapingSora, criapingInter } from "./fonts/criaping";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = {
  title: "PING CHAT — Automação de comentários e DMs no Instagram",
  description:
    "Transforme comentários com palavras-chave em conversas e mensagens privadas automáticas no Instagram.",
  keywords: [
    "instagram automation",
    "comment to DM",
    "instagram private replies",
    "social commerce",
    "manychat alternative",
  ],
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "PING CHAT",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#18181b",
  width: "device-width",
  initialScale: 1,
  // Installed on iOS the app owns the full screen, notch included; the safe
  // area insets below keep content clear of the system UI.
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const newDesign = isFeatureEnabled("newDesign");
  const { locale } = await getI18n();
  return (
    <html
      lang={locale}
      data-design={newDesign ? "criaping" : undefined}
      className={`h-full dark${newDesign ? ` ${criapingSora.variable} ${criapingInter.variable}` : ""}`}
    >
      <body
        className="min-h-full bg-background text-foreground font-sans antialiased"
        // Clears the home indicator when installed; 0 everywhere else.
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {children}
        <Analytics />
      </body>
    </html>
  );
}
