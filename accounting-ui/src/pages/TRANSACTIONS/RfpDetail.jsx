import { ACTION_LABELS, STATUS_META, VAT_TREATMENTS, formatAmount } from "../../utils/rfpPage.mjs";

export function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status, tone: "neutral" };
  return <span className={`rfp-status rfp-status-${meta.tone}`}>{meta.label}</span>;
}

export function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

const vatLabel = (v) => VAT_TREATMENTS.find((t) => t.value === v)?.label || "—";

function Field({ label, children, wide }) {
  return (
    <div className={`rfp-detail-field${wide ? " rfp-field-wide" : ""}`}>
      <span>{label}</span>
      <div>{children || <span className="rfp-subtle">—</span>}</div>
    </div>
  );
}

// Read-only RFP view: header, lines, workflow metadata, the actions this
// user may take now, and the status history. No Convert action (R5).
export default function RfpDetail({ rfp, accountsById, actions, onAction, onEdit, history }) {
  const anyAction = actions.edit || actions.remove || actions.submit || actions.cancel || actions.approve || actions.return || actions.reject;
  const account = (id) => {
    if (!id) return null;
    const a = accountsById.get(Number(id));
    return a ? `${a.code} — ${a.title}` : "Account unavailable";
  };

  return (
    <div className="rfp-detail">
      <div className="rfp-card">
        <div className="rfp-card-header">
          <div>
            <h2 className="rfp-detail-title">
              {rfp.rfpNo} <StatusBadge status={rfp.status} />
            </h2>
            <p className="rfp-subtle">{rfp.companyName}</p>
          </div>
          {anyAction ? (
            <div className="rfp-actions" role="group" aria-label="Request for Payment actions">
              {actions.edit ? <button type="button" className="rfp-btn rfp-btn-secondary" onClick={onEdit}>Edit</button> : null}
              {actions.submit ? <button type="button" className="rfp-btn rfp-btn-primary" onClick={() => onAction("submit")}>Submit</button> : null}
              {actions.approve ? <button type="button" className="rfp-btn rfp-btn-primary" onClick={() => onAction("approve")}>Approve</button> : null}
              {actions.return ? <button type="button" className="rfp-btn rfp-btn-warning" onClick={() => onAction("return")}>Return</button> : null}
              {actions.reject ? <button type="button" className="rfp-btn rfp-btn-danger" onClick={() => onAction("reject")}>Reject</button> : null}
              {actions.cancel ? <button type="button" className="rfp-btn rfp-btn-secondary" onClick={() => onAction("cancel")}>Cancel RFP</button> : null}
              {actions.remove ? <button type="button" className="rfp-btn rfp-btn-danger-ghost" onClick={() => onAction("delete")}>Delete</button> : null}
            </div>
          ) : null}
        </div>

        {actions.selfDecisionBlocked ? (
          <div className="rfp-banner rfp-banner-info" role="note">
            You requested or submitted this RFP, so another approver must approve, return or reject it.
          </div>
        ) : null}
        {rfp.status === "RETURNED" ? (
          <div className="rfp-banner rfp-banner-warning" role="note">
            This RFP was returned. Editing and resubmitting a returned RFP is not available yet.
          </div>
        ) : null}

        <div className="rfp-detail-grid">
          <Field label="RFP Date">{rfp.rfpDate}</Field>
          <Field label="Requested Payment Date">{rfp.requestedPaymentDate}</Field>
          <Field label="Requester">{rfp.requesterUsername}</Field>
          <Field label="Branch">{rfp.branchName}</Field>
          <Field label="Supplier">{rfp.supplierName}</Field>
          <Field label="Supplier TIN">{rfp.supplierTin}</Field>
          <Field label="Currency">{rfp.currencyCode}</Field>
          <Field label="Total"><strong>{formatAmount(rfp.totalAmount)}</strong></Field>
          <Field label="Supporting Reference">{rfp.supportingReference}</Field>
          <Field label="Purpose" wide><span className="rfp-prewrap">{rfp.purpose}</span></Field>
          <Field label="Remarks" wide>{rfp.remarks ? <span className="rfp-prewrap">{rfp.remarks}</span> : null}</Field>
        </div>

        {rfp.submittedAt || rfp.decidedAt ? (
          <div className="rfp-detail-grid rfp-workflow-meta">
            {rfp.submittedAt ? <Field label="Submitted by">{rfp.submittedByUsername}</Field> : null}
            {rfp.submittedAt ? <Field label="Submitted at">{formatDateTime(rfp.submittedAt)}</Field> : null}
            {rfp.decidedAt ? <Field label="Decided by">{rfp.decidedByUsername}</Field> : null}
            {rfp.decidedAt ? <Field label="Decided at">{formatDateTime(rfp.decidedAt)}</Field> : null}
            {rfp.decidedAt ? <Field label="Decision note" wide>{rfp.decisionNote ? <span className="rfp-prewrap">{rfp.decisionNote}</span> : null}</Field> : null}
          </div>
        ) : null}
      </div>

      <div className="rfp-card">
        <div className="rfp-section-title"><h3>Lines</h3></div>
        <div className="rfp-table-wrap">
          <table className="rfp-table">
            <thead>
              <tr>
                <th>Description</th>
                <th>Account</th>
                <th className="rfp-num">Gross Amount</th>
                <th>VAT Treatment</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {rfp.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.description}</td>
                  <td>{account(l.accountId) || <span className="rfp-subtle">—</span>}</td>
                  <td className="rfp-num">{formatAmount(l.grossAmount)}</td>
                  <td>{vatLabel(l.vatTreatment)}</td>
                  <td>{l.reference || <span className="rfp-subtle">—</span>}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>Total</td>
                <td className="rfp-num"><strong>{formatAmount(rfp.totalAmount)}</strong></td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="rfp-card">
        <div className="rfp-section-title"><h3>History</h3></div>
        {history.status === "loading" ? <div className="rfp-state">Loading history...</div> : null}
        {history.status === "error" ? <div className="rfp-banner rfp-banner-error" role="alert">{history.error}</div> : null}
        {history.status === "ready" && history.rows.length === 0 ? (
          <div className="rfp-state">No workflow actions yet.</div>
        ) : null}
        {history.status === "ready" && history.rows.length > 0 ? (
          <ol className="rfp-timeline">
            {history.rows.map((h) => (
              <li key={h.id}>
                <div className="rfp-timeline-head">
                  <strong>{ACTION_LABELS[h.action] || h.action}</strong>
                  <span className="rfp-subtle">{formatDateTime(h.createdAt)}</span>
                </div>
                <div className="rfp-timeline-body">
                  {h.previousStatus ? <StatusBadge status={h.previousStatus} /> : null}
                  <span aria-hidden="true">→</span>
                  <StatusBadge status={h.newStatus} />
                  <span className="rfp-subtle">by {h.username || "former user"}</span>
                </div>
                {h.note ? <p className="rfp-prewrap rfp-timeline-note">{h.note}</p> : null}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </div>
  );
}
