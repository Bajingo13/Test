import { useEffect, useMemo, useState } from "react";
import BeginningBalanceImportModal from "../../components/BeginningBalanceImportModal";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import "./ARAPBeginningBalance.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

function emptyLine(balanceType) {
  return {
    id: crypto.randomUUID(),
    partyId: "",
    partyCode: "",
    partyName: "",
    accountId: "",
    accountCode: "",
    accountTitle: "",
    particulars: "",
    referenceNo: "",
    dueDate: "",
    debit: balanceType === "AR" ? "" : "0",
    credit: balanceType === "AP" ? "" : "0",
    balanceAmount: "",
    scheduleDate: "",
    scheduleAmount: "",
    // Checkpoint 3D: each AR/AP beginning balance line is its own document
    // and may carry its own currency - currencyId defaults to the base
    // currency once loaded, so a PHP-only user never has to think about
    // this (section 13).
    currencyId: "",
    isManualRate: false,
    exchangeRate: "",
    rateDate: "",
  };
}

export default function ARAPBeginningBalance({ balanceType }) {
  const isAR = balanceType === "AR";
  const title = isAR ? "AR Beginning Balance" : "AP Beginning Balance";
  const partyLabel = isAR ? "Customer" : "Supplier";

  const [parties, setParties] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [rows, setRows] = useState([]);
  const [selectedId, setSelectedId] = useState(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");

  const [header, setHeader] = useState({
    balanceDate: new Date().toISOString().split("T")[0],
    currencyCode: "PHP",
    currencyName: "PHILIPPINE PESO",
    remarks: "",
  });

  const [form, setForm] = useState(emptyLine(balanceType));
  const [showImportModal, setShowImportModal] = useState(false);
  const [currencyOptions, setCurrencyOptions] = useState([]);
  const [baseCurrency, setBaseCurrency] = useState(null);

  useEffect(() => {
    loadParties();
    loadAccounts();
    loadBalances();
    loadCurrencies();
    setForm(emptyLine(balanceType));
  }, [balanceType]);

  async function loadCurrencies() {
    try {
      const res = await fetch(`${API_BASE}/api/currencies`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) return;
      const active = Array.isArray(data) ? data.filter((c) => c.isActive) : [];
      setCurrencyOptions(active);
      const base = active.find((c) => c.isBaseCurrency) || null;
      setBaseCurrency(base);
      setForm((prev) => ({ ...prev, currencyId: prev.currencyId || (base ? String(base.id) : "") }));
    } catch (err) {
      console.error("LOAD CURRENCIES ERROR:", err);
    }
  }

  const isForeignForm = form.currencyId && baseCurrency && String(form.currencyId) !== String(baseCurrency.id);

  async function loadParties() {
    try {
      const res = await fetch(`${API_BASE}/api/genlib`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to load General Libraries");
        return;
      }

      const filtered = data.filter((party) =>
        isAR ? party.type === "CUSTOMER" : party.type === "SUPPLIER"
      );

      setParties(filtered.filter((party) => party.status === "ACTIVE"));
    } catch (err) {
      console.error("LOAD PARTIES ERROR:", err);
    }
  }

  async function loadAccounts() {
    try {
      const res = await fetch(`${API_BASE}/api/coa`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to load Chart of Accounts");
        return;
      }

      const filtered = data.filter((account) => {
        const accountTitle = String(account.title || "").toLowerCase();

        return isAR
          ? accountTitle.includes("receivable")
          : accountTitle.includes("payable");
      });

      setAccounts(filtered);
    } catch (err) {
      console.error("LOAD ACCOUNTS ERROR:", err);
    }
  }

  async function loadBalances() {
    try {
      const res = await fetch(
        `${API_BASE}/api/arap-beginning-balances/${balanceType}`,
        {
          credentials: "include",
          headers: authHeaders(),
        }
      );

      const data = await res.json();

      if (!res.ok) {
        handleAuthError(res.status);
        return;
      }

      setRows(data);
    } catch (err) {
      console.error("LOAD AR/AP BEGINNING BALANCES ERROR:", err);
    }
  }

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();

    return rows.filter((row) => {
      const matchesSearch =
        !q ||
        [row.partyName, row.accountCode, row.accountTitle, row.referenceNo]
          .join(" ")
          .toLowerCase()
          .includes(q);

      const matchesStatus =
        statusFilter === "All" || (row.status || "Unpaid") === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [rows, search, statusFilter]);

  const totals = useMemo(() => {
    return filteredRows.reduce(
      (sum, row) => ({
        debit: sum.debit + Number(row.debit || 0),
        credit: sum.credit + Number(row.credit || 0),
        balance: sum.balance + Number(row.balanceAmount || 0),
      }),
      { debit: 0, credit: 0, balance: 0 }
    );
  }, [filteredRows]);

  function formatMoney(value) {
    return Number(value || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function handlePartyChange(value) {
    const party = parties.find((item) => String(item.id) === String(value));

    setForm((prev) => ({
      ...prev,
      partyId: party?.id || "",
      partyCode: party?.code || "",
      partyName: party?.name || "",
    }));
  }

  function handleAccountChange(value) {
    const account = accounts.find((item) => String(item.id) === String(value));

    setForm((prev) => ({
      ...prev,
      accountId: account?.id || "",
      accountCode: account?.code || "",
      accountTitle: account?.title || "",
    }));
  }

  function resetForm() {
    setSelectedId(null);
    setForm({ ...emptyLine(balanceType), currencyId: baseCurrency ? String(baseCurrency.id) : "" });
  }

  function editRow(row) {
    setSelectedId(row.id);

    const rowIsForeign = row.currencyId && baseCurrency && String(row.currencyId) !== String(baseCurrency.id);

    setForm({
      id: row.id,
      partyId: row.partyId || "",
      partyCode: row.partyCode || "",
      partyName: row.partyName || "",
      accountId: row.accountId || "",
      accountCode: row.accountCode || "",
      accountTitle: row.accountTitle || "",
      particulars: row.particulars || "",
      referenceNo: row.referenceNo || "",
      dueDate: row.dueDate || "",
      // Foreign lines: the editable amount is the ORIGINAL foreign amount,
      // not the base debit/credit - re-saving must not re-convert an
      // already-converted base figure a second time.
      debit: rowIsForeign ? (isAR ? row.foreignOriginalAmount : "") : row.debit || "",
      credit: rowIsForeign ? (isAR ? "" : row.foreignOriginalAmount) : row.credit || "",
      balanceAmount: row.balanceAmount || "",
      scheduleDate: row.scheduleDate || row.dueDate || "",
      scheduleAmount: row.scheduleAmount || row.balanceAmount || "",
      currencyId: row.currencyId ? String(row.currencyId) : (baseCurrency ? String(baseCurrency.id) : ""),
      isManualRate: rowIsForeign,
      exchangeRate: rowIsForeign ? row.currency?.exchangeRate || "" : "",
      rateDate: row.currency?.rateDate || "",
    });
  }

  async function saveBalance() {
    if (!form.accountId) return alert("Account is required.");
    if (!form.partyId) return alert(`${partyLabel} code is required.`);
    if (!form.referenceNo.trim()) return alert("Reference No. is required.");
    if (!form.dueDate) return alert("Due date is required.");

    const amount = isAR ? Number(form.debit || 0) : Number(form.credit || 0);

    if (amount <= 0) {
      return alert(`${isAR ? "Debit" : "Credit"} amount is required.`);
    }

    if (isForeignForm && (!form.exchangeRate || Number(form.exchangeRate) <= 0)) {
      return alert("Opening Exchange Rate is required for a foreign currency entry.");
    }

    const payload = {
      balanceType,
      ...header,
      line: {
        ...form,
        debit: isAR ? amount : 0,
        credit: isAR ? 0 : amount,
        balanceAmount: amount,
        scheduleDate: form.scheduleDate || form.dueDate,
        scheduleAmount: Number(form.scheduleAmount || amount),
        isManualRate: isForeignForm,
      },
    };

    try {
      const res = await fetch(`${API_BASE}/api/arap-beginning-balances`, {
        method: selectedId ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to save beginning balance.");
        return;
      }

      alert(`${title} saved successfully.`);
      resetForm();
      loadBalances();
    } catch (err) {
      console.error("SAVE AR/AP BEGINNING BALANCE ERROR:", err);
      alert("Unable to connect to server.");
    }
  }

  async function downloadTemplate() {
    try {
      const res = await fetch(
        `${API_BASE}/api/beginning-balances/${balanceType.toLowerCase()}/template?format=xlsx`,
        { credentials: "include", headers: authHeaders() }
      );

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert("Failed to generate template");
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${balanceType}_Beginning_Balance_Template.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("DOWNLOAD BEGINNING BALANCE TEMPLATE ERROR:", err);
      alert("Unable to download template.");
    }
  }

  async function removeBalance(id) {
    if (!confirm("Remove selected beginning balance?")) return;

    try {
      const res = await fetch(`${API_BASE}/api/arap-beginning-balances/${id}`, {
        method: "DELETE",
        credentials: "include",
        headers: authHeaders(),
      });

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert("Failed to remove beginning balance.");
        return;
      }

      resetForm();
      loadBalances();
    } catch (err) {
      console.error("DELETE AR/AP BEGINNING BALANCE ERROR:", err);
    }
  }

  return (
    <div className="arap-page">
      <div className="arap-header-card">
        <div>
          <h1>{title}</h1>
          <p>
            Encode opening {isAR ? "customer receivables" : "supplier payables"} and payment schedules.
          </p>
        </div>

        <div className="arap-header-actions">
          <button onClick={downloadTemplate} className="arap-btn">
            Download Template
          </button>
          <button onClick={() => setShowImportModal(true)} className="arap-btn">
            Import File
          </button>
          <button onClick={resetForm} className="arap-btn primary">
            + New Entry
          </button>
        </div>
      </div>

      <div className="arap-card">
        <div className="arap-grid">
          <div>
            <label>Beginning Date</label>
            <input
              type="date"
              value={header.balanceDate}
              onChange={(e) =>
                setHeader({ ...header, balanceDate: e.target.value })
              }
            />
          </div>

          <div>
            <label>Currency</label>
            <input
              value={header.currencyCode}
              onChange={(e) =>
                setHeader({ ...header, currencyCode: e.target.value })
              }
            />
          </div>

          <div>
            <label>Currency Name</label>
            <input
              value={header.currencyName}
              onChange={(e) =>
                setHeader({ ...header, currencyName: e.target.value })
              }
            />
          </div>

          <div>
            <label>Remarks</label>
            <input
              value={header.remarks}
              onChange={(e) =>
                setHeader({ ...header, remarks: e.target.value })
              }
              placeholder="Optional"
            />
          </div>
        </div>
      </div>

      <div className="arap-card">
        <h2>Balance Entry</h2>

        <div className="arap-entry-table-wrap">
          <table className="arap-entry-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Particulars</th>
                <th>Gen Ref</th>
                <th>Gen Name</th>
                <th>Reference No.</th>
                <th>Due Date</th>
                <th>Currency</th>
                <th>{isAR ? "Debit" : "Credit"}</th>
                {isForeignForm && <th>Opening Rate</th>}
                <th>Schedule Date</th>
              </tr>
            </thead>

            <tbody>
              <tr>
                <td>
                  <select
                    value={form.accountId}
                    onChange={(e) => handleAccountChange(e.target.value)}
                  >
                    <option value="">Select account</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} - {account.title}
                      </option>
                    ))}
                  </select>
                </td>

                <td>
                  <input
                    value={form.particulars || ""}
                    onChange={(e) =>
                      setForm({ ...form, particulars: e.target.value })
                    }
                    placeholder="Beginning balance"
                  />
                </td>

                <td>
                  <select
                    value={form.partyId}
                    onChange={(e) => handlePartyChange(e.target.value)}
                  >
                    <option value="">Select {partyLabel} code</option>
                    {parties.map((party) => (
                      <option key={party.id} value={party.id}>
                        {party.code}
                      </option>
                    ))}
                  </select>
                </td>

                <td>
                  <input value={form.partyName || ""} readOnly />
                </td>

                <td>
                  <input
                    value={form.referenceNo}
                    onChange={(e) =>
                      setForm({ ...form, referenceNo: e.target.value })
                    }
                    placeholder={isAR ? "AR-BEG-0001" : "AP-BEG-0001"}
                  />
                </td>

                <td>
                  <input
                    type="date"
                    value={form.dueDate}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        dueDate: e.target.value,
                        scheduleDate: form.scheduleDate || e.target.value,
                      })
                    }
                  />
                </td>

                <td>
                  <select
                    value={form.currencyId}
                    onChange={(e) => setForm({ ...form, currencyId: e.target.value })}
                  >
                    {currencyOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.currencySymbol} {c.currencyCode}{c.isBaseCurrency ? " (Base)" : ""}
                      </option>
                    ))}
                  </select>
                </td>

                <td>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={isAR ? form.debit : form.credit}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        debit: isAR ? e.target.value : 0,
                        credit: isAR ? 0 : e.target.value,
                        balanceAmount: e.target.value,
                        scheduleAmount: e.target.value,
                      })
                    }
                    placeholder="0.00"
                    className="arap-amount-input"
                  />
                </td>

                {isForeignForm && (
                  <td>
                    <input
                      type="number"
                      step="0.000001"
                      value={form.exchangeRate}
                      onChange={(e) => setForm({ ...form, exchangeRate: e.target.value })}
                      placeholder="e.g. 57.00"
                      className="arap-amount-input"
                    />
                  </td>
                )}

                <td>
                  <input
                    type="date"
                    value={form.scheduleDate}
                    onChange={(e) =>
                      setForm({ ...form, scheduleDate: e.target.value })
                    }
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="arap-actions">
          <button onClick={resetForm}>Cancel</button>
          <button onClick={saveBalance} className="arap-btn primary">
            {selectedId ? "Update Balance" : "Save Balance"}
          </button>
        </div>
      </div>

      <div className="arap-card">
        <h2>{title} List</h2>

        <div className="arap-list-toolbar">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${partyLabel.toLowerCase()}, account, or reference...`}
            className="arap-search-input"
          />

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="arap-status-select"
          >
            <option value="All">All Statuses</option>
            <option value="Unpaid">Unpaid</option>
            <option value="Partially Paid">Partially Paid</option>
            <option value="Paid">Paid</option>
          </select>
        </div>

        <div className="arap-table-wrap">
          <table className="arap-table">
            <thead>
              <tr>
                <th>{partyLabel}</th>
                <th>Account</th>
                <th>Reference</th>
                <th>Due Date</th>
                <th>Currency</th>
                <th>Debit</th>
                <th>Credit</th>
                <th>Balance</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>

            <tbody>
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan="10" className="arap-empty">
                    {rows.length === 0
                      ? `No ${title} records yet.`
                      : "No records match your search/filter."}
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => {
                  const rowIsForeign = row.currencyId && baseCurrency && String(row.currencyId) !== String(baseCurrency.id);
                  return (
                    <tr key={row.id}>
                      <td>{row.partyName}</td>
                      <td>
                        {row.accountCode} - {row.accountTitle}
                      </td>
                      <td>{row.referenceNo}</td>
                      <td>{row.dueDate}</td>
                      <td>{row.currencyCode || baseCurrency?.currencyCode || "PHP"}</td>
                      <td className="amount">
                        {rowIsForeign
                          ? `${row.currencyCode} ${formatMoney(isAR ? row.foreignOriginalAmount - (row.foreignPaidAmount || 0) : 0)}`
                          : `₱ ${formatMoney(row.debit)}`}
                      </td>
                      <td className="amount">
                        {rowIsForeign
                          ? `${row.currencyCode} ${formatMoney(!isAR ? row.foreignOriginalAmount - (row.foreignPaidAmount || 0) : 0)}`
                          : `₱ ${formatMoney(row.credit)}`}
                      </td>
                      <td className="amount">
                        ₱ {formatMoney(row.balanceAmount)}
                      </td>
                      <td>{row.status}</td>
                      <td>
                        <button onClick={() => editRow(row)}>Edit</button>
                        <button
                          onClick={() => removeBalance(row.id)}
                          className="danger"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>

            <tfoot>
              <tr>
                <td colSpan="4">Totals</td>
                <td className="amount">₱ {formatMoney(totals.debit)}</td>
                <td className="amount">₱ {formatMoney(totals.credit)}</td>
                <td className="amount">₱ {formatMoney(totals.balance)}</td>
                <td colSpan="2"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <BeginningBalanceImportModal
        open={showImportModal}
        module={balanceType.toLowerCase()}
        onClose={() => setShowImportModal(false)}
        onImported={loadBalances}
      />
    </div>
  );
}