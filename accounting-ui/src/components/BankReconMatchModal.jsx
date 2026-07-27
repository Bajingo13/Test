import { useMemo, useState } from "react";

function formatMoney(value) {
  return Number(value || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function BankReconMatchModal({
  statementLine,
  candidates,
  bookItems,
  busy,
  onClose,
  onConfirmCandidate,
  onManualMatch,
  onIgnore,
}) {
  const [search, setSearch] = useState("");

  const wantDirection = Number(statementLine.debit) > 0 ? "OUT" : "IN";
  const stmtAmount =
    Number(statementLine.debit) > 0 ? Number(statementLine.debit) : Number(statementLine.credit);

  const searchableBookItems = useMemo(() => {
    const q = search.trim().toLowerCase();

    return bookItems
      .filter((item) => item.direction === wantDirection)
      .filter((item) => {
        if (!q) return true;
        return [item.voucherNo, item.payeeOrCustomer, item.referenceNo, item.checkNo, item.description]
          .join(" ")
          .toLowerCase()
          .includes(q);
      });
  }, [bookItems, wantDirection, search]);

  return (
    <div className="brc-modal-overlay">
      <div className="brc-modal">
        <div className="brc-modal-header">
          <div>
            <h2>Match Statement Line</h2>
            <p>
              {statementLine.txnDate} &middot; {statementLine.description} &middot;{" "}
              <strong>₱ {formatMoney(stmtAmount)}</strong> ({wantDirection === "OUT" ? "money out" : "money in"})
            </p>
          </div>
          <button type="button" className="brc-modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        {candidates.length > 0 && (
          <div className="brc-modal-section">
            <h3>Suggested Candidates</h3>
            <div className="brc-table-wrap">
              <table className="brc-table" style={{ minWidth: "auto" }}>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Source</th>
                    <th>Voucher No.</th>
                    <th>Payee/Customer</th>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Score</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.id}>
                      <td>{c.matchType}</td>
                      <td>{c.bookSourceType}</td>
                      <td>{c.detail?.voucherNo}</td>
                      <td>
                        {c.detail?.payeeName || c.detail?.customerName || c.detail?.preparedFor}
                      </td>
                      <td>{c.detail?.txnDate}</td>
                      <td className="amount">₱ {formatMoney(c.amount)}</td>
                      <td>{c.confidenceScore}</td>
                      <td>
                        <button
                          className="brc-btn primary"
                          disabled={busy}
                          onClick={() => onConfirmCandidate(c.id)}
                        >
                          Confirm
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="brc-modal-section">
          <h3>Manually Match a Book Item</h3>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search voucher no., payee/customer, reference..."
            className="brc-search-input"
            style={{ marginBottom: 12 }}
          />

          <div className="brc-table-wrap">
            <table className="brc-table" style={{ minWidth: "auto" }}>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Voucher No.</th>
                  <th>Payee/Customer</th>
                  <th>Date</th>
                  <th>Amount</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {searchableBookItems.length === 0 ? (
                  <tr>
                    <td colSpan="6" className="brc-empty">
                      No matching book items.
                    </td>
                  </tr>
                ) : (
                  searchableBookItems.map((item) => (
                    <tr key={`${item.sourceType}-${item.sourceId}-${item.lineId || 0}`}>
                      <td>{item.sourceType}</td>
                      <td>{item.voucherNo}</td>
                      <td>{item.payeeOrCustomer}</td>
                      <td>{item.date}</td>
                      <td className="amount">₱ {formatMoney(item.amount)}</td>
                      <td>
                        <button disabled={busy} onClick={() => onManualMatch(item)}>
                          Match
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="brc-modal-footer">
          {statementLine.matchStatus !== "MATCHED" && (
            <button onClick={onIgnore} disabled={busy}>
              {statementLine.matchStatus === "IGNORED" ? "Un-ignore This Line" : "Ignore This Line"}
            </button>
          )}
          <button onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
