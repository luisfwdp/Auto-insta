"use client";
import { useId, type ComponentPropsWithRef, type ReactNode } from "react";
import styles from "./ui.module.css";

type FieldProps = { label: string; hint?: string; error?: string };
function useField({ id, hint, error, "aria-describedby": describedBy, "aria-invalid": invalid }: FieldProps & { id?: string; "aria-describedby"?: string; "aria-invalid"?: ComponentPropsWithRef<"input">["aria-invalid"] }) {
  const generated = useId();
  const fieldId = id ?? generated;
  return { id: fieldId, "aria-invalid": error ? true as const : invalid, "aria-describedby": [describedBy, hint ? `${fieldId}-hint` : "", error ? `${fieldId}-error` : ""].filter(Boolean).join(" ") || undefined };
}
function FieldFrame({ id, label, hint, error, children }: FieldProps & { id: string; children: ReactNode }) {
  return <div className={styles.field}><label htmlFor={id}>{label}</label>{children}{hint ? <p id={`${id}-hint`} className={styles.hint}>{hint}</p> : null}{error ? <p id={`${id}-error`} className={styles.error}>{error}</p> : null}</div>;
}
export function Input({ label, hint, error, className = "", ...props }: FieldProps & ComponentPropsWithRef<"input">) {
  const field = useField({ ...props, label, hint, error });
  return <FieldFrame {...{ label, hint, error }} id={field.id}><input {...props} {...field} className={`${styles.control} ${className}`} /></FieldFrame>;
}
export function Textarea({ label, hint, error, className = "", ...props }: FieldProps & ComponentPropsWithRef<"textarea">) {
  const field = useField({ ...props, label, hint, error });
  return <FieldFrame {...{ label, hint, error }} id={field.id}><textarea {...props} {...field} className={`${styles.control} ${className}`} /></FieldFrame>;
}
export function Select({ label, hint, error, className = "", children, ...props }: FieldProps & ComponentPropsWithRef<"select">) {
  const field = useField({ ...props, label, hint, error });
  return <FieldFrame {...{ label, hint, error }} id={field.id}><select {...props} {...field} className={`${styles.control} ${className}`}>{children}</select></FieldFrame>;
}
export function Toggle({ label, ...props }: { label: string } & Omit<ComponentPropsWithRef<"input">, "type" | "role" | "children">) {
  return <label className={styles.toggle}><input {...props} type="checkbox" role="switch" /><span className={styles.track} aria-hidden="true" /><span>{label}</span></label>;
}
