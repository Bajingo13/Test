import { useEffect, useId, useRef, useState } from "react";
import "./RecurringTemplateModal.css";
import "./RecordViewModal.css";

/**
 * Shared "View" dialog for File Setup record pages:
 *   list (with the page's own search / filters)
 *     -> click a record -> onSelect(record)
 * The currently selected record is highlighted and its details are shown
 * below the list. The File Setup pages load the picked record into their
 * form and close the dialog in onSelect.
 *
 * Purely presentational - the page owns the data, the filtering and what
 * "selecting" a record means (onSelect). Reuses the rtm-* modal shell from
 * RecurringTemplateModal.css so it matches the existing import dialogs.
 *
 * Props:
 *   open, onClose
 *   title, subtitle
 *   searchValue, onSearchChange, searchPlaceholder
 *   filters          - optional extra filter controls (rendered next to search)
 *   columns          - [{ key, label, render?(record) }]
 *   records          - already-filtered rows to list
 *   loading, emptyMessage
 *   selectedId, onSelect(record)
 *   selectedRecord   - the record whose details are shown (or null)
 *   detailsTitle     - e.g. "Selected Account"
 *   getDetails(record) -> [{ label, value, wide? }]
 *   bulkDelete       - optional { noun, onDelete(ids) -> server response }:
 *                      adds row checkboxes, Select All (the records currently
 *                      listed, i.e. after search / filters), Clear Selected,
 *                      a selected count and Delete Selected with an in-dialog
 *                      confirmation and per-record results. Omitted = the
 *                      dialog is exactly as before. The server re-checks
 *                      permission, scope and in-use rules for every record.
 */
export default function RecordViewModal({
  open,
  onClose,
  title,
  subtitle,
  searchValue,
  onSearchChange,
  searchPlaceholder = "Search...",
  filters = null,
  columns,
  records,
  loading = false,
  emptyMessage = "No records found.",
  selectedId,
  onSelect,
  selectedRecord,
  detailsTitle = "Selected Record",
  getDetails,
  bulkDelete = null,
}) {
  const titleId = useId();
  const [checked, setChecked] = useState(() => new Set());
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);
  const selectAllRef = useRef(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);
  // Pages pass onClose inline, so read the latest one through a ref instead
  // of re-running the open effect (and re-focusing search) on every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Only when the dialog opens: Esc closes it, the search box gets focus,
  // and the currently selected record is scrolled into view. On close,
  // focus goes back to whatever opened the dialog (normally the View button).
  useEffect(() => {
    if (!open) return undefined;

    const opener = document.activeElement;

    function onKeyDown(e) {
      if (e.key === "Escape") onCloseRef.current();
    }

    document.addEventListener("keydown", onKeyDown);
    searchRef.current?.focus();
    listRef.current
      ?.querySelector(".rvm-row.is-selected")
      ?.scrollIntoView({ block: "nearest" });

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open]);

  // A closed dialog forgets its selection and results.
  useEffect(() => {
    if (open) return;
    setChecked(new Set());
    setConfirmingBulk(false);
    setBulkResult(null);
  }, [open]);

  const listedIds = (records || []).map((r) => r.id);
  const listedChecked = listedIds.filter((id) => checked.has(id)).length;
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = listedChecked > 0 && listedChecked < listedIds.length;
  });

  if (!open) return null;

  const details = selectedRecord ? getDetails(selectedRecord) : [];
  const bulk = Boolean(bulkDelete);
  const columnCount = columns.length + (bulk ? 1 : 0);

  function toggleOne(id) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllListed() {
    setChecked((prev) => {
      const next = new Set(prev);
      const allListed = listedIds.length > 0 && listedIds.every((id) => next.has(id));
      for (const id of listedIds) {
        if (allListed) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }
  async function runBulkDelete() {
    setBulkBusy(true);
    try {
      const response = await bulkDelete.onDelete([...checked]);
      setBulkResult(response);
      const done = new Set((response?.results || []).filter((r) => r.status === "deleted").map((r) => r.id));
      setChecked((prev) => new Set([...prev].filter((id) => !done.has(id))));
    } catch {
      setBulkResult({ error: "Unable to connect to the server. Nothing was deleted." });
    } finally {
      setBulkBusy(false);
      setConfirmingBulk(false);
    }
  }

  function handleRowKeyDown(e, record) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(record);
    }
  }

  return (
    <div
      className="rtm-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="rtm-modal rvm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="rtm-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p className="rtm-subtitle">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            className="rtm-close"
            onClick={onClose}
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        <div className="rtm-body rvm-body">
          <div className="rvm-toolbar">
            <input
              ref={searchRef}
              type="text"
              className="rvm-search"
              placeholder={searchPlaceholder}
              value={searchValue}
              onChange={(e) => onSearchChange(e.target.value)}
              aria-label={searchPlaceholder}
            />
            {filters}
            <span className="rvm-count">{records.length} item(s)</span>
          </div>

          {bulk && (
            <div className="rvm-bulkbar" data-testid="rvm-bulkbar">
              <span className="rvm-bulk-count" aria-live="polite">{checked.size} selected</span>
              <button type="button" className="rtm-btn-secondary" onClick={() => { setChecked(new Set()); setBulkResult(null); }} disabled={checked.size === 0 || bulkBusy}>
                Clear Selected
              </button>
              <button type="button" className="rvm-btn-danger" onClick={() => { setBulkResult(null); setConfirmingBulk(true); }} disabled={checked.size === 0 || bulkBusy}>
                Delete Selected
              </button>
            </div>
          )}

          {bulk && confirmingBulk && (
            <div className="rvm-bulk-confirm" role="alertdialog" aria-label="Confirm delete">
              <p>
                Delete <strong>{checked.size}</strong> selected {bulkDelete.noun || "record(s)"}? This cannot be undone.
                Records that are in use are not deleted and will be listed with the reason.
              </p>
              <div className="rvm-bulk-confirm-actions">
                <button type="button" className="rtm-btn-secondary" onClick={() => setConfirmingBulk(false)} disabled={bulkBusy}>Cancel</button>
                <button type="button" className="rvm-btn-danger" onClick={runBulkDelete} disabled={bulkBusy}>
                  {bulkBusy ? "Deleting..." : `Delete ${checked.size}`}
                </button>
              </div>
            </div>
          )}

          {bulk && bulkResult && (
            <div className={`rvm-bulk-result${bulkResult.error ? " is-error" : ""}`} role="status" data-testid="rvm-bulk-result">
              {bulkResult.error ? (
                <p>{bulkResult.error}</p>
              ) : (
                <>
                  <p>
                    Deleted <strong>{bulkResult.summary?.deleted ?? 0}</strong> of {bulkResult.summary?.requested ?? 0}.
                    {bulkResult.summary?.blocked ? ` Blocked (in use): ${bulkResult.summary.blocked}.` : ""}
                    {bulkResult.summary?.skipped ? ` Skipped: ${bulkResult.summary.skipped}.` : ""}
                    {bulkResult.summary?.failed ? ` Failed: ${bulkResult.summary.failed}.` : ""}
                  </p>
                  {(bulkResult.results || []).some((r) => r.status !== "deleted") && (
                    <ul className="rvm-bulk-result-list">
                      {bulkResult.results.filter((r) => r.status !== "deleted").map((r) => (
                        <li key={r.id}>
                          <strong>{r.label || `#${r.id}`}</strong> ({r.status}): {r.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}

          <div className="rvm-list-wrap" ref={listRef}>
            <table className="rvm-table">
              <thead>
                <tr>
                  {bulk && (
                    <th className="rvm-check-col">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        aria-label="Select all listed records"
                        checked={listedIds.length > 0 && listedChecked === listedIds.length}
                        onChange={toggleAllListed}
                        disabled={listedIds.length === 0 || bulkBusy}
                      />
                    </th>
                  )}
                  {columns.map((col) => (
                    <th key={col.key}>{col.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={columnCount} className="rvm-empty">
                      Loading...
                    </td>
                  </tr>
                ) : records.length > 0 ? (
                  records.map((record) => {
                    const isSelected = record.id === selectedId;
                    return (
                      <tr
                        key={record.id}
                        className={isSelected ? "rvm-row is-selected" : "rvm-row"}
                        tabIndex={0}
                        aria-selected={isSelected}
                        onClick={() => onSelect(record)}
                        onKeyDown={(e) => handleRowKeyDown(e, record)}
                      >
                        {bulk && (
                          <td className="rvm-check-col" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              aria-label={`Select ${record.code || record.name || record.id}`}
                              checked={checked.has(record.id)}
                              onChange={() => toggleOne(record.id)}
                              disabled={bulkBusy}
                            />
                          </td>
                        )}
                        {columns.map((col) => (
                          <td key={col.key}>
                            {col.render ? col.render(record) : record[col.key]}
                          </td>
                        ))}
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={columnCount} className="rvm-empty">
                      {emptyMessage}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <section className="rvm-details" aria-live="polite">
            <h3 className="rvm-details-title">{detailsTitle}</h3>
            {selectedRecord ? (
              <dl className="rvm-details-grid">
                {details.map((item) => (
                  <div
                    key={item.label}
                    className={item.wide ? "rvm-detail rvm-detail--wide" : "rvm-detail"}
                  >
                    <dt>{item.label}</dt>
                    <dd>
                      {item.value === null ||
                      item.value === undefined ||
                      item.value === ""
                        ? "—"
                        : item.value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="rvm-details-empty">
                Select a record above to see its details.
              </p>
            )}
          </section>
        </div>

        <div className="rtm-footer">
          <button type="button" className="rtm-btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
