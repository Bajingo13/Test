// R8.2 statement preview: what the server's deterministic parser read from
// the uploaded file, before anything is imported. Display only - every
// figure (rows, amounts, duplicates, errors) comes from
// POST /api/bank-recon/sessions/:id/import/preview, and the import step
// re-parses the file on the server rather than trusting this preview.

function formatMoney(value) {
  if (value === null || value === undefined || value === "") return "";
  return Number(value).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const STATUS_LABEL = { NEW: "To import", DUPLICATE: "Already imported", INVALID: "Error" };

export default function BankStatementPreview({ preview, busy, onImport, onCancel }) {
  const { summary, fields, blockingErrors, warnings, sample, file, dateFormat } = preview;

  return (
    <div className="brc-preview" data-testid="statement-preview">
      <div className="brc-preview-head">
        <h3>Preview: {file.name}</h3>
        <span className="brc-preview-meta">
          {file.type} · dates read as {dateFormat || "—"}
        </span>
      </div>

      <div className="brc-preview-stats">
        <span><strong>{summary.rowsDetected}</strong> rows</span>
        <span><strong>{summary.valid}</strong> valid</span>
        <span className={summary.invalid ? "is-error" : ""}><strong>{summary.invalid}</strong> invalid</span>
        <span className={summary.duplicates ? "is-warning" : ""}><strong>{summary.duplicates}</strong> already imported</span>
        <span className="is-good"><strong>{summary.toImport}</strong> to import</span>
        <span className={summary.warnings ? "is-warning" : ""}><strong>{summary.warnings}</strong> warnings</span>
      </div>

      <div className="brc-preview-columns">
        {fields.map((f) => (
          <span key={f.key} className={f.column ? "mapped" : f.required ? "missing" : ""}>
            {f.label}
            {f.required ? " *" : ""}: {f.column || "not mapped"}
          </span>
        ))}
      </div>

      {blockingErrors.length > 0 && (
        <div className="brc-preview-list is-error" role="alert">
          <strong>Fix these before importing ({summary.blockingErrors}):</strong>
          <ul>
            {blockingErrors.slice(0, 20).map((e, i) => (
              <li key={i}>Row {e.row}: {e.message}</li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="brc-preview-list is-warning">
          <strong>Warnings ({summary.warnings}):</strong>
          <ul>
            {warnings.slice(0, 20).map((w, i) => (
              <li key={i}>{w.row ? `Row ${w.row}: ` : ""}{w.message}</li>
            ))}
          </ul>
        </div>
      )}

      {sample.length > 0 && (
        <div className="brc-table-wrap">
          <table className="brc-table">
            <thead>
              <tr>
                <th>Row</th>
                <th>Status</th>
                <th>Date</th>
                <th>Description</th>
                <th>Reference</th>
                <th>Check No.</th>
                <th>Money</th>
                <th>Amount</th>
                <th>Balance</th>
              </tr>
            </thead>
            <tbody>
              {sample.map((r) => (
                <tr key={r.row} className={`brc-preview-row ${r.status.toLowerCase()}`}>
                  <td>{r.row}</td>
                  <td>{STATUS_LABEL[r.status] || r.status}</td>
                  <td>{r.txnDate || ""}</td>
                  <td>{r.description}</td>
                  <td>{r.referenceNo}</td>
                  <td>{r.checkNo}</td>
                  <td>{r.direction === "OUT" ? "Out" : r.direction === "IN" ? "In" : ""}</td>
                  <td className="amount">{formatMoney(r.amount)}</td>
                  <td className="amount">{formatMoney(r.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="brc-actions">
        <button onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="brc-btn primary" onClick={onImport} disabled={busy || !preview.canImport}>
          {busy ? "Importing..." : `Import ${summary.toImport} transaction(s)`}
        </button>
      </div>
    </div>
  );
}
