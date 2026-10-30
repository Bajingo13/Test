import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import {
  STATUS_FILTERS,
  TYPE_FILTERS,
  STATUS_DISPLAY,
  emptyFilters,
  filtersFromSearch,
  historyQuery,
  activeFilterCount,
  rowFlags,
  statusText,
  formatPeso,
  periodLabel,
} from "../../utils/bankStatementHistory.mjs";
import "./BankReconciliation.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

// R8.4-C: Bank Statement History - a read-only review / investigation view
// of one company + bank account's imported statement rows. Every filter is
// applied by the server (GET /api/bank-recon/statement-history), which also
// decides each row's status and explanation; this page only displays them.
// Matching, confirming, unmatching and ignoring stay in the reconciliation
// workspace - the detail links there.

async function getJson(url) {
  const res = await fetch(`${API_BASE}${url}`, { credentials: "include", headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    handleAuthError(res.status);
    const err = new Error(data.message || "Request failed");
    err.status = res.status;
    throw err;
  }
  return data;
}

function StatusBadge({ status }) {
  const d = STATUS_DISPLAY[status] || { label: status, tone: "" };
  return <span className={`brc-match-badge ${d.tone}`}>{d.label}</span>;
}

function Flags({ row }) {
  const flags = rowFlags(row);
  if (!flags.length) return null;
  return (
    <span className="brc-history-flags">
      {flags.map((f) => (
        <span key={f} className="brc-history-flag">{f}</span>
      ))}
    </span>
  );
}

function Field({ label, children }) {
  return (
    <div className="brc-detail-field">
      <dt>{label}</dt>
      <dd>{children === null || children === undefined || children === "" ? "—" : children}</dd>
    </div>
  );
}

function DocumentsTable({ documents, bankAmount, total, difference, label = "Bank transaction" }) {
  return (
    <div className="brc-table-wrap">
      <table className="brc-table brc-group-table">
        <thead>
          <tr>
            <th>Document</th>
            <th>Date</th>
            <th>Payee / Payer</th>
            <th>Check / Ref.</th>
            <th className="amount">Amount</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((d) => (
            <tr key={d.matchId}>
              <td>{d.bookSourceType} {d.voucherNo || `#${d.bookSourceId}`}</td>
              <td>{d.txnDate}</td>
              <td>{d.partyName}</td>
              <td>{[d.checkNo, d.referenceNo].filter(Boolean).join(" / ")}</td>
              <td className="amount">{formatPeso(d.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan="4">Total</td>
            <td className="amount" data-testid="detail-total">{formatPeso(total)}</td>
          </tr>
          <tr>
            <td colSpan="4">{label}</td>
            <td className="amount">{formatPeso(bankAmount)}</td>
          </tr>
          <tr className={Number(difference) === 0 ? "brc-group-balanced" : "brc-group-off"}>
            <td colSpan="4">Difference</td>
            <td className="amount" data-testid="detail-difference">{formatPeso(difference)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function CandidateList({ candidates }) {
  return candidates.map((c, i) => (
    <div key={c.matchGroup || c.id} className="brc-detail-candidate">
      <p>
        <strong>
          {c.group
            ? `${candidates.filter((x) => x.group).length > 1 ? `Option ${String.fromCharCode(65 + i)}: ` : ""}Combination of ${c.members.length} receipts`
            : `${c.bookSourceType} ${c.detail?.voucherNo || `#${c.bookSourceId}`}`}
        </strong>{" "}
        · {c.matchType} · confidence {Number(c.confidenceScore).toFixed(0)}%
      </p>
      {c.group ? (
        <DocumentsTable
          documents={c.members}
          bankAmount={c.depositAmount}
          total={c.total}
          difference={c.difference}
          label="Bank deposit"
        />
      ) : (
        <p className="brc-preview-meta">
          {c.detail?.txnDate} · {c.detail?.payeeName || c.detail?.customerName || c.detail?.preparedFor} · {formatPeso(c.amount)}
        </p>
      )}
      <p className="brc-explanation">{c.explanation}</p>
    </div>
  ));
}

function DetailDrawer({ lineId, onClose }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const closeRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError("");
    getJson(`/api/bank-recon/statement-history/lines/${lineId}`)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [lineId]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const line = detail?.line;
  const m = detail?.confirmedMatch;
  return (
    <div className="brc-drawer-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="brc-drawer" role="dialog" aria-modal="true" aria-labelledby="brc-drawer-title" data-testid="history-drawer">
        <div className="brc-drawer-header">
          <h2 id="brc-drawer-title">Bank transaction</h2>
          <button type="button" ref={closeRef} className="brc-modal-close" aria-label="Close details" onClick={onClose}>
            ×
          </button>
        </div>
        {error && <div className="brc-inline-error" role="alert">{error}</div>}
        {!detail && !error && <p className="brc-empty">Loading...</p>}
        {detail && (
          <>
            <p className="brc-detail-status">
              <StatusBadge status={detail.status} /> <Flags row={{ carriedForward: Boolean(detail.carriedForward), possibleDuplicate: detail.possibleDuplicate, highConfidence: detail.highConfidence }} />
              {detail.readOnly && <span className="brc-history-flag readonly">Read-only · session finalized</span>}
            </p>

            <section aria-label="Bank transaction details">
              <dl className="brc-detail-grid">
                <Field label="Date">{line.txnDate}</Field>
                <Field label="Value date">{line.valueDate}</Field>
                <Field label="Amount">{formatPeso(line.amount)}</Field>
                <Field label="Direction">{line.direction === "OUT" ? "Debit (money out)" : "Credit (money in)"}</Field>
                <Field label="Description">{line.description}</Field>
                <Field label="Check No.">{line.checkNo}</Field>
                <Field label="Reference">{line.referenceNo}</Field>
                <Field label="Bank reference">{line.bankReference}</Field>
                <Field label="Bank account">{`${detail.bankAccount.bankCode} - ${detail.bankAccount.bankName}`}</Field>
                <Field label="Company">{detail.company.name}</Field>
                <Field label="Imported in session">{periodLabel(detail.importSession)}</Field>
                <Field label="Import batch">{`${detail.batch.fileName || `#${detail.batch.id}`} · ${detail.batch.importedAt || ""}${detail.batch.importedBy ? ` by ${detail.batch.importedBy}` : ""}`}</Field>
              </dl>
            </section>

            {detail.carriedForward && (
              <section className="brc-detail-section" aria-label="Carried forward">
                <h3>{detail.carriedForward.label}</h3>
                <p>
                  Original session {periodLabel({ id: detail.carriedForward.from.sessionId, ...detail.carriedForward.from })}; transaction dated {line.txnDate}.
                  {" "}Now worked in session {periodLabel(detail.carriedForward.currentSession)}.
                </p>
                {detail.reasonOutstanding && <p>Still outstanding: {detail.reasonOutstanding}</p>}
              </section>
            )}

            {m && (
              <section className="brc-detail-section" aria-label="Confirmed match">
                <h3>{m.oneToMany ? `Matched to ${m.documents.length} official receipts` : "Matched document"}</h3>
                <p className="brc-preview-meta">
                  {m.matchType}{m.confidenceScore !== null ? ` · confidence ${m.confidenceScore.toFixed(0)}%` : ""}
                  {m.oneToMany ? ` · match group ${m.matchGroup.slice(0, 8)}` : ""}
                  {` · confirmed by ${m.confirmedBy || "—"} on ${m.confirmedAt || "—"} in session ${periodLabel(m.session)}`}
                </p>
                <DocumentsTable documents={m.documents} bankAmount={m.bankAmount} total={m.total} difference={m.difference} label={m.oneToMany ? "Bank deposit" : "Bank transaction"} />
                <p className="brc-explanation" data-testid="detail-explanation">{m.explanation}</p>
              </section>
            )}

            {!m && detail.status !== "IGNORED" && (
              <section className="brc-detail-section" aria-label="Reconciliation">
                <h3>Not reconciled</h3>
                {detail.reasonOutstanding && !detail.carriedForward && <p>{detail.reasonOutstanding}</p>}
                {detail.candidates.length > 0 ? (
                  <>
                    <p>The matching engine suggests (nothing is confirmed until the accountant confirms it in the workspace):</p>
                    <CandidateList candidates={detail.candidates} />
                  </>
                ) : (
                  <p>The matching engine has no candidate for this transaction.</p>
                )}
                {detail.readOnly ? (
                  <p className="brc-history-flag readonly">The session is finalized - nothing can be changed here.</p>
                ) : (
                  <Link className="brc-btn primary brc-link-btn" to={`/reports/bank-reconciliation/${detail.workingSession.id}`}>
                    Open in reconciliation workspace (session {periodLabel(detail.workingSession)})
                  </Link>
                )}
              </section>
            )}

            {detail.ignored && (
              <section className="brc-detail-section" aria-label="Ignored">
                <h3>Ignored</h3>
                <p>
                  Ignored{detail.ignored.by ? ` by ${detail.ignored.by}` : ""}{detail.ignored.at ? ` on ${detail.ignored.at}` : ""}. Reason: {detail.ignored.reason || "none recorded"}.
                </p>
                <p className="brc-preview-meta">{detail.ignored.unIgnoreRule}</p>
              </section>
            )}

            {detail.possibleDuplicate && (
              <section className="brc-detail-section" aria-label="Possible duplicate">
                <h3>Possible duplicate</h3>
                <p>This row was imported before duplicate protection existed. Nothing is merged or deleted automatically.</p>
                {detail.duplicates.length ? (
                  <ul className="brc-detail-list">
                    {detail.duplicates.map((d) => (
                      <li key={d.id}>
                        Suspected duplicate: {d.txnDate} · {d.description} · {formatPeso(Number(d.debit) > 0 ? d.debit : d.credit)} · {d.matchStatus} · from {d.batchFileName} ({d.importedAt}) in session #{d.sessionId}. {d.evidence}.
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No identical row is stored for this bank account.</p>
                )}
              </section>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

export default function BankStatementHistory() {
  const location = useLocation();
  const navigate = useNavigate();
  const initial = new URLSearchParams(location.search);
  const [companies, setCompanies] = useState([]);
  const [bankAccounts, setBankAccounts] = useState([]);
  const [companyId, setCompanyId] = useState(initial.get("companyId") || "");
  const [bankAccountId, setBankAccountId] = useState(initial.get("bankAccountId") || "");
  const [filters, setFilters] = useState(() => filtersFromSearch(location.search));
  const [draft, setDraft] = useState(() => filtersFromSearch(location.search));
  const [moreOpen, setMoreOpen] = useState(() => Boolean(initial.get("amountMin") || initial.get("amountMax") || initial.get("sessionId") || initial.get("batchId")));
  const [page, setPage] = useState(Number(initial.get("page")) || 1);
  const [tab, setTab] = useState(initial.get("tab") === "imports" ? "imports" : "transactions");
  const [data, setData] = useState(null);
  const [imports, setImports] = useState(null);
  const [importsPage, setImportsPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openLine, setOpenLine] = useState(null);
  const lastRowRef = useRef(null);

  useEffect(() => {
    getJson("/api/companies").then((c) => Array.isArray(c) && setCompanies(c)).catch(() => {});
    getJson("/api/bank-codes").then((b) => Array.isArray(b) && setBankAccounts(b.filter((x) => x.status === "ACTIVE"))).catch(() => {});
  }, []);

  const needsCompany = companies.length > 1 && !companyId;
  const scopeReady = Boolean(bankAccountId) && !needsCompany;
  const scope = { companyId: companies.length > 1 ? companyId : companyId || "", bankAccountId };

  // Keep the URL in step so the view can be shared / reopened.
  useEffect(() => {
    const qs = historyQuery(scope, filters, page);
    const tabPart = tab === "imports" ? `${qs ? "&" : ""}tab=imports` : "";
    navigate({ search: qs || tabPart ? `?${qs}${tabPart}` : "" }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, bankAccountId, filters, page, tab]);

  const load = useCallback(async () => {
    if (!scopeReady) {
      setData(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      setData(await getJson(`/api/bank-recon/statement-history?${historyQuery(scope, filters, page)}`));
    } catch (e) {
      setData(null);
      setError(e.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeReady, companyId, bankAccountId, filters, page]);

  useEffect(() => {
    if (tab === "transactions") load();
  }, [load, tab]);

  useEffect(() => {
    if (tab !== "imports" || !scopeReady) return;
    const p = new URLSearchParams(historyQuery(scope, {}, 1));
    if (importsPage > 1) p.set("page", String(importsPage));
    getJson(`/api/bank-recon/statement-history/imports?${p}`)
      .then(setImports)
      .catch((e) => {
        setImports(null);
        setError(e.message);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, scopeReady, companyId, bankAccountId, importsPage]);

  function applyFilters(e) {
    e?.preventDefault();
    setPage(1);
    setFilters({ ...draft });
  }
  function clearFilters() {
    setDraft(emptyFilters());
    setFilters(emptyFilters());
    setPage(1);
  }
  function viewBatch(batchId) {
    const next = { ...emptyFilters(), batchId: String(batchId) };
    setDraft(next);
    setFilters(next);
    setMoreOpen(true);
    setPage(1);
    setTab("transactions");
  }
  function openRow(row, el) {
    lastRowRef.current = el;
    setOpenLine(row.id);
  }
  const closeDrawer = useCallback(() => {
    setOpenLine(null);
    setTimeout(() => lastRowRef.current?.focus(), 0);
  }, []);

  const setDraftField = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const selectedBank = bankAccounts.find((b) => String(b.id) === String(bankAccountId));

  return (
    <div className="brc-page brc-history-page">
      <div className="brc-header-card">
        <div>
          <h1>Bank Statement History</h1>
          <p>Imported bank transactions of one bank account, their reconciliation status and matches. Read-only - reconcile in the workspace.</p>
        </div>
        <Link className="brc-btn brc-link-btn" to="/reports/bank-reconciliation">Back to Bank Reconciliation</Link>
      </div>

      <div className="brc-card">
        <div className="brc-history-scope">
          {companies.length > 1 && (
            <label>
              <span>Company</span>
              <select value={companyId} onChange={(e) => { setCompanyId(e.target.value); setPage(1); }} data-testid="history-company">
                <option value="">Select company</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span>Bank account</span>
            <select value={bankAccountId} onChange={(e) => { setBankAccountId(e.target.value); setPage(1); }} data-testid="history-bank">
              <option value="">Select bank account</option>
              {bankAccounts.map((b) => (
                <option key={b.id} value={b.id}>{b.bankCode} - {b.bankName}</option>
              ))}
            </select>
          </label>
        </div>
        {!scopeReady && (
          <p className="brc-preview-meta" data-testid="history-scope-hint">
            {needsCompany ? "Select the company and the bank account to see its statement history." : "Select a bank account to see its statement history."}
          </p>
        )}
        {scopeReady && (
          <div className="brc-history-tabs" role="tablist" aria-label="Statement history views">
            <button type="button" role="tab" aria-selected={tab === "transactions"} className={tab === "transactions" ? "active" : ""} onClick={() => setTab("transactions")}>
              Transactions
            </button>
            <button type="button" role="tab" aria-selected={tab === "imports"} className={tab === "imports" ? "active" : ""} onClick={() => setTab("imports")}>
              Imports
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="brc-inline-error" role="alert" data-testid="history-error">
          <span>{error}</span>
          <button type="button" onClick={() => setError("")}>Dismiss</button>
        </div>
      )}

      {scopeReady && tab === "transactions" && (
        <div className="brc-card">
          <form className="brc-history-filters" onSubmit={applyFilters} aria-label="Filter statement transactions">
            <label>
              <span>From</span>
              <input type="date" value={draft.from} onChange={setDraftField("from")} />
            </label>
            <label>
              <span>To</span>
              <input type="date" value={draft.to} onChange={setDraftField("to")} />
            </label>
            <label>
              <span>Status</span>
              <select value={draft.status} onChange={setDraftField("status")} data-testid="filter-status">
                {STATUS_FILTERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label>
              <span>Type</span>
              <select value={draft.type} onChange={setDraftField("type")} data-testid="filter-type">
                {TYPE_FILTERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="brc-history-search">
              <span>Search</span>
              <input type="search" value={draft.q} onChange={setDraftField("q")} placeholder="Check no., reference, bank reference, description" maxLength={100} data-testid="filter-q" />
            </label>
            <button type="button" className="brc-btn" aria-expanded={moreOpen} aria-controls="brc-more-filters" onClick={() => setMoreOpen((o) => !o)}>
              {moreOpen ? "Fewer filters" : "More filters"}
            </button>
            {moreOpen && (
              <div id="brc-more-filters" className="brc-history-more">
                <label>
                  <span>Amount from</span>
                  <input type="number" min="0" step="0.01" inputMode="decimal" value={draft.amountMin} onChange={setDraftField("amountMin")} />
                </label>
                <label>
                  <span>Amount to</span>
                  <input type="number" min="0" step="0.01" inputMode="decimal" value={draft.amountMax} onChange={setDraftField("amountMax")} />
                </label>
                <label>
                  <span>Reconciliation session</span>
                  <select value={draft.sessionId} onChange={setDraftField("sessionId")} data-testid="filter-session">
                    <option value="">Any session</option>
                    {(data?.sessions || []).map((s) => (
                      <option key={s.id} value={s.id}>{periodLabel(s)} ({s.status === "FINALIZED" ? "finalized" : "open"})</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Import batch ID</span>
                  <input type="number" min="1" step="1" value={draft.batchId} onChange={setDraftField("batchId")} />
                </label>
              </div>
            )}
            <div className="brc-history-filter-actions">
              <button type="submit" className="brc-btn primary">Apply filters</button>
              <button type="button" className="brc-btn" onClick={clearFilters} disabled={!activeFilterCount(draft) && !activeFilterCount(filters)}>
                Clear
              </button>
            </div>
          </form>

          <p className="brc-preview-meta" aria-live="polite" data-testid="history-count">
            {loading ? "Loading..." : data ? `${data.total} transaction(s) · ${data.scope.bankCode} - ${data.scope.bankName} · ${data.scope.companyName}` : ""}
          </p>

          <div className="brc-table-wrap">
            <table className="brc-table brc-history-table" data-testid="history-table">
              <caption className="brc-sr-only">Statement transactions of {selectedBank ? `${selectedBank.bankCode} - ${selectedBank.bankName}` : "the selected bank account"}. Select a row to open its details.</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Value date</th>
                  <th scope="col">Description</th>
                  <th scope="col">Check No.</th>
                  <th scope="col">Reference</th>
                  <th scope="col">Bank ref.</th>
                  <th scope="col" className="amount">Debit</th>
                  <th scope="col" className="amount">Credit</th>
                  <th scope="col">Status</th>
                  <th scope="col">Matched document</th>
                  <th scope="col">Session</th>
                  <th scope="col">Import</th>
                </tr>
              </thead>
              <tbody>
                {data && data.rows.length === 0 && (
                  <tr>
                    <td colSpan="12" className="brc-empty">No statement transactions match these filters.</td>
                  </tr>
                )}
                {(data?.rows || []).map((r) => (
                  <tr
                    key={r.id}
                    tabIndex={0}
                    className="brc-history-row"
                    aria-label={`${r.txnDate} ${r.description || ""} ${formatPeso(r.amount)} ${statusText(r)}. Open details`}
                    data-line-id={r.id}
                    onClick={(e) => openRow(r, e.currentTarget)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openRow(r, e.currentTarget);
                      }
                    }}
                  >
                    <td>{r.txnDate}</td>
                    <td>{r.valueDate || "—"}</td>
                    <td>{r.description}</td>
                    <td>{r.checkNo}</td>
                    <td>{r.referenceNo}</td>
                    <td>{r.bankReference}</td>
                    <td className="amount">{r.debit > 0 ? formatPeso(r.debit) : ""}</td>
                    <td className="amount">{r.credit > 0 ? formatPeso(r.credit) : ""}</td>
                    <td>
                      <StatusBadge status={r.status} />
                      <Flags row={r} />
                    </td>
                    <td>
                      {r.match ? `${r.match.documents.join(", ")}${r.match.oneToMany ? " (combined)" : ""} · ${r.match.matchType}` : "—"}
                    </td>
                    <td>{periodLabel(r.session)}</td>
                    <td>{r.batch.fileName || `#${r.batch.id}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data && data.total > 0 && (
            <nav className="brc-history-pager" aria-label="Statement history pages">
              <button type="button" className="brc-btn" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
                Previous
              </button>
              <span data-testid="history-page">Page {data.page} of {data.pageCount}</span>
              <button type="button" className="brc-btn" disabled={page >= data.pageCount || loading} onClick={() => setPage((p) => p + 1)}>
                Next
              </button>
            </nav>
          )}
        </div>
      )}

      {scopeReady && tab === "imports" && (
        <div className="brc-card">
          <h2>Import history</h2>
          <div className="brc-table-wrap">
            <table className="brc-table" data-testid="imports-table">
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Imported</th>
                  <th scope="col">Session</th>
                  <th scope="col" className="amount">Rows</th>
                  <th scope="col" className="amount">Imported</th>
                  <th scope="col" className="amount">Duplicates</th>
                  <th scope="col" className="amount">Ignored</th>
                  <th scope="col">Parser</th>
                  <th scope="col">Status</th>
                  <th scope="col"></th>
                </tr>
              </thead>
              <tbody>
                {imports && imports.rows.length === 0 && (
                  <tr>
                    <td colSpan="10" className="brc-empty">No statements imported for this bank account yet.</td>
                  </tr>
                )}
                {(imports?.rows || []).map((b) => (
                  <tr key={b.id}>
                    <td>{b.fileName || `#${b.id}`} <span className="brc-preview-meta">(batch #{b.id})</span></td>
                    <td>{b.importedAt}{b.importedBy ? ` by ${b.importedBy}` : ""}</td>
                    <td>{periodLabel({ id: b.sessionId, periodStart: b.sessionPeriodStart, periodEnd: b.sessionPeriodEnd })}</td>
                    <td className="amount">{b.rowCount}</td>
                    <td className="amount">{b.importedCount}</td>
                    <td className="amount">{b.duplicateCount}</td>
                    <td className="amount">{b.ignoredCount}</td>
                    <td>{b.parserVersion ? `v${b.parserVersion}` : "—"}</td>
                    <td>{b.status}</td>
                    <td>
                      <button type="button" className="brc-btn" onClick={() => viewBatch(b.id)}>View rows</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {imports && imports.pageCount > 1 && (
            <nav className="brc-history-pager" aria-label="Import history pages">
              <button type="button" className="brc-btn" disabled={importsPage <= 1} onClick={() => setImportsPage((p) => p - 1)}>Previous</button>
              <span>Page {imports.page} of {imports.pageCount}</span>
              <button type="button" className="brc-btn" disabled={importsPage >= imports.pageCount} onClick={() => setImportsPage((p) => p + 1)}>Next</button>
            </nav>
          )}
        </div>
      )}

      {openLine && <DetailDrawer lineId={openLine} onClose={closeDrawer} />}
    </div>
  );
}
