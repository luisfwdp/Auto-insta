"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n/provider";
import { Button, Card } from "./ui/primitives";
import styles from "./campaigns.module.css";

type Props = { configuration: ReactNode; messages: ReactNode; review: ReactNode; preview: ReactNode; error: string | null; saving: boolean; editing: boolean; onSave: () => void; onCancel: () => void; validate: (step: number) => boolean };
export default function CampaignWizard(props: Props) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const error = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (props.error) error.current?.focus(); }, [props.error]);
  const names = [t("Configuration"), t("Messages"), t("Review")];
  function navigate(next: number) {
    if (next > step && !props.validate(step)) return;
    setStep(next);
    requestAnimationFrame(() => heading.current?.focus());
  }
  return <div className={styles.wizard}>
    <h1>{t(props.editing ? "Edit campaign" : "New Campaign")}</h1>
    <p className={styles.muted}>{t("Your draft stays in this browser tab until confirmation. No message is sent while creating it.")}</p>
    <nav aria-label={t("Campaign steps")} className={styles.steps}>{names.map((name, index) => <button key={name} type="button" disabled={index > step || props.saving} aria-current={step === index ? "step" : undefined} onClick={() => navigate(index)}>{index + 1}. {name}</button>)}</nav>
    <h2 ref={heading} tabIndex={-1}>{t("Step {step}: {name}", { step: step + 1, name: names[step] })}</h2>
    {props.error && <p role="alert" tabIndex={-1} className={styles.error} ref={error}>{props.error}</p>}
    <form noValidate onSubmit={(event) => { event.preventDefault(); if (props.saving) return; if (step < 2) navigate(step + 1); else props.onSave(); }}>
      <fieldset disabled={props.saving}>
        <div className={styles.columns}>
          <Card><div hidden={step !== 0} className={styles.stack}>{props.configuration}</div><div hidden={step !== 1} className={styles.stack}>{props.messages}</div><div hidden={step !== 2}>{props.review}</div></Card>
          <aside aria-label={t("Preview")} className={styles.phone}><p className={styles.muted}>{t("Message preview only. Nothing is sent.")}</p><div className={styles.preview}>{props.preview}</div></aside>
        </div>
      </fieldset>
      <div className={`${styles.actions} mt-6`}><Button variant="secondary" disabled={props.saving} onClick={props.onCancel}>{t("Cancel")}</Button>{step > 0 && <Button variant="secondary" disabled={props.saving} onClick={() => navigate(step - 1)}>{t("Back")}</Button>}<Button type="submit" loading={props.saving}>{step < 2 ? t("Continue") : t(props.editing ? "Confirm changes" : "Confirm campaign")}</Button></div>
    </form>
  </div>;
}
