"use client";
import type { ReactNode } from "react";
import type { Tone } from "./primitives";
import styles from "./ui.module.css";

// Keep mounted before updating message, so assistive tech observes the live region.
// Persistent until dismissed: no time limit for reading or acting on feedback.
export function Toast({ message, tone = "success", dismissLabel, onDismiss }: { message: ReactNode; tone?: Tone; dismissLabel: string; onDismiss: () => void }) {
  const urgent = tone === "error";
  return <div className={styles.toastRegion}>
    <div role={urgent ? "alert" : "status"} aria-live={urgent ? "assertive" : "polite"} aria-atomic="true" className={styles.toast} data-tone={tone}>{message}</div>
    {message ? <button type="button" onClick={onDismiss} aria-label={dismissLabel}>×</button> : null}
  </div>;
}
