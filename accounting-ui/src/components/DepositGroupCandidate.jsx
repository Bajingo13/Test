// R8.4-B: one bank deposit proposed as a combination of official receipts.
// Display only - the members, totals and explanation come from the
// deterministic engine; "Confirm Match" calls the normal confirmation
// route with the match rows shown here, and the server re-checks them all.

function formatMoney(value) {
  return Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function DepositGroupCandidate({ candidate, title, busy, disabled, onConfirm, confirmLabel = "Confirm Match" }) {
  const difference = Number(candidate.difference || 0);
  return (
    <div className="brc-group-candidate" data-testid="deposit-group">
      {title && <h4 className="brc-group-title">{title}</h4>}
      <div className="brc-table-wrap">
        <table className="brc-table brc-group-table">
          <thead>
            <tr>
              <th>OR</th>
              <th>Date</th>
              <th>Payer</th>
              <th className="amount">Amount</th>
            </tr>
          </thead>
          <tbody>
            {candidate.members.map((m) => (
              <tr key={m.matchId}>
                <td>{m.voucherNo || `OR #${m.bookSourceId}`}</td>
                <td>{m.txnDate}</td>
                <td>{m.partyName}</td>
                <td className="amount">₱ {formatMoney(m.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan="3">Total</td>
              <td className="amount" data-testid="group-total">₱ {formatMoney(candidate.total)}</td>
            </tr>
            <tr>
              <td colSpan="3">Bank Deposit</td>
              <td className="amount">₱ {formatMoney(candidate.depositAmount)}</td>
            </tr>
            <tr className={difference === 0 ? "brc-group-balanced" : "brc-group-off"}>
              <td colSpan="3">Difference</td>
              <td className="amount" data-testid="group-difference">₱ {formatMoney(difference)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {candidate.explanation && <p className="brc-explanation">{candidate.explanation}</p>}
      {onConfirm && (
        <button
          className="brc-btn primary"
          disabled={busy || disabled || difference !== 0}
          onClick={() => onConfirm(candidate.matchId ?? candidate.id, candidate.matchIds)}
        >
          {busy ? "Confirming..." : confirmLabel}
        </button>
      )}
    </div>
  );
}
