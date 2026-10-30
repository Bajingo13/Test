import { useCallback, useEffect, useRef, useState } from "react";

// R8.4-C: in-app replacements for the browser's alert() / confirm() /
// prompt() in Bank Reconciliation.
//   confirmAction({ title, body, confirmLabel, danger }) -> true / false
//   askText({ title, body, inputLabel, confirmLabel }) -> trimmed text, or
//     null when cancelled (the confirm button stays disabled while empty)
//   notify(text, tone) -> a toast; errors stay until dismissed, success /
//     info messages for a few seconds
// Escape or Cancel always answers "no". These only change how a question
// or message is shown - the requests they guard are unchanged.

function ConfirmDialog({ request, onAnswer }) {
  const confirmRef = useRef(null);
  const inputRef = useRef(null);
  const [text, setText] = useState("");
  useEffect(() => {
    if (!request) return undefined;
    setText("");
    (request.inputLabel ? inputRef : confirmRef).current?.focus();
    const onKey = (e) => e.key === "Escape" && onAnswer(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, onAnswer]);
  if (!request) return null;
  const needsText = Boolean(request.inputLabel);
  const submit = () => onAnswer(needsText ? text.trim() : true);
  return (
    <div className="brc-confirm-overlay" onClick={(e) => e.target === e.currentTarget && onAnswer(null)}>
      <div className="brc-confirm" role="alertdialog" aria-modal="true" aria-labelledby="brc-confirm-title" aria-describedby="brc-confirm-body" data-testid="brc-confirm">
        <h3 id="brc-confirm-title">{request.title}</h3>
        <p id="brc-confirm-body">{request.body}</p>
        {needsText && (
          <label className="brc-confirm-input">
            <span>{request.inputLabel}</span>
            <textarea
              ref={inputRef}
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              data-testid="brc-confirm-input"
            />
          </label>
        )}
        <div className="brc-confirm-actions">
          <button type="button" className="brc-btn" onClick={() => onAnswer(null)}>
            {request.cancelLabel || "Cancel"}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={`brc-btn ${request.danger ? "danger-solid" : "primary"}`}
            disabled={needsText && !text.trim()}
            onClick={submit}
          >
            {request.confirmLabel || "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useBankReconDialogs() {
  const [request, setRequest] = useState(null);
  const [toasts, setToasts] = useState([]);
  const resolver = useRef(null);
  const nextId = useRef(1);

  const open = useCallback(
    (options) =>
      new Promise((resolve) => {
        resolver.current = resolve;
        setRequest(options);
      }),
    []
  );

  const confirmAction = useCallback(
    async (options) => Boolean(await open(typeof options === "string" ? { title: "Please confirm", body: options } : options)),
    [open]
  );
  const askText = useCallback(async (options) => (await open(options)) || null, [open]);

  const answer = useCallback((value) => {
    setRequest(null);
    const resolve = resolver.current;
    resolver.current = null;
    if (resolve) resolve(value);
  }, []);

  const dismiss = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const notify = useCallback(
    (text, tone = "error") => {
      if (!text) return;
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-3), { id, text: String(text), tone }]);
      if (tone !== "error") setTimeout(() => dismiss(id), 6000);
    },
    [dismiss]
  );

  const element = (
    <>
      <ConfirmDialog request={request} onAnswer={answer} />
      <div className="brc-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`brc-toast ${t.tone}`}
            role={t.tone === "error" ? "alert" : "status"}
            data-testid="brc-toast"
            data-tone={t.tone}
          >
            <span>
              <strong>{t.tone === "error" ? "Error: " : t.tone === "success" ? "Done: " : ""}</strong>
              {t.text}
            </span>
            <button type="button" aria-label="Dismiss message" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );

  return { confirmAction, askText, notify, element };
}
