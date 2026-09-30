import { useEffect, useId, useRef, useState } from "react";
import "./ReportExportMenu.css";

// Reports Phase G: one unified "Print / Export" control for the Income
// Statement and Balance Sheet toolbars, replacing the separate
// "Export PDF" / "Export CSV" buttons.
//
//   - Print Report / Save as PDF -> onPrint (window.print). The browser's
//     own dialog is where the user picks a physical printer OR "Save as
//     PDF"; there is deliberately no new server-side printer/PDF API.
//   - Export CSV -> onExportCsv (the existing serializer path - it serialises
//     the model already on screen, no refetch, no recalculation).
//
// Disabled (and closed) until a report model exists. Closes on selection,
// click-outside, or Escape.

export default function ReportExportMenu({ disabled, onPrint, onExportCsv }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const btnId = useId();
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  const choose = (fn) => () => {
    setOpen(false);
    if (typeof fn === "function") fn();
  };

  return (
    <div className="rem" ref={rootRef}>
      <button
        type="button"
        id={btnId}
        className="dark rem-trigger"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (!disabled) setOpen((v) => !v);
        }}
      >
        Print / Export
        <span aria-hidden="true" className="rem-caret">
          ▾
        </span>
      </button>

      {open && !disabled ? (
        <ul className="rem-menu" id={menuId} role="menu" aria-labelledby={btnId}>
          <li role="none">
            <button type="button" role="menuitem" className="rem-item" onClick={choose(onPrint)}>
              Print Report
            </button>
          </li>
          <li role="none">
            <button type="button" role="menuitem" className="rem-item" onClick={choose(onPrint)}>
              Save as PDF
            </button>
          </li>
          <li role="none">
            <button type="button" role="menuitem" className="rem-item" onClick={choose(onExportCsv)}>
              Export CSV
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
