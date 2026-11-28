"use client";

/**
 * Inbox
 *
 * Instagram DM conversations for the selected account, with live message
 * history and a reply composer. Messages are read from the Conversations API
 * (Meta only exposes the 20 most recent per thread) and refreshed by polling.
 * Sending is subject to Instagram's 24-hour messaging window.
 */

import type { Locale } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import { useCallback, useEffect, useRef, useState } from "react";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import type { ConversationListItem } from "@/app/api/instagram/conversations/route";
import type { ThreadMessage } from "@/app/api/instagram/conversations/[id]/route";

const POLL_MS = 12_000;
const ACCOUNT_PREFERENCE = "inbox:selectedAccount";

function formatTime(iso: string | null, locale: Locale): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

export default function InboxPage() {
  const { t, locale } = useI18n();
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");

  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [convLoading, setConvLoading] = useState(true);
  const [convError, setConvError] = useState<string | null>(null);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const requestScope = useRef({ accountId: "", conversationId: null as string | null });
  const conversationRequests = useRef(new Set<string>());
  const sendAttempt = useRef<{ accountId: string; recipientId: string; text: string; requestId: string } | null>(null);

  const active = conversations.find((c) => c.id === activeId) ?? null;

  // Accounts for the selector; default to the first connected account. Uses the
  // lightweight accounts endpoint (one query) rather than the heavy dashboard
  // stats aggregation, so the inbox isn't gated on analytics before it can load.
  useEffect(() => {
    let preferred = "";
    try {
      preferred = window.sessionStorage.getItem(ACCOUNT_PREFERENCE) ?? "";
      // Remove inbox data saved by older versions in this tab.
      for (let index = window.sessionStorage.length - 1; index >= 0; index--) {
        const key = window.sessionStorage.key(index);
        if (key?.startsWith("inbox:convs:") || key?.startsWith("inbox:msgs:")) window.sessionStorage.removeItem(key);
      }
    } catch { /* Storage can be unavailable. */ }
    const controller = new AbortController();
    fetch("/api/instagram/accounts", { signal: controller.signal, cache: "no-store" })
      .then((r) => r.json())
      .then((payload) => {
        if (controller.signal.aborted) return;
        if (!payload.success) { setConvLoading(false); return; }
        const next: AccountOption[] = payload.data.instagramAccounts ?? [];
        setAccounts(next);
        const accountId = next.find((account) => account.id === preferred)?.id ??
          next.find((account) => account.id === payload.data.selectedInstagramAccountId)?.id ?? next[0]?.id ?? "";
        requestScope.current = { accountId, conversationId: null };
        setSelectedAccountId(accountId);
        if (!accountId) setConvLoading(false);
      })
      .catch(() => { if (!controller.signal.aborted) setConvLoading(false); });
    return () => controller.abort();
  }, []);

  // Remember the chosen account for the next visit.
  useEffect(() => {
    if (typeof window === "undefined" || !selectedAccountId) return;
    try { window.sessionStorage.setItem(ACCOUNT_PREFERENCE, selectedAccountId); } catch {}
  }, [selectedAccountId]);

  const loadConversations = useCallback(
    async (silent: boolean) => {
      if (!selectedAccountId || requestScope.current.accountId !== selectedAccountId || conversationRequests.current.has(selectedAccountId)) return;
      conversationRequests.current.add(selectedAccountId);
      if (!silent) setConvLoading(true);
      try {
        const res = await fetch(
          `/api/instagram/conversations?instagramAccountId=${selectedAccountId}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (requestScope.current.accountId !== selectedAccountId) return;
        if (data.success) {
          setConversations(data.data.conversations);
          setConvError(null);
        } else if (!silent) {
          setConvError(data.error ?? "Failed to load conversations");
        }
      } catch {
        if (!silent && requestScope.current.accountId === selectedAccountId) setConvError("Failed to load conversations");
      } finally {
        conversationRequests.current.delete(selectedAccountId);
        if (requestScope.current.accountId === selectedAccountId) setConvLoading(false);
      }
    },
    [selectedAccountId]
  );

  // Load + poll conversations for the selected account without browser persistence.
  useEffect(() => {
    if (!selectedAccountId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadConversations(false);
    const timer = window.setInterval(() => void loadConversations(true), POLL_MS);
    return () => window.clearInterval(timer);
  }, [selectedAccountId, loadConversations]);

  const loadMessages = useCallback(
    async (conversationId: string, silent: boolean) => {
      if (!selectedAccountId) return;
      const sameThread = () => requestScope.current.accountId === selectedAccountId &&
        requestScope.current.conversationId === conversationId;
      if (!sameThread()) return;
      if (!silent) setThreadLoading(true);
      try {
        const res = await fetch(
          `/api/instagram/conversations/${conversationId}?instagramAccountId=${selectedAccountId}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (data.success && sameThread()) {
          setMessages(data.data.messages);
        }
      } catch {
        // keep whatever is shown
      } finally {
        if (!silent && sameThread()) setThreadLoading(false);
      }
    },
    [selectedAccountId]
  );

  // Load + poll only the open thread.
  useEffect(() => {
    if (!activeId || active?.detailsUnavailable) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadMessages(activeId, false);
    const timer = window.setInterval(
      () => void loadMessages(activeId, true),
      POLL_MS
    );
    return () => window.clearInterval(timer);
  }, [activeId, active?.detailsUnavailable, loadMessages]);

  // Keep the thread pinned to the latest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function selectAccount(accountId: string) {
    if (accountId === selectedAccountId) return;
    requestScope.current = { accountId, conversationId: null };
    setSelectedAccountId(accountId);
    setConversations([]);
    setConvError(null);
    setConvLoading(true);
    openConversation(null);
  }

  function openConversation(id: string | null) {
    if (id && requestScope.current.conversationId === id) return;
    requestScope.current.conversationId = id;
    setActiveId(id);
    setSendError(null);
    setMessages([]);
    setThreadLoading(Boolean(id && !conversations.find((conversation) => conversation.id === id)?.detailsUnavailable));
    setDraft("");
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text || !selectedAccountId || !active?.contact.id || sending) return;
    const scope = { ...requestScope.current };
    const sameThread = () => requestScope.current.accountId === scope.accountId &&
      requestScope.current.conversationId === scope.conversationId;
    setSending(true);
    setSendError(null);

    // Optimistically show the reply immediately, then confirm with the server.
    const optimistic: ThreadMessage = {
      id: `optimistic-${Date.now()}`,
      text,
      fromMe: true,
      fromUsername: null,
      createdTime: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setDraft("");

    try {
      const previous = sendAttempt.current;
      const accountId = selectedAccountId;
      const recipientId = active.contact.id;
      const requestId = previous?.accountId === accountId && previous.recipientId === recipientId && previous.text === text
        ? previous.requestId : crypto.randomUUID();
      sendAttempt.current = { accountId, recipientId, text, requestId };
      const res = await fetch("/api/instagram/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instagramAccountId: accountId, recipientId, text, requestId,
        }),
      });
      const data = await res.json();
      if (data.success) sendAttempt.current = null;
      if (!sameThread()) return;
      if (data.success) {
        await loadMessages(active.id, true);
        void loadConversations(true);
      } else {
        // Roll the optimistic message back and restore the draft so it's not lost.
        setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
        setDraft(text);
        setSendError(data.code === "MESSAGING_WINDOW_CLOSED"
          ? t("The 24-hour Instagram messaging window has closed.")
          : data.error && data.error !== "Failed to send message" ? data.error : t("Failed to send message"));
      }
    } catch {
      if (!sameThread()) return;
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setDraft(text);
      setSendError(t("Failed to send message"));
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <h1 className="text-lg font-semibold text-foreground">{t("Inbox")}</h1>
        {accounts.length > 1 && (
          <AccountSelect
            accounts={accounts}
            value={selectedAccountId}
            onChange={selectAccount}
            includeAll={false}
          />
        )}
      </div>

      <div className="grid h-[calc(100dvh-11rem)] grid-cols-1 overflow-hidden rounded border border-border sm:grid-cols-[300px_1fr]">
        {/* Conversation list. On mobile it takes the full pane and is hidden
            once a thread is open (ManyChat-style); on sm+ it is always shown. */}
        <div
          className={`min-h-0 flex-col border-b border-border sm:flex sm:border-b-0 sm:border-r ${
            active ? "hidden" : "flex"
          }`}
        >
          <div className="shrink-0 border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
            {t("Conversations")}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {convLoading ? (
              <p className="px-4 py-6 text-sm text-muted">{t("Loading…")}</p>
            ) : convError ? (
              <p className="px-4 py-6 text-sm text-error">{convError === "Failed to load conversations" ? t("Failed to load conversations") : convError}</p>
            ) : conversations.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">{t("No conversations yet.")}</p>
            ) : (
              conversations.map((c) => {
                const isActive = c.id === activeId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => openConversation(c.id)}
                    className={`block w-full border-b border-border px-4 py-3 text-left ${
                      isActive ? "bg-surface-hover" : "hover:bg-surface-hover"
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {c.detailsUnavailable ? t("Details unavailable") : `@${c.contact.username ?? "unknown"}`}
                      </span>
                      <span className="shrink-0 text-[11px] text-zinc-500">
                        {formatTime(c.updatedTime, locale)}
                      </span>
                    </div>
                    {c.detailsUnavailable && (
                      <p className="mt-0.5 text-xs text-muted">{t("Instagram could not load this conversation.")}</p>
                    )}
                    {c.lastMessage && (
                      <p className="mt-0.5 truncate text-xs text-muted">
                        {c.lastMessage.fromMe ? t("You: ") : ""}
                        {c.lastMessage.text || t("(no text)")}
                      </p>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Thread. On mobile it is only shown once a conversation is open and
            fills the pane; on sm+ it always sits beside the list. */}
        <div
          className={`min-h-0 flex-col ${active ? "flex" : "hidden sm:flex"}`}
        >
          {!active ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted">
              {t("Select a conversation to read and reply.")}
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
                <button
                  type="button"
                  onClick={() => openConversation(null)}
                  className="-ml-1 rounded px-2 py-1 text-muted hover:text-foreground sm:hidden"
                  aria-label={t("Back to conversations")}
                >
                  {t("Back")}
                </button>
                <span className="truncate">
                  {active.detailsUnavailable ? t("Details unavailable") : `@${active.contact.username ?? "unknown"}`}
                </span>
              </div>

              <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
                {active.detailsUnavailable ? (
                  <p role="status" className="text-sm text-muted">
                    {t("Instagram could not load the details of this conversation. Other conversations are still available. You can check this chat in Instagram.")}
                  </p>
                ) : threadLoading && messages.length === 0 ? (
                  <p className="text-sm text-muted">{t("Loading…")}</p>
                ) : messages.length === 0 ? (
                  <p className="text-sm text-muted">{t("No messages.")}</p>
                ) : (
                  messages.map((m) => (
                    <div
                      key={m.id}
                      className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                          m.fromMe
                            ? "bg-accent text-white"
                            : "bg-surface text-foreground border border-border"
                        }`}
                      >
                        <p className="whitespace-pre-wrap break-words">{m.text}</p>
                        <p
                          className={`mt-1 text-[10px] ${
                            m.fromMe ? "text-white/70" : "text-zinc-500"
                          }`}
                        >
                          {formatTime(m.createdTime, locale)}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="shrink-0 border-t border-border p-3">
                {sendError && (
                  <p className="mb-2 text-xs text-error">{sendError}</p>
                )}
                <div className="flex items-end gap-2">
                  <textarea
                    disabled={active.detailsUnavailable || !active.contact.id}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={handleKeyDown}
                    rows={1}
                    placeholder={t("Write a reply…  (Enter to send, Shift+Enter for a new line)")}
                    className="max-h-32 min-h-[40px] flex-1 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSend()}
                    disabled={sending || !draft.trim() || !active.contact.id || active.detailsUnavailable}
                    className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                  >
                    {sending ? t("Sending…") : t("Send")}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
