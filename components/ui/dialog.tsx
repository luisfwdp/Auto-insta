"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./primitives";
import styles from "./ui.module.css";

// Native modal provides focus containment, inert background and Escape.
export function Dialog({ open, onClose, title, description, closeLabel, children }: { open: boolean; onClose: () => void; title: string; description?: string; closeLabel: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const trigger = document.activeElement as HTMLElement | null;
    if (!dialog.open) dialog.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [open]);
  return <dialog ref={ref} className={styles.dialog} aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined} onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => {
    if (event.key !== "Tab") return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')).filter((el) => el.tabIndex >= 0 && el.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  }}>
    <h2 id={`${id}-title`} className={styles.title}>{title}</h2>
    {description ? <p id={`${id}-description`}>{description}</p> : null}
    {open ? children : null}
    <Button variant="secondary" onClick={onClose}>{closeLabel}</Button>
  </dialog>;
}
