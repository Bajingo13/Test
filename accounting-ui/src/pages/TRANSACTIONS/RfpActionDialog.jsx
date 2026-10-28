import { useEffect, useRef, useState } from "react";
import { LIMITS, normalizeNote } from "../../utils/rfpPage.mjs";

// In-app confirmation dialog for RFP workflow actions and delete (never
// a native browser dialog). `config.note` is "none" | "optional" |
// "required"; a required note must be non-blank before Confirm enables.
// Server errors (e.g. a 409 because the RFP changed) are shown inside the
// dialog so the user can read them before closing.
export default function RfpActionDialog({ config, rfpNo, busy, error, onConfirm, onClose }) {
  const [note, setNote] = useState("");
  const textRef = useRef(null);
  const confirmRef = useRef(null);

  useEffect(() => {
    if (config.note !== "none") textRef.current?.focus();
    else confirmRef.current?.focus();
  }, [config.note]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const { ok } = normalizeNote(note, config.note);
  const canConfirm = !busy && (config.note === "none" || ok);

  function submit(e) {
    e.preventDefault();
    if (!canConfirm) return;
    onConfirm(config.note === "none" ? null : normalizeNote(note, config.note).note);
  }

  return (
    <div className="rfp-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="rfp-dialog" role="dialog" aria-modal="true" aria-labelledby="rfp-dialog-title" onSubmit={submit}>
        <div className="rfp-dialog-header">
          <h2 id="rfp-dialog-title">{config.title}</h2>
          {rfpNo ? <span className="rfp-dialog-ref">{rfpNo}</span> : null}
        </div>
        <div className="rfp-dialog-body">
          <p>{config.message}</p>
          {config.note !== "none" ? (
            <label className="rfp-field rfp-field-wide">
              <span>
                {config.note === "required" ? "Reason" : "Note"}
                {config.note === "required" ? <em className="rfp-required"> *</em> : <em className="rfp-optional"> (optional)</em>}
              </span>
              <textarea
                ref={textRef}
                rows={4}
                maxLength={LIMITS.note}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={busy}
              />
              <small className="rfp-counter">{note.length}/{LIMITS.note}</small>
            </label>
          ) : null}
          {error ? <div className="rfp-banner rfp-banner-error" role="alert">{error}</div> : null}
        </div>
        <div className="rfp-dialog-footer">
          <button type="button" className="rfp-btn rfp-btn-secondary" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button ref={confirmRef} type="submit" className={`rfp-btn rfp-btn-${config.tone || "primary"}`} disabled={!canConfirm}>
            {busy ? "Working..." : config.confirm}
          </button>
        </div>
      </form>
    </div>
  );
}
