import React, { useEffect, useMemo, useState } from "react";
import "./TransactionFormLayout.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

function createLine() {
  return {
    id: crypto.randomUUID(),
    accountId: "",
    particulars: "",
    genRef: "",
    genName: "",
    debit: "",
    credit: "",
  };
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function TransactionFormLayout({
  title,
  code,
  partyLabel,
  showCheckNo = false,
  defaultDescription = "",
  defaultLines = [createLine(), createLine()],
}) {
  const [mode, setMode] = useState("list");
  const [transactions, setTransactions] = useState([]);
  const [selectedTransaction, setSelectedTransaction] = useState(null);

  const [accountOptions, setAccountOptions] = useState([]);
  const [partyOptions, setPartyOptions] = useState([]);
  const [unpaidApvs, setUnpaidApvs] = useState([]);
  const [showApvModal, setShowApvModal] = useState(false);
  const [apvApplications, setApvApplications] = useState([]);

  const [invoiceApplications, setInvoiceApplications] = useState([]);
  const [unpaidInvoices, setUnpaidInvoices] = useState([]);
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);

  const [form, setForm] = useState({
    date: new Date().toISOString().split("T")[0],
    referenceNo: "",
    party: "",
    partyId: null,
    description: defaultDescription,
    checkNo: "",
    status: "Draft",
  });

  const [lines, setLines] = useState(
    defaultLines.map((line) => ({
      ...line,
      genRef: line.genRef || "",
      genName: line.genName || "",
    }))
  );

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadAccounts();
    loadParties();
    loadTransactions();

    if (code === "CV" && form.party) {
  loadUnpaidApvs();
}
  }, []);

  async function loadAccounts() {
    try {
      const res = await fetch(`${API_BASE}/api/coa`, {
        credentials: "include",
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to load Chart of Accounts");
        return;
      }

      setAccountOptions(data);
    } catch (err) {
      console.error("LOAD COA ERROR:", err);
    }
  }

  async function loadParties() {
    try {
      const res = await fetch(`${API_BASE}/api/genlib`, {
        credentials: "include",
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to load General Libraries");
        return;
      }

      let filtered = data;

      if (partyLabel.toLowerCase().includes("supplier")) {
        filtered = data.filter((item) => item.type === "SUPPLIER");
      }

      if (partyLabel.toLowerCase().includes("customer")) {
        filtered = data.filter((item) => item.type === "CUSTOMER");
      }

      setPartyOptions(filtered.filter((item) => item.status === "ACTIVE"));
    } catch (err) {
      console.error("LOAD GENLIB ERROR:", err);
    }
  }

  async function loadTransactions() {
    try {
      const endpoint = code === "CV" ? "cv" : "apv";
      const res = await fetch(`${API_BASE}/api/${endpoint}`, {
        credentials: "include",
      });

      const data = await res.json();

      if (!res.ok) return;

      if (code === "APV") {
        setTransactions(
          data.map((item) => ({
            id: item.id,
            referenceNo: item.referenceNo || item.voucherNo,
            date: item.transactionDate,
            party: item.supplierName,
            amount: item.totalCredit || item.totalDebit,
            paidAmount: item.paidAmount || 0,
            balanceAmount: item.balanceAmount ?? item.totalCredit ?? item.totalDebit,
            status: item.paymentStatus || item.status,
            form: {
              date: item.transactionDate,
              referenceNo: item.referenceNo || item.voucherNo,
              party: item.supplierName,
              partyId: item.supplierId,
              description: item.description,
              checkNo: item.remarks || "",
              status: item.status,
            },
            lines: [],
          }))
        );
      }

      if (code === "CV") {
        setTransactions(
          data.map((item) => ({
            id: item.id,
            referenceNo: item.referenceNo || item.voucherNo,
            date: item.transactionDate,
            party: item.payeeName,
            amount: item.totalCredit || item.totalDebit,
            status: item.status,
            form: {
              date: item.transactionDate,
              referenceNo: item.referenceNo || item.voucherNo,
              party: item.payeeName,
              partyId: item.payeeId,
              description: item.description,
              checkNo: item.checkNo || "",
              status: item.status,
            },
            lines: [],
          }))
        );
      }
    } catch (err) {
      console.error("LOAD TRANSACTIONS ERROR:", err);
    }
  }

  async function loadUnpaidApvs() {
  try {
    const supplierId = form.partyId;
    const supplierName = form.party;

    const query = new URLSearchParams();

    if (supplierId) {
      query.append("supplierId", supplierId);
    } else if (supplierName) {
      query.append("supplierName", supplierName);
    }

    const res = await fetch(
      `${API_BASE}/api/apv/unpaid?${query.toString()}`,
      {
        credentials: "include",
      }
    );

    async function loadUnpaidInvoices() {
  try {
    const customerId = form.partyId;
    const customerName = form.party;

    const query = new URLSearchParams();

    if (customerId) {
      query.append("customerId", customerId);
    } else if (customerName) {
      query.append("customerName", customerName);
    }

    const res = await fetch(
      `${API_BASE}/api/invoices/unpaid?${query.toString()}`,
      {
        credentials: "include",
      }
    );

    const data = await res.json();

    setUnpaidInvoices(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error("LOAD UNPAID INVOICES ERROR:", err);
    setUnpaidInvoices([]);
  }
}

    const data = await res.json();

    if (!res.ok) {
      alert(data.message || "Failed to load unpaid APV records");
      return;
    }

    setUnpaidApvs(data);
  } catch (err) {
    console.error("LOAD UNPAID APV ERROR:", err);
  }
}

  const totals = useMemo(() => {
    const totalDebit = lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
    const totalCredit = lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);

    return {
      totalDebit,
      totalCredit,
      balanced: totalDebit === totalCredit && totalDebit > 0,
    };
  }, [lines]);

  function isAPorARAccount(accountId) {
  const account = accountOptions.find(
    (acc) => String(acc.id) === String(accountId)
  );

  if (!account) return false;

  const title = String(account.title || "").toLowerCase();

  const validations = Array.isArray(account.validations)
    ? account.validations.map((v) => String(v).toLowerCase())
    : [];

  return (
    title.includes("accounts payable") ||
    title.includes("account payable") ||
    title.includes("accounts receivable") ||
    title.includes("account receivable") ||
    validations.some(
      (v) =>
        v.includes("ap") ||
        v.includes("ar") ||
        v.includes("payable") ||
        v.includes("receivable")
    )
  );
}

  function resetForm() {
    setForm({
      date: new Date().toISOString().split("T")[0],
      referenceNo: "",
      party: "",
      partyId: null,
      description: defaultDescription,
      checkNo: "",
      status: "Draft",
    });

    setLines(
      defaultLines.map((line) => ({
        ...line,
        id: crypto.randomUUID(),
        genRef: "",
        genName: "",
      }))
    );

    setSelectedTransaction(null);
    setApvApplications([]);
    setError("");
  }

  function handleAddNew() {
    resetForm();
    setMode("form");
  }

  function handleBackToList() {
    setMode("list");
    setError("");
  }

  function handlePrint() {
    window.print();
  }

  function handleExportCSV() {
    const rows = [
      ["Company", "ASTREABLUE COMPANY"],
      ["Transaction", title],
      ["Reference No.", form.referenceNo],
      ["Date", form.date],
      [partyLabel, form.party],
      ["Description", form.description],
      [],
      ["Account", "Particulars", "Gen Ref", "Gen Name", "Debit", "Credit"],
      ...lines.map((line) => {
        const account = accountOptions.find(
          (acc) => String(acc.id) === String(line.accountId)
        );

        return [
          account ? `${account.code} - ${account.title}` : "",
          line.particulars,
          line.genRef || "",
          line.genName || "",
          line.debit || "0.00",
          line.credit || "0.00",
        ];
      }),
      [],
      ["Totals", "", "", "", totals.totalDebit, totals.totalCredit],
    ];

    const csvContent = rows
      .map((row) =>
        row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")
      )
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = `${code}-${form.referenceNo || "transaction"}.csv`;
    link.click();

    URL.revokeObjectURL(url);
  }

  async function handleView(transaction) {
    setSelectedTransaction(transaction);

    try {
      const endpoint = code === "CV" ? "cv" : "apv";
      const res = await fetch(`${API_BASE}/api/${endpoint}/${transaction.id}`, {
        credentials: "include",
      });

      const data = await res.json();

      if (res.ok) {
        setForm({
          date: data.transactionDate,
          referenceNo: data.referenceNo || data.voucherNo,
          party: code === "CV" ? data.payeeName : data.supplierName,
          partyId: code === "CV" ? data.payeeId : data.supplierId,
          description: data.description,
          checkNo: code === "CV" ? data.checkNo || "" : data.remarks || "",
          status: data.status,
        });

        setLines(
          data.lines.map((line) => ({
            id: crypto.randomUUID(),
            accountId: line.accountId || "",
            particulars: line.particulars || "",
            genRef: line.genRef || "",
            genName: line.genName || "",
            debit: line.debit || "",
            credit: line.credit || "",
          }))
        );

        setApvApplications(data.applications || []);
        setMode("form");
        return;
      }
    } catch (err) {
      console.error("LOAD TRANSACTION DETAILS ERROR:", err);
    }

    setForm(transaction.form);
    setLines(transaction.lines);
    setApvApplications([]);
    setMode("form");
  }

  function updateForm(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handlePartyChange(value) {
    const selectedParty = partyOptions.find(
      (party) => party.name.toLowerCase() === value.toLowerCase()
    );

    setForm((prev) => ({
      ...prev,
      party: value,
      partyId: selectedParty ? selectedParty.id : null,
    }));

   setLines((prev) =>
  prev.map((line) => {
    if (!isAPorARAccount(line.accountId)) return line;

    return {
      ...line,
      genRef: selectedParty?.code || "",
      genName: selectedParty?.name || value || "",
    };
  })
);

// Load outstanding transactions depending on transaction type
if (code === "CV") {
  setTimeout(() => {
    loadUnpaidApvs();
  }, 50);
}

if (code === "OR") {
  setTimeout(() => {
    loadUnpaidInvoices();
  }, 50);
}
  }

  function updateLine(id, field, value) {
    setLines((prev) =>
      prev.map((line) => {
        if (line.id !== id) return line;

        const updated = { ...line, [field]: value };

        if (field === "debit" && value !== "") updated.credit = "";
        if (field === "credit" && value !== "") updated.debit = "";

        if (field === "accountId") {
          const selectedParty = partyOptions.find(
            (party) => party.name.toLowerCase() === form.party.toLowerCase()
          );

          if (isAPorARAccount(value)) {
            updated.genRef = selectedParty?.code || "";
            updated.genName = selectedParty?.name || form.party || "";
          } else {
            updated.genRef = "";
            updated.genName = "";
          }
        }

        if (field === "genRef") {
          const selectedParty = partyOptions.find(
            (party) => party.code === value
          );

          if (selectedParty) {
            updated.genRef = selectedParty.code || "";
            updated.genName = selectedParty.name || "";
          } else {
            updated.genRef = value;
            updated.genName = "";
          }
        }

        return updated;
      })
    );
  }

  function addLine() {
    setLines((prev) => [...prev, createLine()]);
  }

  function removeLine(id) {
    if (lines.length <= 2) return;
    setLines((prev) => prev.filter((line) => line.id !== id));
  }

  function validate() {
  if (!form.date) return "Date is required.";
  if (!form.referenceNo.trim()) return "Reference number is required.";
  if (!form.party.trim()) return `${partyLabel} is required.`;

  for (const line of lines) {
    const debit = Number(line.debit || 0);
    const credit = Number(line.credit || 0);

    if (!line.accountId) return "Each line must have an account selected.";
    if (debit > 0 && credit > 0) return "A line cannot have both debit and credit.";
    if (debit <= 0 && credit <= 0) return "Each line must have either debit or credit.";

    if (isAPorARAccount(line.accountId) && (!line.genRef || !line.genName)) {
      return "Gen Ref and Gen Name are required for AP/AR validated accounts.";
    }
  }

  if (lines.length < 2) return "At least two lines are required.";
  if (!totals.balanced) return "Debit and Credit totals must be equal.";

  return "";
}

  function toggleApvApplication(apv) {
    setApvApplications((prev) => {
      const exists = prev.find((item) => Number(item.sourceId || item.apvId || item.id) === Number(apv.id));

      if (exists) {
        return prev.filter((item) => Number(item.sourceId || item.apvId || item.id) !== Number(apv.id));
      }

      return [
        ...prev,
        {
          sourceType: apv.sourceType || "APV",
          sourceId: apv.id,
          apvId: apv.id,
          voucherNo: apv.voucherNo,
          supplierName: apv.supplierName,
          totalAmount: Number(apv.totalAmount || 0),
          paidAmount: Number(apv.paidAmount || 0),
          balanceAmount: Number(apv.balanceAmount || apv.totalAmount || 0),
          amount: Number(apv.balanceAmount || apv.totalAmount || 0),
          applicationDate: form.date,
        },
      ];
    });
  }

  function updateApvApplicationAmount(apvId, value) {
    setApvApplications((prev) =>
      prev.map((item) =>
        Number(item.sourceId || item.apvId) === Number(apvId)
          ? { ...item, amount: value }
          : item
      )
    );
  }

  function applySelectedApvsToLines() {
    if (apvApplications.length === 0) {
      setShowApvModal(false);
      return;
    }

function toggleInvoiceApplication(invoice) {
  setInvoiceApplications((prev) => {
    const exists = prev.find(
      (item) =>
        Number(item.sourceId || item.invoiceId || item.id) === Number(invoice.id)
    );

    if (exists) {
      return prev.filter(
        (item) =>
          Number(item.sourceId || item.invoiceId || item.id) !== Number(invoice.id)
      );
    }

    return [
      ...prev,
      {
        sourceType: invoice.sourceType || "INV",
        sourceId: invoice.id,
        invoiceId: invoice.id,
        voucherNo: invoice.voucherNo,
        customerName: invoice.customerName,
        totalAmount: Number(invoice.totalAmount || 0),
        paidAmount: Number(invoice.paidAmount || 0),
        balanceAmount: Number(
          invoice.balanceAmount || invoice.totalAmount || 0
        ),
        amount: Number(invoice.balanceAmount || invoice.totalAmount || 0),
        applicationDate: form.date,
      },
    ];
  });
}

function updateInvoiceApplicationAmount(invoiceId, value) {
  setInvoiceApplications((prev) =>
    prev.map((item) =>
      Number(item.sourceId || item.invoiceId) === Number(invoiceId)
        ? { ...item, amount: value }
        : item
    )
  );
}

function applySelectedInvoicesToLines() {
  if (invoiceApplications.length === 0) {
    setShowInvoiceModal(false);
    return;
  }

  const totalPayment = invoiceApplications.reduce(
    (sum, item) => sum + Number(item.amount || 0),
    0
  );

  const receivableLine = lines.find((line) =>
    isAPorARAccount(line.accountId)
  );

  if (receivableLine) {
    setLines((prev) =>
      prev.map((line) => {
        if (line.id !== receivableLine.id) return line;

        const firstInvoice = invoiceApplications[0];

        return {
          ...line,
          credit: String(totalPayment),
          debit: "",
          genRef:
            firstInvoice?.voucherNo ||
            firstInvoice?.genRef ||
            line.genRef ||
            "",
          genName:
            firstInvoice?.customerName ||
            line.genName ||
            "",
        };
      })
    );
  }

  setShowInvoiceModal(false);
}



    const totalPayment = apvApplications.reduce(
      (sum, item) => sum + Number(item.amount || 0),
      0
    );

    const payableLine = lines.find((line) => isAPorARAccount(line.accountId));

    if (payableLine) {
      setLines((prev) =>
        prev.map((line) => {
          if (line.id !== payableLine.id) return line;

          const firstApv = apvApplications[0];

          return {
            ...line,
            debit: String(totalPayment),
            credit: "",
            genRef: firstApv?.voucherNo || firstApv?.genRef || line.genRef || "",
            genName: firstApv?.supplierName || line.genName || "",
          };
        })
      );
    }

    setShowApvModal(false);
  }

  async function handlePostTransactionClick() {
  if (code === "CV") {
    const hasAPorARLine = lines.some((line) =>
      isAPorARAccount(line.accountId)
    );

    if (hasAPorARLine) {
      await loadUnpaidApvs();
      setShowApvModal(true);
      return;
    }
  }

  handleSave("Posted");
}

  async function handleSave(status) {
    const validationError = validate();

    if (validationError) {
      setError(validationError);
      return;
    }

    setError("");
    setSaving(true);

    try {
      const updatedForm = { ...form, status };

      const payload = {
        voucherNo: updatedForm.referenceNo,
        supplierId: updatedForm.partyId || null,
        supplierName: updatedForm.party,
        transactionDate: updatedForm.date,
        dueDate: updatedForm.date,
        referenceNo: updatedForm.referenceNo,
        description: updatedForm.description,
        remarks: updatedForm.checkNo,
        status,
        totalDebit: totals.totalDebit,
        totalCredit: totals.totalCredit,
        lines: lines.map((line) => {
          const selectedAccount = accountOptions.find(
            (account) => String(account.id) === String(line.accountId)
          );

          return {
            accountId: Number(line.accountId),
            accountCode: selectedAccount?.code || "",
            accountTitle: selectedAccount?.title || "",
            particulars: line.particulars,
            genRef: line.genRef || "",
            genName: line.genName || "",
            debit: Number(line.debit || 0),
            credit: Number(line.credit || 0),
          };
        }),
        apvApplications:
          code === "CV"
            ? apvApplications.map((item) => ({
                sourceType: item.sourceType || "APV",
                sourceId: Number(item.sourceId || item.apvId),
                appliedType: "CV", 
                amount: Number(item.amount || 0),
                applicationDate: form.date,
              }))
            : [],
      };

      const endpoint = code === "CV" ? "cv" : "apv";
      const isExisting = selectedTransaction?.id;

      const res = await fetch(
        isExisting
          ? `${API_BASE}/api/${endpoint}/${selectedTransaction.id}`
          : `${API_BASE}/api/${endpoint}`,
        {
          method: isExisting ? "PUT" : "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify(payload),
        }
      );

      const data = await res.json();  

      if (!res.ok) {
        alert(data.message || "Failed to save transaction.");
        return;
      }

      alert(`${title} ${status} saved successfully.`);
      await loadTransactions();
      if (code === "CV") {
        await loadUnpaidApvs();
      }
      setMode("list");
    } catch (err) {
      console.error("SAVE TRANSACTION ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="transaction-page">
      <div className="transaction-wrapper">
        {mode === "list" && (
          <>
            <div className="transaction-topbar">
              <div>
                <h1 className="transaction-title">{title}</h1>
                <p className="transaction-subtitle">
                  View, search, and manage your {code} transactions.
                </p>
              </div>

              <button className="transaction-primary-button" onClick={handleAddNew}>
                + Add {code}
              </button>
            </div>

            <div className="transaction-card">
              <div className="transaction-list-toolbar">
                <input
                  type="text"
                  placeholder="Search transaction..."
                  className="transaction-input"
                />

                <select className="transaction-input">
                  <option>All Status</option>
                  <option>Draft</option>
                  <option>Posted</option>
                  <option>Cancelled</option>
                </select>
              </div>

              <div className="transaction-table-container">
                <table className="transaction-table">
                  <thead>
                    <tr>
                      <th>{code} No.</th>
                      <th>Date</th>
                      <th>{partyLabel}</th>
                      <th className="text-right">Amount</th>
                      <th>Status</th>
                      <th className="text-center">Action</th>
                    </tr>
                  </thead>

                  <tbody>
                    {transactions.length === 0 ? (
                      <tr>
                        <td colSpan="6" className="transaction-empty">
                          No transactions yet. Click Add {code} to create one.
                        </td>
                      </tr>
                    ) : (
                      transactions.map((transaction) => (
                        <tr key={transaction.id}>
                          <td>{transaction.referenceNo}</td>
                          <td>{transaction.date}</td>
                          <td>{transaction.party}</td>
                          <td className="text-right">
                            ₱ {formatMoney(transaction.amount)}
                          </td>
                          <td>
                            <span
                              className={`transaction-status-badge ${String(
                                transaction.status
                              ).toLowerCase()}`}
                            >
                              {transaction.status}
                            </span>
                          </td>
                          <td className="text-center">
                            <button
                              className="transaction-view-button"
                              onClick={() => handleView(transaction)}
                            >
                              View / Edit
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {mode === "form" && (
          <>
            <div className="transaction-topbar">
              <div>
                <h1 className="transaction-title">
                  {selectedTransaction ? `Edit ${code}` : `Add New ${code}`}
                </h1>
                <p className="transaction-subtitle">{title}</p>
              </div>

              <div className="transaction-form-top-actions no-print">
                <div className="transaction-status-pill">{form.status}</div>

                <div className="print-dropdown">
                  <button type="button" className="transaction-secondary-button">
                    🖨 Print / Export
                  </button>

                  <div className="print-dropdown-menu">
                    <button type="button" onClick={handlePrint}>
                      Print to Printer
                    </button>
                    <button type="button" onClick={handleExportCSV}>
                      Export to Excel / CSV
                    </button>
                  </div>
                </div>

                <button
                  className="transaction-secondary-button"
                  onClick={handleBackToList}
                >
                  ← Back to List
                </button>
              </div>
            </div>

            <div className="transaction-card">
              <div className="transaction-grid">
                <div className="transaction-field">
                  <label className="transaction-label">Date</label>
                  <input
                    type="date"
                    value={form.date}
                    onChange={(e) => updateForm("date", e.target.value)}
                    className="transaction-input"
                  />
                </div>

                <div className="transaction-field">
                  <label className="transaction-label">Reference No.</label>
                  <input
                    type="text"
                    value={form.referenceNo}
                    onChange={(e) => updateForm("referenceNo", e.target.value)}
                    placeholder={`${code}-000001`}
                    className="transaction-input"
                  />
                </div>

                <div className="transaction-field">
                  <label className="transaction-label">{partyLabel}</label>
                  <input
                    type="text"
                    list={`${code}-party-list`}
                    value={form.party}
                    onChange={(e) => handlePartyChange(e.target.value)}
                    placeholder={`Select ${partyLabel.toLowerCase()}`}
                    className="transaction-input"
                  />

                  <datalist id={`${code}-party-list`}>
                    {partyOptions.map((party) => (
                      <option key={party.id} value={party.name}>
                        {party.code} - {party.type}
                      </option>
                    ))}
                  </datalist>
                </div>

                <div className="transaction-field">
                  <label className="transaction-label">
                    {showCheckNo ? "Check No." : "Transaction Type"}
                  </label>
                  <input
                    type="text"
                    value={showCheckNo ? form.checkNo : title}
                    onChange={(e) => {
                      if (showCheckNo) updateForm("checkNo", e.target.value);
                    }}
                    readOnly={!showCheckNo}
                    placeholder={showCheckNo ? "Enter check number" : ""}
                    className={`transaction-input ${
                      !showCheckNo ? "transaction-input-readonly" : ""
                    }`}
                  />
                </div>
              </div>

              <div className="transaction-memo-wrap">
                <label className="transaction-label">Description / Memo</label>
                <textarea
                  value={form.description}
                  onChange={(e) => updateForm("description", e.target.value)}
                  rows={3}
                  placeholder="Enter transaction details"
                  className="transaction-textarea"
                />
              </div>
            </div>

            <div className="transaction-card">
              <div className="transaction-section-header">
                <div>
                  <h2 className="transaction-section-title">Journal Entries</h2>
                  <p className="transaction-section-subtext">
                    Minimum of one debit and one credit
                  </p>
                </div>

                <div className="transaction-section-actions">
                  
                  <button onClick={addLine} className="transaction-add-button">
                    + Add Line
                  </button>
                </div>
              </div>

              <div className="transaction-table-container">
                <table className="transaction-table">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Particulars</th>
                      <th>Gen Ref</th>
                      <th>Gen Name</th>
                      <th className="text-right">Debit</th>
                      <th className="text-right">Credit</th>
                      <th className="text-center">Action</th>
                    </tr>
                  </thead>

                  <tbody>
                    {lines.map((line) => (
                      <tr key={line.id}>
                        <td>
                          <select
                            value={line.accountId}
                            onChange={(e) =>
                              updateLine(line.id, "accountId", e.target.value)
                            }
                            className="transaction-table-input"
                          >
                            <option value="">Select account</option>
                            {accountOptions.map((account) => (
                              <option key={account.id} value={account.id}>
                                {account.code} - {account.title}
                              </option>
                            ))}
                          </select>
                        </td>

                        <td>
                          <input
                            type="text"
                            value={line.particulars}
                            onChange={(e) =>
                              updateLine(line.id, "particulars", e.target.value)
                            }
                            placeholder="Entry description"
                            className="transaction-table-input"
                          />
                        </td>

                        <td>
                          <select
  value={line.genRef || ""}
  onChange={(e) =>
    updateLine(line.id, "genRef", e.target.value)
  }
  disabled={!isAPorARAccount(line.accountId)}
  className="transaction-table-input transaction-gen-input"
>
  <option value="">
    {isAPorARAccount(line.accountId)
      ? "Select Reference"
      : "Not required"}
  </option>

  {partyOptions.map((party) => (
    <option key={party.id} value={party.code}>
      {party.code}
    </option>
  ))}
</select>
                        </td>

                        <td>
                          <input
  type="text"
  value={line.genName || ""}
  readOnly
  disabled={!isAPorARAccount(line.accountId)}
  placeholder={
    isAPorARAccount(line.accountId)
      ? "Gen Name"
      : "Not required"
  }
  className="transaction-table-input transaction-gen-input"
/>
                        </td>

                        <td>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={line.debit}
                            onChange={(e) =>
                              updateLine(line.id, "debit", e.target.value)
                            }
                            placeholder="0.00"
                            className="transaction-table-input transaction-table-input-right"
                          />
                        </td>

                        <td>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={line.credit}
                            onChange={(e) =>
                              updateLine(line.id, "credit", e.target.value)
                            }
                            placeholder="0.00"
                            className="transaction-table-input transaction-table-input-right"
                          />
                        </td>

                        <td className="text-center">
                          <button
                            onClick={() => removeLine(line.id)}
                            disabled={lines.length <= 2}
                            className="transaction-remove-button"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>

                  <tfoot>
                    <tr>
                      <td colSpan={4} className="transaction-total-label">
                        Totals
                      </td>
                      <td className="transaction-total-amount">
                        ₱ {formatMoney(totals.totalDebit)}
                      </td>
                      <td className="transaction-total-amount">
                        ₱ {formatMoney(totals.totalCredit)}
                      </td>
                      <td className="transaction-total-status">
                        <span
                          className={`transaction-balance-badge ${
                            totals.balanced ? "balanced" : "not-balanced"
                          }`}
                        >
                          {totals.balanced ? "Balanced" : "Not Balanced"}
                        </span>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {error ? <div className="transaction-error-box">{error}</div> : null}
            </div>

            
// ===================== APV Modal =====================

            {showApvModal && (
              <div className="apv-modal-overlay">
                <div className="apv-modal">
                  <div className="apv-modal-header">
                    <div>
                      <h2>Outstanding APV</h2>
                      <p>Select APV records to apply this Check Voucher payment.</p>
                    </div>
                    <button
                      type="button"
                      className="apv-modal-close"
                      onClick={() => setShowApvModal(false)}
                    >
                      ×
                    </button>
                  </div>

                  <div className="apv-modal-table-wrap">
                    <table className="apv-modal-table">
                      <thead>
                        <tr>
                          <th>Apply</th>
                          <th>APV No.</th>
                          <th>Supplier</th>
                          <th className="text-right">Amount</th>
                          <th className="text-right">Paid</th>
                          <th className="text-right">Balance</th>
                          <th className="text-right">Amount to Pay</th>
                        </tr>
                      </thead>

                      <tbody>
                        {unpaidApvs.length === 0 ? (
  <tr>
    <td colSpan="7" className="no-apv-message">
      No Payables Have Been Setup
    </td>
  </tr>
) : (
                          unpaidApvs.map((apv) => {
                            const selected = apvApplications.find(
                              (item) => Number(item.sourceId || item.apvId) === Number(apv.id)
                            );

                            return (
                              <tr key={apv.id}>
                                <td className="text-center">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(selected)}
                                    onChange={() => toggleApvApplication(apv)}
                                  />
                                </td>
                                <td>{apv.voucherNo}</td>
                                <td>{apv.supplierName}</td>
                                <td className="text-right">₱ {formatMoney(apv.totalAmount)}</td>
                                <td className="text-right">₱ {formatMoney(apv.paidAmount)}</td>
                                <td className="text-right">₱ {formatMoney(apv.balanceAmount)}</td>
                                <td>
                                  <input
                                    type="number"
                                    min="0"
                                    max={apv.balanceAmount}
                                    step="0.01"
                                    disabled={!selected}
                                    value={selected?.amount || ""}
                                    onChange={(e) =>
                                      updateApvApplicationAmount(apv.id, e.target.value)
                                    }
                                    className="apv-payment-input"
                                  />
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="apv-modal-footer">
                    <div className="apv-modal-total">
                      Total Applied: ₱ {formatMoney(
                        apvApplications.reduce(
                          (sum, item) => sum + Number(item.amount || 0),
                          0
                        )
                      )}
                    </div>
                    <button
                      type="button"
                      className="transaction-secondary-button"
                      onClick={() => setShowApvModal(false)}
                    >
                      Cancel
                    </button>
                    <button
  type="button"
  className="transaction-primary-button"
  onClick={() => {
    if (unpaidApvs.length === 0) {
      setShowApvModal(false);
      handleSave("Posted");
      return;
    }

    applySelectedApvsToLines();
    setTimeout(() => handleSave("Posted"), 100);
  }}
>
  Done
</button>
                  </div>
                </div>
              </div>
            )}  

// ===================== INVOICE Modal =====================

            {showApvModal && (
              <div className="apv-modal-overlay">
                <div className="apv-modal">
                  <div className="apv-modal-header">
                    <div>
                      <h2>Outstanding APV</h2>
                      <p>Select APV records to apply this Check Voucher payment.</p>
                    </div>
                    <button
                      type="button"
                      className="apv-modal-close"
                      onClick={() => setShowApvModal(false)}
                    >
                      ×
                    </button>
                  </div>

                  <div className="apv-modal-table-wrap">
                    <table className="apv-modal-table">
                      <thead>
                        <tr>
                          <th>Apply</th>
                          <th>APV No.</th>
                          <th>Supplier</th>
                          <th className="text-right">Amount</th>
                          <th className="text-right">Paid</th>
                          <th className="text-right">Balance</th>
                          <th className="text-right">Amount to Pay</th>
                        </tr>
                      </thead>

                      <tbody>
                        {unpaidApvs.length === 0 ? (
  <tr>
    <td colSpan="7" className="no-apv-message">
      No Payables Have Been Setup
    </td>
  </tr>
) : (
                          unpaidApvs.map((apv) => {
                            const selected = apvApplications.find(
                              (item) => Number(item.sourceId || item.apvId) === Number(apv.id)
                            );

                            return (
                              <tr key={apv.id}>
                                <td className="text-center">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(selected)}
                                    onChange={() => toggleApvApplication(apv)}
                                  />
                                </td>
                                <td>{apv.voucherNo}</td>
                                <td>{apv.supplierName}</td>
                                <td className="text-right">₱ {formatMoney(apv.totalAmount)}</td>
                                <td className="text-right">₱ {formatMoney(apv.paidAmount)}</td>
                                <td className="text-right">₱ {formatMoney(apv.balanceAmount)}</td>
                                <td>
                                  <input
                                    type="number"
                                    min="0"
                                    max={apv.balanceAmount}
                                    step="0.01"
                                    disabled={!selected}
                                    value={selected?.amount || ""}
                                    onChange={(e) =>
                                      updateApvApplicationAmount(apv.id, e.target.value)
                                    }
                                    className="apv-payment-input"
                                  />
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="apv-modal-footer">
                    <div className="apv-modal-total">
                      Total Applied: ₱ {formatMoney(
                        apvApplications.reduce(
                          (sum, item) => sum + Number(item.amount || 0),
                          0
                        )
                      )}
                    </div>
                    <button
                      type="button"
                      className="transaction-secondary-button"
                      onClick={() => setShowApvModal(false)}
                    >
                      Cancel
                    </button>
                    <button
  type="button"
  className="transaction-primary-button"
  onClick={() => {
    if (unpaidApvs.length === 0) {
      setShowApvModal(false);
      handleSave("Posted");
      return;
    }

    applySelectedApvsToLines();
    setTimeout(() => handleSave("Posted"), 100);
  }}
>
  Done
</button>
                  </div>
                </div>
              </div>
            )}


            <div className="transaction-bottom-bar no-print">
              <div className="print-dropdown">
                <button type="button" className="transaction-secondary-button">
                  🖨 Print / Export
                </button>

                <div className="print-dropdown-menu">
                  <button type="button" onClick={handlePrint}>
                    Print to Printer
                  </button>
                  <button type="button" onClick={handleExportCSV}>
                    Export to Excel / CSV
                  </button>
                </div>
              </div>

              <button
                onClick={() => handleSave("Draft")}
                className="transaction-secondary-button"
                disabled={saving}
              >
                {saving ? "Saving..." : "Save Draft"}
              </button>

              <button
  onClick={handlePostTransactionClick}
  className="transaction-primary-button"
  disabled={saving}
>
  {saving ? "Saving..." : "Post Transaction"}
</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

