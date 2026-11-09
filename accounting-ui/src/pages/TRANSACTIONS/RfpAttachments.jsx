import { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders } from "../../utils/authSession";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_CATEGORIES,
  MAX_ATTACHMENTS,
  SUPPORTED_TEXT,
  categoryLabel,
  checkAttachmentFile,
  downloadPath,
  formatFileSize,
  previewKind,
} from "../../utils/rfpAttachments.mjs";
import "./RfpAttachments.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function formatWhen(value) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

// Attachments are only served to an authenticated, authorized request, so
// they are fetched with the token and shown from a local blob URL - never by
// a plain link to the server.
async function fetchAttachmentBlob(basePath, attachmentId) {
  const res = await fetch(`${API_URL}${downloadPath(basePath, attachmentId)}`, { headers: authHeaders(), credentials: "include" });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.message || (res.status === 403 ? "You do not have permission to open this file." : "The file could not be opened."));
  }
  return res.blob();
}

export function useAttachmentList(listPath) {
  const [state, setState] = useState({ status: "idle", data: null, error: "" });
  const ticket = useRef(0);
  const load = useCallback(() => {
    if (!listPath) {
      setState({ status: "idle", data: null, error: "" });
      return;
    }
    const mine = ++ticket.current;
    setState((s) => ({ status: "loading", data: s.data, error: "" }));
    fetch(`${API_URL}${listPath}`, { headers: authHeaders(), credentials: "include" })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (mine !== ticket.current) return;
        if (res.ok) setState({ status: "ready", data, error: "" });
        else setState({ status: "error", data: null, error: data?.message || "Unable to load the attachments." });
      })
      .catch(() => mine === ticket.current && setState({ status: "error", data: null, error: "Unable to reach the server." }));
  }, [listPath]);
  useEffect(() => {
    load();
    return () => {
      ticket.current += 1;
    };
  }, [load]);
  return [state, load];
}

// In-page preview of an image or PDF from a blob/object URL.
export function AttachmentPreview({ name, mimeType, url, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const kind = previewKind(mimeType || name);
  return (
    <div className="rfp-att-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rfp-att-preview" role="dialog" aria-modal="true" aria-label={`Preview of ${name}`}>
        <div className="rfp-att-preview-head">
          <strong className="rfp-att-name" title={name}>{name}</strong>
          <div className="rfp-att-actions">
            <a className="rfp-att-btn" href={url} download={name}>Download</a>
            <button type="button" className="rfp-att-btn" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="rfp-att-preview-body">
          {kind === "image" ? <img src={url} alt={name} /> : null}
          {kind === "pdf" ? <iframe src={url} title={name} /> : null}
          {!kind ? <p>This file cannot be previewed. Use Download.</p> : null}
        </div>
      </div>
    </div>
  );
}

// Saved attachments: view / download for anyone who can see the list,
// and an optional per-row action (the form's Remove).
export function SavedAttachmentList({ items, basePath, rowAction }) {
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => () => preview && URL.revokeObjectURL(preview.url), [preview]);

  async function open(item, mode) {
    setBusy(`${mode}-${item.id}`);
    setError("");
    try {
      const blob = await fetchAttachmentBlob(basePath, item.id);
      const url = URL.createObjectURL(new Blob([blob], { type: item.mimeType }));
      if (mode === "view") {
        setPreview({ name: item.originalFilename, mimeType: item.mimeType, url });
      } else {
        const a = document.createElement("a");
        a.href = url;
        a.download = item.originalFilename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (err) {
      setError(`${item.originalFilename}: ${err.message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {error ? <div className="rfp-att-error" role="alert">{error}</div> : null}
      <ul className="rfp-att-list">
        {items.map((item) => (
          <li key={item.id} className={`rfp-att-item${rowAction?.marked?.(item) ? " rfp-att-item-marked" : ""}`}>
            <span className={`rfp-att-kind rfp-att-kind-${previewKind(item.mimeType) || "file"}`} aria-hidden="true">
              {previewKind(item.mimeType) === "pdf" ? "PDF" : "IMG"}
            </span>
            <div className="rfp-att-meta">
              <span className="rfp-att-name" title={item.originalFilename}>{item.originalFilename}</span>
              <span className="rfp-att-sub">
                {categoryLabel(item.category)} · {formatFileSize(item.fileSize)}
                {item.uploadedByUsername ? ` · ${item.uploadedByUsername}` : ""}
                {item.uploadedAt ? ` · ${formatWhen(item.uploadedAt)}` : ""}
              </span>
            </div>
            <div className="rfp-att-actions">
              <button type="button" className="rfp-att-btn" onClick={() => open(item, "view")} disabled={Boolean(busy)}>
                {busy === `view-${item.id}` ? "Opening..." : "View"}
              </button>
              <button type="button" className="rfp-att-btn" onClick={() => open(item, "download")} disabled={Boolean(busy)}>
                {busy === `download-${item.id}` ? "Downloading..." : "Download"}
              </button>
              {rowAction ? (
                <button type="button" className="rfp-att-btn rfp-att-btn-danger" onClick={() => rowAction.onClick(item)} disabled={rowAction.disabled}>
                  {rowAction.label(item)}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {preview ? <AttachmentPreview {...preview} onClose={() => setPreview(null)} /> : null}
    </>
  );
}

// Read-only card for the RFP view and the APV page.
export function AttachmentsCard({ title = "Supporting Documents", listPath, basePath, note, emptyText = "No supporting documents attached.", hideWhenEmpty = false, render }) {
  const [state, reload] = useAttachmentList(listPath);
  const items = Array.isArray(state.data) ? state.data : state.data?.attachments || [];
  // hideWhenEmpty: nothing to show at all (for the APV page: an APV that was
  // not converted from a Request for Payment).
  if (hideWhenEmpty && state.status === "ready" && !items.length && !state.data?.sourceRfp) return null;
  if (hideWhenEmpty && state.status !== "ready" && state.status !== "error") return null;
  return (
    <div className="rfp-att-card">
      <div className="rfp-att-card-head">
        <h3>{title}</h3>
        {state.status === "ready" ? <span className="rfp-att-sub">{items.length} file{items.length === 1 ? "" : "s"}</span> : null}
      </div>
      {render ? render(state) : null}
      {note ? <p className="rfp-att-sub">{note}</p> : null}
      {state.status === "loading" && !state.data ? <div className="rfp-att-sub">Loading attachments...</div> : null}
      {state.status === "error" ? (
        <div className="rfp-att-error" role="alert">
          {state.error} <button type="button" className="rfp-att-link" onClick={reload}>Retry</button>
        </div>
      ) : null}
      {state.status === "ready" && !items.length ? <div className="rfp-att-sub">{emptyText}</div> : null}
      {items.length ? <SavedAttachmentList items={items} basePath={basePath} /> : null}
    </div>
  );
}

// Form section: saved attachments (marked for removal on save) and new files
// queued for upload on save, each previewable before saving.
export function AttachmentPicker({ saved, savedBasePath, savedStatus, queued, removeIds, onAdd, onUnqueue, onCategory, onToggleRemove, disabled }) {
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState(null);
  const input = useRef(null);
  const keptCount = saved.filter((a) => !removeIds.includes(a.id)).length;
  const room = MAX_ATTACHMENTS - keptCount - queued.length;

  function pick(e) {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    const errors = [];
    const ok = [];
    for (const f of files) {
      const err = checkAttachmentFile(f);
      if (err) errors.push(err);
      else if (ok.length >= room) errors.push(`${f.name}: a Request for Payment can have at most ${MAX_ATTACHMENTS} attachments.`);
      else ok.push(f);
    }
    if (ok.length) onAdd(ok);
    setMessage(errors.join(" "));
  }

  return (
    <div className="rfp-att-picker">
      <div className="rfp-att-card-head">
        <h3>Supporting Documents <em className="rfp-optional">(optional)</em></h3>
        <span className="rfp-att-sub">{SUPPORTED_TEXT}, up to 10 MB each, {MAX_ATTACHMENTS} per request</span>
      </div>

      {savedStatus === "loading" ? <div className="rfp-att-sub">Loading attachments...</div> : null}
      {savedStatus === "error" ? <div className="rfp-att-error" role="alert">The saved attachments could not be loaded.</div> : null}
      {saved.length ? (
        <SavedAttachmentList
          items={saved}
          basePath={savedBasePath}
          rowAction={{
            label: (item) => (removeIds.includes(item.id) ? "Keep" : "Remove"),
            marked: (item) => removeIds.includes(item.id),
            onClick: (item) => onToggleRemove(item.id),
            disabled,
          }}
        />
      ) : null}
      {removeIds.length ? <p className="rfp-att-sub">{removeIds.length} attachment(s) will be removed when you save. Removed files are kept in the audit trail.</p> : null}

      {queued.length ? (
        <ul className="rfp-att-list">
          {queued.map((q) => (
            <li key={q.key} className="rfp-att-item rfp-att-item-new">
              {previewKind(q.file.type || q.file.name) === "image" ? (
                <img className="rfp-att-thumb" src={q.url} alt="" />
              ) : (
                <span className="rfp-att-kind rfp-att-kind-pdf" aria-hidden="true">PDF</span>
              )}
              <div className="rfp-att-meta">
                <span className="rfp-att-name" title={q.file.name}>{q.file.name}</span>
                <span className="rfp-att-sub">New · {formatFileSize(q.file.size)} · uploads when you save</span>
              </div>
              <select aria-label={`Category for ${q.file.name}`} value={q.category} onChange={(e) => onCategory(q.key, e.target.value)} disabled={disabled}>
                {ATTACHMENT_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              <div className="rfp-att-actions">
                <button type="button" className="rfp-att-btn" onClick={() => setPreview({ name: q.file.name, mimeType: q.file.type, url: q.url })} disabled={disabled}>
                  Preview
                </button>
                <button type="button" className="rfp-att-btn rfp-att-btn-danger" onClick={() => onUnqueue(q.key)} disabled={disabled}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {message ? <div className="rfp-att-error" role="alert">{message}</div> : null}
      <div>
        <input ref={input} type="file" accept={ATTACHMENT_ACCEPT} multiple onChange={pick} hidden aria-label="Choose receipt or supporting document" />
        <button type="button" className="rfp-att-btn" onClick={() => input.current?.click()} disabled={disabled || room <= 0}>
          + Attach receipt or document
        </button>
      </div>
      {preview ? <AttachmentPreview {...preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}
