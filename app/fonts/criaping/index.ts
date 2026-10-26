import localFont from "next/font/local";

// Self-hosted, no remote build requests. No preload while newDesign is off.
export const criapingSora = localFont({
  src: "./Sora-latin.woff2",
  variable: "--font-criaping-sora",
  weight: "100 800",
  display: "swap",
  preload: false,
  fallback: ["Arial", "sans-serif"],
});
export const criapingInter = localFont({
  src: "./Inter-latin.woff2",
  variable: "--font-criaping-inter",
  weight: "100 900",
  display: "swap",
  preload: false,
  fallback: ["Arial", "sans-serif"],
});
