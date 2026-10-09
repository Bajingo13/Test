import { useEffect, useId, useRef } from "react";
import "./RecurringTemplateModal.css";
import "./RecordViewModal.css";

/**
 * Shared "View" dialog for File Setup record pages:
 *   list (with the page's own search / filters)
 *     -> click a record (highlighted)
 *     -> its details appear below the list, in the same dialog.
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
}) {
  const titleId = useId();
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

  if (!open) return null;

  const details = selectedRecord ? getDetails(selectedRecord) : [];

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

          <div className="rvm-list-wrap" ref={listRef}>
            <table className="rvm-table">
              <thead>
                <tr>
                  {columns.map((col) => (
                    <th key={col.key}>{col.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={columns.length} className="rvm-empty">
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
                    <td colSpan={columns.length} className="rvm-empty">
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
