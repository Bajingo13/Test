import { Link } from "react-router-dom";
import { STATUS_META, VAT_TREATMENTS, formatAmount, historyActionLabel, showDecision } from "../../utils/rfpPage.mjs";
import { rfpAttachmentsPath } from "../../utils/rfpAttachments.mjs";
import { AttachmentsCard } from "./RfpAttachments";

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
// user may take now (including Convert to APV, R5), the resulting APV of a
// converted RFP, and the status history. `apvPath` is set only when the
// APV page can open that APV for this user.
export default function RfpDetail({ rfp, accountsById, actions, onAction, onEdit, history, apvPath }) {
  const anyAction = actions.edit || actions.remove || actions.submit || actions.resubmit || actions.cancel || actions.approve || actions.return || actions.reject || actions.convert;
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
              {actions.resubmit ? <button type="button" className="rfp-btn rfp-btn-primary" onClick={() => onAction("resubmit")}>Resubmit</button> : null}
              {actions.approve ? <button type="button" className="rfp-btn rfp-btn-primary" onClick={() => onAction("approve")}>Approve</button> : null}
              {actions.return ? <button type="button" className="rfp-btn rfp-btn-warning" onClick={() => onAction("return")}>Return</button> : null}
              {actions.reject ? <button type="button" className="rfp-btn rfp-btn-danger" onClick={() => onAction("reject")}>Reject</button> : null}
              {actions.convert ? <button type="button" className="rfp-btn rfp-btn-primary" onClick={() => onAction("convert")}>Convert to APV</button> : null}
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
          <div className="rfp-banner rfp-banner-warning rfp-returned" role="note">
            <div>
              <strong>Returned for correction</strong>
              {rfp.decisionNote ? <p className="rfp-prewrap">Reason: {rfp.decisionNote}</p> : null}
              <p>
                {actions.edit || actions.resubmit
                  ? "Make the corrections with Edit, then Resubmit it for approval. It stays RETURNED until it is resubmitted."
                  : "Waiting for the requester to correct and resubmit it."}
              </p>
            </div>
          </div>
        ) : null}

        {rfp.status === "CONVERTED" ? (
          <div className="rfp-banner rfp-banner-success rfp-converted" role="note">
            <div>
              <strong>Converted to APV {rfp.convertedApvNo || `#${rfp.convertedApvId}`}</strong>
              {rfp.convertedApvStatus ? <> <span className="rfp-apv-status">{rfp.convertedApvStatus}</span></> : null}
              <p>
                {apvPath ? (
                  <Link className="rfp-link-btn rfp-strong" to={apvPath}>Open the APV</Link>
                ) : (
                  <>Open it from Transactions → Accounts Payable Voucher in this company.</>
                )}{" "}
                Record VAT and withholding on the APV and post it there; this request can no longer be changed.
              </p>
            </div>
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

        {rfp.submittedAt || showDecision(rfp) ? (
          <div className="rfp-detail-grid rfp-workflow-meta">
            {rfp.submittedAt ? <Field label="Submitted by">{rfp.submittedByUsername}</Field> : null}
            {rfp.submittedAt ? <Field label="Submitted at">{formatDateTime(rfp.submittedAt)}</Field> : null}
            {showDecision(rfp) ? <Field label="Decided by">{rfp.decidedByUsername}</Field> : null}
            {showDecision(rfp) ? <Field label="Decided at">{formatDateTime(rfp.decidedAt)}</Field> : null}
            {showDecision(rfp) ? <Field label="Decision note" wide>{rfp.decisionNote ? <span className="rfp-prewrap">{rfp.decisionNote}</span> : null}</Field> : null}
          </div>
        ) : null}

        {rfp.convertedAt ? (
          <div className="rfp-detail-grid rfp-workflow-meta">
            <Field label="Converted by">{rfp.convertedByUsername}</Field>
            <Field label="Converted at">{formatDateTime(rfp.convertedAt)}</Field>
            <Field label="APV">{rfp.convertedApvNo}</Field>
            <Field label="APV status">{rfp.convertedApvStatus}</Field>
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

      <AttachmentsCard
        key={`attachments-${rfp.id}-${rfp.updatedAt}`}
        listPath={rfpAttachmentsPath(rfp.id)}
        basePath={rfpAttachmentsPath(rfp.id)}
        note={
          actions.edit
            ? "Add or remove documents with Edit while the request is Draft or Returned."
            : rfp.status === "CONVERTED"
              ? `The documents stay with this request and can also be opened from APV ${rfp.convertedApvNo || ""}.`
              : null
        }
      />

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
                  <strong>{historyActionLabel(h)}</strong>
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
