import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, postChat } from "../api";
import type { ChatMessage } from "../types";

interface ChatBubbleProps {
  message: ChatMessage;
}

function ChatBubble({ message }: ChatBubbleProps): JSX.Element {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <p
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
          isUser
            ? "bg-sky-500/15 text-sky-100 ring-1 ring-sky-500/40"
            : "bg-slate-800 text-slate-200 ring-1 ring-slate-700"
        }`}
        data-testid={isUser ? "chat-message-user" : "chat-message-assistant"}
      >
        {message.content}
      </p>
    </div>
  );
}

interface ChatDrawerProps {
  npu: string;
  onClose: () => void;
}

export default function ChatDrawer({ npu, onClose }: ChatDrawerProps): JSX.Element {
  // Committed turns only — the in-flight question lives in `pending` until the
  // answer lands, so a failed request never poisons the history we replay.
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    const list = listRef.current;
    if (list !== null) {
      list.scrollTop = list.scrollHeight;
    }
  }, [history, pending, error]);

  const ask = (question: string): void => {
    setPending(question);
    setSending(true);
    setError(null);
    postChat({ npu, question, history })
      .then((response) => {
        setHistory((turns) => [
          ...turns,
          { role: "user", content: question },
          { role: "assistant", content: response.answer },
        ]);
        setPending(null);
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof ApiError
            ? cause.message
            : "Could not reach the Pulse ATL chat service."
        );
      })
      .finally(() => {
        setSending(false);
        inputRef.current?.focus();
      });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const question = draft.trim();
    if (question === "" || sending) {
      return;
    }
    setDraft("");
    ask(question);
  };

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-end justify-center bg-slate-950/80"
      data-testid="chat-drawer"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Ask about NPU ${npu}`}
        className="flex h-[70vh] max-h-[34rem] w-full max-w-3xl flex-col overflow-hidden rounded-t-xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
              Grounded in cached stats
            </p>
            <h2 className="text-lg font-semibold text-slate-50" data-testid="chat-title">
              Ask about NPU {npu}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
            data-testid="chat-close-button"
            aria-label="Close chat drawer"
          >
            ✕
          </button>
        </header>

        <div
          ref={listRef}
          aria-live="polite"
          className="flex-1 space-y-3 overflow-y-auto px-6 py-4"
          data-testid="chat-messages"
        >
          {history.length === 0 && pending === null ? (
            <p className="text-sm text-slate-500" data-testid="chat-placeholder">
              Ask anything about NPU {npu} — incident counts, resolution times or
              how it compares with the rest of Atlanta.
            </p>
          ) : null}

          {history.map((message, index) => (
            <ChatBubble key={index} message={message} />
          ))}

          {pending !== null ? (
            <ChatBubble message={{ role: "user", content: pending }} />
          ) : null}

          {sending ? (
            <p className="text-sm text-slate-400" data-testid="chat-thinking">
              Thinking…
            </p>
          ) : null}

          {error !== null ? (
            <div
              className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2"
              data-testid="chat-error"
            >
              <p className="text-sm text-rose-300">{error}</p>
              {pending !== null ? (
                <button
                  type="button"
                  onClick={() => ask(pending)}
                  className="mt-2 rounded-md border border-slate-700 bg-slate-800/70 px-3 py-1 text-xs font-medium text-slate-100 transition hover:bg-slate-700"
                  data-testid="chat-retry-button"
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <form
          onSubmit={onSubmit}
          className="flex gap-2 border-t border-slate-800 px-6 py-4"
          data-testid="chat-form"
        >
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={sending}
            placeholder={`Ask about NPU ${npu}…`}
            aria-label={`Ask a question about NPU ${npu}`}
            className="flex-1 rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 disabled:opacity-50"
            data-testid="chat-input"
          />
          <button
            type="submit"
            disabled={sending || draft.trim() === ""}
            className="rounded-md border border-sky-500/40 bg-sky-500/15 px-4 py-2 text-sm font-medium text-sky-200 transition hover:bg-sky-500/25 disabled:opacity-50 disabled:hover:bg-sky-500/15"
            data-testid="chat-send-button"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
