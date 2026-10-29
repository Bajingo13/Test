// R8.3 reconciliation queue: "what needs my attention" in this session.
// Display only - every group, explanation and amount comes from
// GET /api/bank-recon/sessions/:id/queue (the deterministic engine). A
// one-click confirm calls the normal confirmation route, which re-checks
// everything on the server.
import DepositGroupCandidate from "./DepositGroupCandidate.jsx";

function formatMoney(value) {
  return Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const EXCEPTION_LABEL = {
  AMOUNT_MISMATCH: "Amount differs",
  WRONG_DIRECTION: "Wrong direction",
  OTHER_BANK_ACCOUNT: "Other bank account",
  NOT_POSTED: "Not posted",
  ALREADY_RECONCILED: "Already reconciled",
  OUTSIDE_DATE_WINDOW: "Outside date tolerance",
  POSSIBLE_DUPLICATE_IMPORT: "Possible duplicate",
  GROUP_AMOUNT_MISMATCH: "Receipts do not add up",
  OLD_OUTSTANDING_ITEM: "Long outstanding",
};

const OPTION = (i) => `Option ${String.fromCharCode(65 + i)}`;

function DepositDetails({ line }) {
  return (
    <p className="brc-preview-meta">
      Bank deposit: {line.txnDate} · ₱ {formatMoney(line.amount)}
      {line.referenceNo ? ` · Ref ${line.referenceNo}` : ""}
      {line.description ? ` · ${line.description}` : ""}
    </p>
  );
}

function LineLabel({ line }) {
  return (
    <span>
      {line.txnDate} · {line.description || line.referenceNo || line.checkNo || `Line #${line.id}`} · ₱ {formatMoney(line.amount)}{" "}
      ({line.direction === "OUT" ? "out" : "in"})
      {line.carriedForward ? <span className="brc-carried">carried forward</span> : null}
    </span>
  );
}

export default function BankReconQueuePanel({ queue, loading, isFinalized, busyMatchId, onConfirm, onReview, error, onDismissError }) {
  if (!queue) {
    return (
      <div className="brc-card" data-testid="recon-queue">
        <h2>Needs Your Attention</h2>
        <p className="brc-empty">{loading ? "Analyzing..." : "Run matching to analyze this session."}</p>
      </div>
    );
  }
  const { counts, highConfidence, needsReview, unmatchedBank, unmatchedBook, exceptions } = queue;
  const tiles = [
    ["High confidence", counts.highConfidence, "good"],
    ["Needs review", counts.needsReview, "warning"],
    ["Unmatched bank", counts.unmatchedBank, ""],
    ["Outstanding book", counts.unmatchedBook, ""],
    ["Exceptions", counts.exceptions, counts.exceptions ? "error" : ""],
  ];

  return (
    <div className="brc-card" data-testid="recon-queue">
      <div className="brc-import-row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Needs Your Attention</h2>
        <span className="brc-preview-meta">
          {counts.carriedForwardBank + counts.carriedForwardBook > 0
            ? `${counts.carriedForwardBank} bank row(s) and ${counts.carriedForwardBook} book item(s) carried from earlier periods`
            : "Nothing carried from earlier periods"}
        </span>
      </div>

      {error && (
        <div className="brc-inline-error" role="alert" data-testid="queue-error">
          <span>{error}</span>
          {onDismissError && <button type="button" onClick={onDismissError}>Dismiss</button>}
        </div>
      )}

      <div className="brc-queue-tiles">
        {tiles.map(([label, n, tone]) => (
          <div key={label} className={`brc-queue-tile ${tone}`}>
            <strong>{n}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>

      {highConfidence.length > 0 && (
        <section className="brc-queue-section">
          <h3>High-confidence matches</h3>
          {highConfidence.map((h) => (h.candidate.group ? (
            <div key={h.line.id} className="brc-queue-item brc-queue-group">
              <div>
                <LineLabel line={h.line} />
                <DepositDetails line={h.line} />
                <DepositGroupCandidate
                  candidate={h.candidate}
                  busy={busyMatchId === h.candidate.matchId}
                  onConfirm={isFinalized ? null : onConfirm}
                />
              </div>
            </div>
          ) : (
            <div key={h.line.id} className="brc-queue-item">
              <div>
                <LineLabel line={h.line} />
                <p>{h.candidate.explanation}</p>
              </div>
              {!isFinalized && (
                <button className="brc-btn primary" disabled={busyMatchId === h.candidate.matchId} onClick={() => onConfirm(h.candidate.matchId)}>
                  {busyMatchId === h.candidate.matchId ? "Confirming..." : `Confirm ${h.candidate.bookSourceType} ${h.candidate.voucherNo || ""}`}
                </button>
              )}
            </div>
          )))}
        </section>
      )}

      {needsReview.length > 0 && (
        <section className="brc-queue-section">
          <h3>Needs review</h3>
          {needsReview.map((r) => {
            const groups = r.candidates.filter((c) => c.group);
            if (!groups.length) {
              return (
                <div key={r.line.id} className="brc-queue-item">
                  <div>
                    <LineLabel line={r.line} />
                    <p>{r.reason} {r.candidates[0]?.explanation}</p>
                  </div>
                  {!isFinalized && <button onClick={() => onReview(r.line.id)}>{r.manualReview ? "Match Manually" : "Review"}</button>}
                </div>
              );
            }
            return (
              <div key={r.line.id} className="brc-queue-item brc-queue-group">
                <div>
                  <LineLabel line={r.line} />
                  <DepositDetails line={r.line} />
                  <p>{r.reason}</p>
                  {groups.map((g, i) => (
                    <DepositGroupCandidate
                      key={g.matchGroup}
                      candidate={g}
                      title={groups.length > 1 ? OPTION(i) : null}
                      confirmLabel={groups.length > 1 ? `Confirm ${OPTION(i)}` : "Confirm Match"}
                      busy={busyMatchId === g.matchId}
                      onConfirm={isFinalized ? null : onConfirm}
                    />
                  ))}
                </div>
                {!isFinalized && <button onClick={() => onReview(r.line.id)}>Review</button>}
              </div>
            );
          })}
        </section>
      )}

      {exceptions.length > 0 && (
        <section className="brc-queue-section">
          <h3>Exceptions</h3>
          {exceptions.map((e, i) => (
            <div key={`${e.type}-${e.line?.id ?? `${e.document?.type}${e.document?.id}`}-${i}`} className="brc-queue-item">
              <div>
                <span className="brc-exception-tag">{EXCEPTION_LABEL[e.type] || e.type}</span>{" "}
                {e.line ? (
                  <LineLabel line={e.line} />
                ) : (
                  <span>
                    {e.document.txnDate} · {e.document.type} {e.document.voucherNo} · ₱ {formatMoney(e.document.amount)}
                  </span>
                )}
                <p>{e.message}</p>
              </div>
              {!isFinalized && e.line && e.line.matchStatus !== "MATCHED" && <button onClick={() => onReview(e.line.id)}>Open</button>}
            </div>
          ))}
        </section>
      )}

      {unmatchedBank.length > 0 && (
        <section className="brc-queue-section">
          <h3>Unmatched bank transactions</h3>
          {unmatchedBank.map((u) => (
            <div key={u.line.id} className="brc-queue-item">
              <div><LineLabel line={u.line} /></div>
              {!isFinalized && <button onClick={() => onReview(u.line.id)}>Find Match</button>}
            </div>
          ))}
        </section>
      )}

      {unmatchedBook.length > 0 && (
        <section className="brc-queue-section">
          <h3>Outstanding book transactions</h3>
          {unmatchedBook.map((t) => (
            <div key={`${t.sourceType}-${t.sourceId}-${t.lineId || 0}`} className="brc-queue-item">
              <div>
                <span>
                  {t.date} · {t.sourceType} {t.voucherNo} · {t.payeeOrCustomer} · ₱ {formatMoney(t.amount)} (
                  {t.direction === "OUT" ? "outstanding check / payment" : "deposit in transit"})
                  {t.carriedForward ? <span className="brc-carried">carried forward</span> : null}
                </span>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
