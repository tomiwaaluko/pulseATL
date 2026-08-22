import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, postLetter } from "../api";
import { LETTER_FALLBACK_PREFIX } from "../types";

type CopyState = "idle" | "copied" | "failed";

/**
 * Clipboard access is blocked outright in some browsers and in any
 * non-secure-context page, and `writeText` rejects rather than returning
 * false. Everything is contained here so a refusal becomes a fallback
 * instruction instead of an unhandled rejection.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (clipboard === undefined || typeof clipboard.writeText !== "function") {
      return false;
    }
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

interface LetterModalProps {
  npu: string;
  onClose: () => void;
}

export default function LetterModal({ npu, onClose }: LetterModalProps): JSX.Element {
  const [letter, setLetter] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");

  const textRef = useRef<HTMLTextAreaElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const draft = useCallback((): void => {
    setLoading(true);
    setError(null);
    setCopyState("idle");
    postLetter({ npu })
      .then((response) => {
        setLetter(response.letter);
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof ApiError
            ? cause.message
            : "Could not reach the Pulse ATL letter service."
        );
      })
      .finally(() => {
        setLoading(false);
      });
  }, [npu]);

  useEffect(() => {
    draft();
  }, [draft]);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();

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

  // The backend returns this marker rather than inventing a draft, so it is a
  // failure notice — never offer it as something to copy and send.
  const unavailable = letter !== null && letter.startsWith(LETTER_FALLBACK_PREFIX);
  const sendable = letter !== null && !unavailable;

  const onCopy = (): void => {
    if (letter === null) {
      return;
    }
    void copyToClipboard(letter).then((ok) => {
      setCopyState(ok ? "copied" : "failed");
      if (!ok) {
        // Selecting the text leaves the reader one keystroke from a manual copy.
        textRef.current?.focus();
        textRef.current?.select();
      }
    });
  };

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-950/80 p-4"
      data-testid="letter-modal"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Draft a council letter about NPU ${npu}`}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between border-b border-slate-800 px-6 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
              Grounded in cached stats
            </p>
            <h2 className="text-lg font-semibold text-slate-50" data-testid="letter-title">
              Letter to your council member — NPU {npu}
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
            data-testid="letter-close-button"
            aria-label="Close letter draft"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-4" aria-live="polite">
          {loading ? (
            <p className="text-sm text-slate-400" data-testid="letter-loading">
              Drafting a letter from NPU {npu}&apos;s cached statistics…
            </p>
          ) : null}

          {error !== null ? (
            <div
              className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2"
              data-testid="letter-error"
            >
              <p className="text-sm text-rose-300">{error}</p>
              <button
                type="button"
                onClick={draft}
                className="mt-2 rounded-md border border-slate-700 bg-slate-800/70 px-3 py-1 text-xs font-medium text-slate-100 transition hover:bg-slate-700"
                data-testid="letter-retry-button"
              >
                Retry
              </button>
            </div>
          ) : null}

          {unavailable ? (
            <div
              className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2"
              data-testid="letter-unavailable"
            >
              <p className="text-sm text-amber-200">{letter}</p>
              <button
                type="button"
                onClick={draft}
                className="mt-2 rounded-md border border-slate-700 bg-slate-800/70 px-3 py-1 text-xs font-medium text-slate-100 transition hover:bg-slate-700"
                data-testid="letter-retry-button"
              >
                Retry
              </button>
            </div>
          ) : null}

          {sendable ? (
            <>
              <p className="mb-3 text-xs text-slate-500" data-testid="letter-disclaimer">
                Every figure below comes from this NPU&apos;s cached statistics. Read it
                before you send it, and add your own name and address.
              </p>
              <textarea
                ref={textRef}
                readOnly
                value={letter}
                rows={16}
                aria-label={`Draft letter about NPU ${npu}`}
                className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 font-mono text-sm leading-relaxed text-slate-200"
                data-testid="letter-text"
              />
            </>
          ) : null}
        </div>

        {sendable ? (
          <footer className="flex items-center gap-3 border-t border-slate-800 px-6 py-4">
            <button
              type="button"
              onClick={onCopy}
              className="rounded-md border border-sky-500/40 bg-sky-500/15 px-4 py-2 text-sm font-medium text-sky-200 transition hover:bg-sky-500/25"
              data-testid="letter-copy-button"
            >
              Copy to clipboard
            </button>
            {copyState === "copied" ? (
              <p className="text-sm text-emerald-300" data-testid="letter-copy-ok">
                Copied.
              </p>
            ) : null}
            {copyState === "failed" ? (
              <p className="text-sm text-amber-300" data-testid="letter-copy-failed">
                Your browser blocked the clipboard — the text is selected, press
                Ctrl+C (⌘C on a Mac) to copy it.
              </p>
            ) : null}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
