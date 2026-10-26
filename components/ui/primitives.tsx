import type { ComponentPropsWithRef, ReactNode } from "react";
import styles from "./ui.module.css";

export function Button({ variant = "primary", loading = false, disabled, className = "", children, type = "button", ...props }: ComponentPropsWithRef<"button"> & { variant?: "primary" | "secondary" | "danger"; loading?: boolean }) {
  return <button {...props} type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={`${styles.button} ${styles[variant]} ${className}`}>{loading ? <span className={styles.spinner} aria-hidden="true" /> : null}{children}</button>;
}
export function Card({ className = "", ...props }: ComponentPropsWithRef<"section">) {
  return <section {...props} className={`${styles.card} ${className}`} />;
}
export type Tone = "neutral" | "success" | "error" | "warning";
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={styles.badge} data-tone={tone}>{children}</span>;
}
export function Skeleton({ label, className = "" }: { label: string; className?: string }) {
  return <div role="status" aria-label={label} className={`${styles.skeleton} ${className}`}><span aria-hidden="true">&nbsp;</span></div>;
}
export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className={styles.empty}><p className={styles.title}>{title}</p>{description ? <p>{description}</p> : null}{action}</div>;
}
