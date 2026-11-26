import { useId } from "react";
import { useActiveBranch } from "../context/ActiveBranchContext";
import "./ActiveBranchSelector.css";

// The system-wide Active Branch control (sidebar + Dashboard). Same state
// everywhere (ActiveBranchContext). Display only: the server re-checks every
// request and only ever narrows with the chosen branch.
//   variant "sidebar"   - compact, under the theme toggle
//   variant "dashboard" - the Dashboard header's Branch field
export default function ActiveBranchSelector({ variant = "sidebar", collapsed = false }) {
  const ab = useActiveBranch();
  const id = useId();
  if (!ab.options.length) return null;

  if (collapsed) {
    return (
      <div className="abs-collapsed" title={`Active branch: ${ab.label}`} data-testid="active-branch-collapsed">
        <span aria-hidden="true">{(ab.isAll ? "ALL" : ab.options.find((o) => o.value === ab.value)?.code || ab.label).slice(0, 8)}</span>
      </div>
    );
  }

  return (
    <div className={`abs abs-${variant}`} data-testid={`active-branch-${variant}`}>
      <label htmlFor={id} className="abs-label">{variant === "sidebar" ? "Active branch" : "Branch"}</label>
      {ab.options.length > 1 ? (
        <select id={id} className="abs-select" value={ab.value} onChange={(e) => ab.requestChange(e.target.value)} aria-describedby={`${id}-hint`}>
          {ab.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : (
        <strong id={id} className="abs-single">{ab.options[0].label}</strong>
      )}
      <span id={`${id}-hint`} className="abs-hint">
        {ab.isAll ? "Showing your authorized branches" : "Shared records + this branch"}
      </span>
      {ab.pending && variant === "sidebar" ? (
        <div className="abs-confirm" role="alertdialog" aria-label="Switch branch">
          <p>This page has unsaved changes. Switch to <strong>{ab.pendingLabel}</strong> and discard them?</p>
          <div className="abs-confirm-actions">
            <button type="button" className="abs-btn" onClick={ab.cancelPending}>Stay</button>
            <button type="button" className="abs-btn abs-btn-danger" onClick={ab.confirmPending}>Switch</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
