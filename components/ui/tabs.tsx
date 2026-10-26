"use client";
import { useId, type ReactNode } from "react";
import styles from "./ui.module.css";

type Tab = { id: string; label: string; content: ReactNode; disabled?: boolean };
// Controlled: callers own state and preserve editor drafts across tab changes.
export function Tabs({ label, tabs, value, onValueChange }: { label: string; tabs: Tab[]; value: string; onValueChange: (id: string) => void }) {
  const uid = useId();
  return <div className={styles.tabs}>
    <div role="tablist" aria-label={label} className={styles.tablist} onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus(); buttons[next].click();
    }}>
      {tabs.map((tab) => <button key={tab.id} type="button" role="tab" id={`${uid}-tab-${tab.id}`} aria-controls={`${uid}-panel-${tab.id}`} aria-selected={value === tab.id} tabIndex={value === tab.id ? 0 : -1} disabled={tab.disabled} onClick={() => onValueChange(tab.id)}>{tab.label}</button>)}
    </div>
    {tabs.map((tab) => <div key={tab.id} role="tabpanel" id={`${uid}-panel-${tab.id}`} aria-labelledby={`${uid}-tab-${tab.id}`} tabIndex={0} hidden={value !== tab.id}>{tab.content}</div>)}
  </div>;
}
