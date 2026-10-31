import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import { useBankReconDialogs } from "../../components/BankReconDialogs.jsx";
import "./BankReconciliation.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

// R10: Deposit Slips - which posted Cash / Check receipts went to the bank
// together. The server decides which documents are eligible, computes the
// total and numbers the slip (DS-00001); this page only shows and submits.
// Bank Reconciliation later matches the statement deposit to the slip.

const STATUS_LABEL = { DRAFT: "Draft", DEPOSITED: "Deposited", RECONCILED: "Reconciled", CANCELLED: "Cancelled" };
const STATUS_TONE = { DRAFT: "pending", DEPOSITED: "suggested", RECONCILED: "matched", CANCELLED: "ignored" };
const today = () => new Date().toISOString().slice(0, 10);
const peso = (v) => `₱ ${Number(v || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const keyOf = (r) => `${r.sourceType}:${r.sourceId}`;

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include",
    headers: { ...authHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    handleAuthError(res.status);
    throw new Error(data.message || "Request failed");
  }
  return data;
}

function StatusBadge({ status }) {
  return <span className={`brc-match-badge ${STATUS_TONE[status] || ""}`}>{STATUS_LABEL[status] || status}</span>;
}

export default function DepositSlips() {
  const { confirmAction, askText, notify, element: dialogElement } = useBankReconDialogs();
  const [companies, setCompanies] = useState([]);
  const [bankAccounts, setBankAccounts] = useState([]);
  const [companyId, setCompanyId] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [list, setList] = useState(null);
  const [editor, setEditor] = useState(null); // { id?, depositNo?, depositDate, remarks, selected:Set }
  const [eligible, setEligible] = useState([]);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call("/api/companies").then((c) => Array.isArray(c) && setCompanies(c)).catch(() => {});
    call("/api/bank-codes").then((b) => Array.isArray(b) && setBankAccounts(b.filter((x) => x.status === "ACTIVE"))).catch(() => {});
  }, []);

  const needsCompany = companies.length > 1 && !companyId;
  const scopeReady = Boolean(bankAccountId) && !needsCompany;
  const scopeQuery = () => {
    const p = new URLSearchParams({ bankAccountId });
    if (companyId) p.set("companyId", companyId);
    return p;
  };

  const loadList = useCallback(async () => {
    if (!scopeReady) return setList(null);
    const p = scopeQuery();
    if (statusFilter) p.set("status", statusFilter);
    try {
      setList(await call(`/api/bank-recon/deposit-slips?${p}`));
    } catch (e) {
      notify(e.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeReady, companyId, bankAccountId, statusFilter]);

  useEffect(() => {
    loadList();
    setEditor(null);
    setDetail(null);
  }, [loadList]);

  const loadEligible = useCallback(async (depositDate, slipId) => {
    const p = scopeQuery();
    p.set("depositDate", depositDate);
    if (slipId) p.set("slipId", slipId);
    try {
      setEligible((await call(`/api/bank-recon/deposit-slips/eligible?${p}`)).rows);
    } catch (e) {
      setEligible([]);
      notify(e.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, bankAccountId]);

  useEffect(() => {
    if (editor) loadEligible(editor.depositDate, editor.id);
  }, [editor?.depositDate, editor?.id, loadEligible]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedRows = useMemo(() => (editor ? eligible.filter((r) => editor.selected.has(keyOf(r))) : []), [editor, eligible]);
  const total = selectedRows.reduce((s, r) => s + Math.round(r.amount * 100), 0) / 100;

  function startNew() {
    setDetail(null);
    setEditor({ depositDate: today(), remarks: "", selected: new Set() });
  }

  async function openSlip(id) {
    setEditor(null);
    try {
      const d = await call(`/api/bank-recon/deposit-slips/${id}`);
      if (d.status === "DRAFT") {
        setDetail(null);
        setEditor({ id: d.id, depositNo: d.depositNo, depositDate: d.depositDate, remarks: d.remarks || "", selected: new Set(d.lines.map(keyOf)) });
      } else {
        setDetail(d);
      }
    } catch (e) {
      notify(e.message);
    }
  }

  function toggle(row) {
    setEditor((ed) => {
      const selected = new Set(ed.selected);
      if (selected.has(keyOf(row))) selected.delete(keyOf(row));
      else selected.add(keyOf(row));
      return { ...ed, selected };
    });
  }

  async function save({ thenDeposit = false } = {}) {
    if (!selectedRows.length) return notify("Select at least one receipt.");
    setBusy(true);
    try {
      const body = { depositDate: editor.depositDate, remarks: editor.remarks, items: selectedRows.map((r) => ({ type: r.sourceType, id: r.sourceId })) };
      const saved = editor.id
        ? await call(`/api/bank-recon/deposit-slips/${editor.id}`, { method: "PUT", body })
        : await call("/api/bank-recon/deposit-slips", { method: "POST", body: { ...body, bankAccountId: Number(bankAccountId), ...(companyId ? { companyId: Number(companyId) } : {}) } });
      if (thenDeposit) {
        const ok = await confirmAction({
          title: "Mark deposited",
          body: `Mark deposit slip ${saved.depositNo} (${peso(saved.total)}) as deposited? It can no longer be edited - only cancelled.`,
          confirmLabel: "Mark Deposited",
        });
        if (ok) {
          await call(`/api/bank-recon/deposit-slips/${saved.id}/deposit`, { method: "POST" });
          notify(`Deposit slip ${saved.depositNo} marked deposited.`, "success");
          await loadList();
          await openSlip(saved.id);
          return;
        }
      }
      notify(`Deposit slip ${saved.depositNo} saved as draft (${peso(saved.total)}).`, "success");
      await loadList();
      await openSlip(saved.id);
    } catch (e) {
      notify(e.message);
      if (editor?.id || editor) loadEligible(editor.depositDate, editor.id);
    } finally {
      setBusy(false);
    }
  }

  async function cancelSlip(slip) {
    const reason = await askText({
      title: `Cancel deposit slip ${slip.depositNo}`,
      body: "Its receipts become available for another deposit slip. The slip is kept as cancelled.",
      inputLabel: "Reason for cancelling",
      confirmLabel: "Cancel Slip",
      danger: true,
    });
    if (!reason) return;
    setBusy(true);
    try {
      await call(`/api/bank-recon/deposit-slips/${slip.id}/cancel`, { method: "POST", body: { reason } });
      notify(`Deposit slip ${slip.depositNo} cancelled.`, "success");
      setEditor(null);
      await loadList();
      await openSlip(slip.id);
    } catch (e) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="brc-page brc-history-page">
      {dialogElement}
      <div className="brc-header-card">
        <div>
          <h1>Deposit Slips</h1>
          <p>Group the Cash and Check receipts you take to the bank. Bank Reconciliation matches the bank&apos;s deposit to the slip.</p>
        </div>
        <Link className="brc-btn brc-link-btn" to="/reports/bank-reconciliation">Back to Bank Reconciliation</Link>
      </div>

      <div className="brc-card">
        <div className="brc-history-scope">
          {companies.length > 1 && (
            <label>
              <span>Company</span>
              <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} data-testid="ds-company">
                <option value="">Select company</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          <label>
            <span>Bank account</span>
            <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} data-testid="ds-bank">
              <option value="">Select bank account</option>
              {bankAccounts.map((b) => <option key={b.id} value={b.id}>{b.bankCode} - {b.bankName}</option>)}
            </select>
          </label>
          {scopeReady && (
            <label>
              <span>Status</span>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} data-testid="ds-status">
                <option value="">All</option>
                <option value="DRAFT">Draft</option>
                <option value="DEPOSITED">Deposited</option>
                <option value="UNRECONCILED">Deposited, not yet reconciled</option>
                <option value="RECONCILED">Reconciled</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            </label>
          )}
        </div>
        {!scopeReady && (
          <p className="brc-preview-meta">{needsCompany ? "Select the company and the bank account." : "Select a bank account."}</p>
        )}
      </div>

      {scopeReady && (
        <div className="brc-card">
          <div className="brc-import-row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>Deposit slips ({list?.total ?? 0})</h2>
            <button type="button" className="brc-btn primary" onClick={startNew} disabled={busy}>+ New Deposit Slip</button>
          </div>
          <div className="brc-table-wrap">
            <table className="brc-table brc-history-table" style={{ minWidth: 640 }} data-testid="ds-table">
              <thead>
                <tr>
                  <th scope="col">Deposit No.</th>
                  <th scope="col">Deposit date</th>
                  <th scope="col" className="amount">Documents</th>
                  <th scope="col" className="amount">Total</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {list && list.rows.length === 0 && (
                  <tr><td colSpan="5" className="brc-empty">No deposit slips yet.</td></tr>
                )}
                {(list?.rows || []).map((r) => (
                  <tr
                    key={r.id}
                    tabIndex={0}
                    className="brc-history-row"
                    aria-label={`${r.depositNo} ${r.depositDate} ${peso(r.totalAmount)} ${STATUS_LABEL[r.status]}. Open`}
                    onClick={() => openSlip(r.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openSlip(r.id);
                      }
                    }}
                  >
                    <td>{r.depositNo}</td>
                    <td>{r.depositDate}</td>
                    <td className="amount">{r.lineCount}</td>
                    <td className="amount">{peso(r.totalAmount)}</td>
                    <td>
                      <StatusBadge status={r.status} />
                      {r.missingFromStatement && <span className="brc-history-flag">Not on the imported statement yet</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {scopeReady && editor && (
        <div className="brc-card" data-testid="ds-editor">
          <h2>{editor.id ? `Edit deposit slip ${editor.depositNo}` : "New deposit slip"}</h2>
          <div className="brc-history-filters">
            <label>
              <span>Deposit date</span>
              <input type="date" value={editor.depositDate} onChange={(e) => setEditor((ed) => ({ ...ed, depositDate: e.target.value }))} data-testid="ds-date" />
            </label>
            <label className="brc-history-search">
              <span>Remarks</span>
              <input type="text" maxLength={500} value={editor.remarks} onChange={(e) => setEditor((ed) => ({ ...ed, remarks: e.target.value }))} />
            </label>
          </div>
          <h3>Receipts that can be deposited</h3>
          <p className="brc-preview-meta">Posted Cash and Check documents received into this bank account on or before the deposit date, not yet deposited or reconciled.</p>
          <div className="brc-table-wrap">
            <table className="brc-table brc-history-table" style={{ minWidth: 720 }} data-testid="ds-eligible">
              <thead>
                <tr>
                  <th scope="col"><span className="brc-sr-only">Select</span></th>
                  <th scope="col">Document</th>
                  <th scope="col">Date</th>
                  <th scope="col">Payer</th>
                  <th scope="col">Method</th>
                  <th scope="col">Check No.</th>
                  <th scope="col" className="amount">Amount</th>
                </tr>
              </thead>
              <tbody>
                {eligible.length === 0 && <tr><td colSpan="7" className="brc-empty">No receipts can be deposited for this date.</td></tr>}
                {eligible.map((r) => (
                  <tr key={keyOf(r)}>
                    <td>
                      <input
                        type="checkbox"
                        checked={editor.selected.has(keyOf(r))}
                        onChange={() => toggle(r)}
                        aria-label={`Include ${r.sourceType} ${r.voucherNo} ${peso(r.amount)}`}
                        data-testid={`ds-pick-${r.sourceType}-${r.sourceId}`}
                      />
                    </td>
                    <td>{r.sourceType} {r.voucherNo}</td>
                    <td>{r.txnDate}</td>
                    <td>{r.partyName}</td>
                    <td>{r.paymentMethod}</td>
                    <td>{r.checkNo || "—"}</td>
                    <td className="amount">{peso(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="brc-ds-total">
            {selectedRows.length} selected · Total <output data-testid="ds-total">{peso(total)}</output>
          </p>
          <div className="brc-history-filter-actions">
            <button type="button" className="brc-btn" onClick={() => save()} disabled={busy}>Save Draft</button>
            <button type="button" className="brc-btn primary" onClick={() => save({ thenDeposit: true })} disabled={busy}>Save &amp; Mark Deposited</button>
            {editor.id && (
              <button type="button" className="brc-btn" onClick={() => cancelSlip({ id: editor.id, depositNo: editor.depositNo })} disabled={busy}>Cancel Slip</button>
            )}
            <button type="button" className="brc-btn" onClick={() => setEditor(null)} disabled={busy}>Close</button>
          </div>
        </div>
      )}

      {scopeReady && detail && (
        <div className="brc-card" data-testid="ds-detail">
          <div className="brc-import-row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>Deposit slip {detail.depositNo}</h2>
            <StatusBadge status={detail.status} />
          </div>
          <dl className="brc-detail-grid">
            <div className="brc-detail-field"><dt>Company</dt><dd>{detail.companyName}</dd></div>
            <div className="brc-detail-field"><dt>Bank account</dt><dd>{detail.bankCode} - {detail.bankName}</dd></div>
            <div className="brc-detail-field"><dt>Deposit date</dt><dd>{detail.depositDate}</dd></div>
            <div className="brc-detail-field"><dt>Deposited</dt><dd>{detail.depositedAt ? `${detail.depositedAt} by ${detail.depositedBy}` : "—"}</dd></div>
            {detail.status === "CANCELLED" && (
              <div className="brc-detail-field"><dt>Cancelled</dt><dd>{detail.cancelledAt} by {detail.cancelledBy}: {detail.cancelReason}</dd></div>
            )}
          </dl>
          <h3>Included transactions</h3>
          <div className="brc-table-wrap">
            <table className="brc-table brc-group-table" style={{ minWidth: 520 }}>
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">Document</th>
                  <th scope="col">Date</th>
                  <th scope="col">Payment method</th>
                  <th scope="col" className="amount">Amount</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.sourceType}</td>
                    <td>{l.voucherNo}</td>
                    <td>{l.txnDate}</td>
                    <td>{l.paymentMethod}{l.checkNo ? ` #${l.checkNo}` : ""}</td>
                    <td className="amount">{peso(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan="4">Total</td>
                  <td className="amount" data-testid="ds-detail-total">{peso(detail.totalAmount)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <section className="brc-detail-section" aria-label="Bank reconciliation">
            <h3>Bank Recon: {detail.bankRecon.status === "MATCHED" ? "Matched" : "Not matched"}</h3>
            {detail.bankRecon.match ? (
              <>
                <p>
                  Statement deposit of {detail.bankRecon.match.statementDate} for {peso(detail.bankRecon.match.bankAmount)} · confirmed by{" "}
                  {detail.bankRecon.match.confirmedBy || "—"} on {detail.bankRecon.match.matchedAt}
                </p>
                <p className="brc-explanation">{detail.bankRecon.match.explanation}</p>
              </>
            ) : (
              <p className="brc-preview-meta">
                {detail.status === "DEPOSITED"
                  ? "Import the bank statement and run matching in Bank Reconciliation - the deposit is matched to this slip there."
                  : "Not part of a bank reconciliation."}
              </p>
            )}
          </section>
          <div className="brc-history-filter-actions">
            {detail.status === "DEPOSITED" && (
              <button type="button" className="brc-btn" onClick={() => cancelSlip(detail)} disabled={busy}>Cancel Slip</button>
            )}
            <button type="button" className="brc-btn" onClick={() => setDetail(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
