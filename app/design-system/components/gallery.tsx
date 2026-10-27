"use client";
import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import LanguageSwitcher from "@/components/language-switcher";
import { useI18n } from "@/lib/i18n/provider";
import { Button, Badge, Card, EmptyState, Skeleton } from "@/components/ui/primitives";
import { Input, Select, Textarea, Toggle } from "@/components/ui/fields";
import { Tabs } from "@/components/ui/tabs";
import { Dialog } from "@/components/ui/dialog";
import { Toast } from "@/components/ui/toast";
import { DataTable } from "@/components/ui/data-table";
import styles from "./gallery.module.css";

export default function Gallery() {
  const { t } = useI18n();
  const [tab, setTab] = useState("ready");
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<"success" | "error" | null>(null);
  const message = feedback ? t(feedback === "success" ? "Example saved. No campaign was changed." : "Example error. Please try again.") : "";
  const [enabled, setEnabled] = useState(false);
  const tableProps = { caption: t("Component states"), columns: [{ id: "name", header: t("Component"), cell: (row: { id: string; name: string }) => row.name, rowHeader: true }], rows: [{ id: "button", name: "Button" }, { id: "input", name: "Input" }], rowKey: (row: { id: string }) => row.id, emptyTitle: t("No examples to display"), loadingLabel: t("Loading examples") };
  return <main className={styles.gallery}>
    <div className={styles.container}>
      <header className={styles.header}><Link href="/design-system"><Image src="/brand/criaping/logo-horizontal.svg" width={280} height={53} alt="CRIA PING by Creator Lab Connect" /></Link><LanguageSwitcher /></header>
      <h1>{t("Component library")}</h1><p className={styles.intro}>{t("Isolated component examples. No campaign is created or sent.")}</p>
      <div className={styles.grid}>
        <Card aria-labelledby="controls"><h2 id="controls">{t("Form controls")}</h2>
          <form className={styles.stack} onSubmit={(event) => { event.preventDefault(); setFeedback("success"); }}>
            <Input label={t("Example name")} name="example-name" required hint={t("Required field. Use any example name.")} />
            <Select label={t("Example channel")} name="example-channel"><option value="dm">DM</option><option value="comment">{t("Public reply")}</option></Select>
            <Textarea label={t("Example message")} name="example-message" />
            <Input label={t("Link with an error")} error={t("Enter a complete URL starting with https://.")} defaultValue="example" />
            <Input label={t("Disabled field")} disabled defaultValue="CRIA PING" />
            <Toggle label={t("Enable example")} checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            <Toggle label={t("Unavailable option")} disabled />
            <Button type="submit">{t("Save example")}</Button>
          </form>
        </Card>
        <div className={styles.stack}>
          <Card aria-labelledby="actions"><h2 id="actions">{t("Actions and feedback")}</h2><div className={styles.row}>
            <Button onClick={() => setOpen(true)}>{t("Open example dialog")}</Button><Button variant="secondary" onClick={() => setFeedback("success")}>{t("Show example feedback")}</Button>
            <Button variant="danger" onClick={() => setFeedback("error")}>{t("Show example error")}</Button><Button disabled>{t("Unavailable option")}</Button><Button loading>{t("Loading examples")}</Button>
          </div><div className={styles.row}><Badge tone="success">✓ {t("Success")}</Badge><Badge tone="error">! {t("Error")}</Badge><Badge tone="warning">△ {t("Attention")}</Badge><Badge>{t("Neutral")}</Badge></div></Card>
          <Card aria-labelledby="loading"><h2 id="loading">{t("Loading state")}</h2><Skeleton label={t("Loading examples")} /></Card>
          <Card aria-labelledby="empty"><h2 id="empty">{t("Empty state")}</h2><EmptyState title={t("No examples to display")} description={t("Your data will appear here when available.")} /></Card>
        </div>
        <Card className={styles.wide} aria-labelledby="data"><h2 id="data">{t("Tabs and tables")}</h2>
          <Tabs label={t("Example table state")} value={tab} onValueChange={setTab} tabs={[
            { id: "ready", label: t("Ready"), content: <DataTable {...tableProps} /> },
            { id: "loading", label: t("Loading state"), content: <DataTable {...tableProps} loading /> },
            { id: "empty", label: t("Empty state"), content: <DataTable {...tableProps} rows={[]} /> },
            { id: "error", label: t("Error"), content: <DataTable {...tableProps} error={t("Example error. Please try again.")} /> },
            { id: "disabled", label: t("Unavailable option"), disabled: true, content: null },
          ]} />
        </Card>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title={t("Review example")} description={t("This dialog does not change any campaign.")} closeLabel={t("Close example")}><Input label={t("Example note")} /><Button onClick={() => { setOpen(false); setFeedback("success"); }}>{t("Confirm example")}</Button></Dialog>
      <Toast message={message} tone={feedback ?? "success"} dismissLabel={t("Dismiss notification")} onDismiss={() => setFeedback(null)} />
      <footer>by Creator Lab Connect</footer>
    </div>
  </main>;
}
