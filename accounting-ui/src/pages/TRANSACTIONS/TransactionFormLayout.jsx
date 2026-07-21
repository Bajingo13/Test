import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import "./TransactionFormLayout.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// A stale/expired JWT (server returns 401/403) previously just surfaced as a raw
// "Invalid or expired token" alert with no recovery - the page stayed stuck showing
// no data. Clear the dead token and send the user back to login instead.
function handleAuthError(status) {
  if (status === 401 || status === 403) {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    if (window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
    return true;
  }
  return false;
}

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
  const [searchParams] = useSearchParams();

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

  const [openPos, setOpenPos] = useState([]);
  const [showPoModal, setShowPoModal] = useState(false);
  const [sourcePoId, setSourcePoId] = useState(null);
  const [sourcePoNo, setSourcePoNo] = useState("");

  const [ewtCodes, setEwtCodes] = useState([]);
  const [atcCode, setAtcCode] = useState("");
  const [taxWithheldAmount, setTaxWithheldAmount] = useState("");
  const [payeeTin, setPayeeTin] = useState("");

  const [vatAccountId, setVatAccountId] = useState("");
  const [vatTaxableAmount, setVatTaxableAmount] = useState("");
  const [vatRate, setVatRate] = useState("12");

  const [invoiceType, setInvoiceType] = useState("Standard");
  const [recurrenceFrequency, setRecurrenceFrequency] = useState("Monthly");

  const [bankAccounts, setBankAccounts] = useState([]);
  const [paymentMethod, setPaymentMethod] = useState(code === "CV" ? "Check" : "Cash");
  const [bankAccountId, setBankAccountId] = useState("");
  const [checkNumber, setCheckNumber] = useState("");
  const [checkDate, setCheckDate] = useState("");

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

    if (code === "APV") {
      loadEwtCodes();
    }

    if (code === "OR" || code === "CV") {
      loadBankAccounts();
    }

    if (code === "CV" && form.party) {
  loadUnpaidApvs();
}

    const deepLinkId = searchParams.get("id");
    if (deepLinkId) {
      handleView({ id: deepLinkId });
    }
  }, []);

  useEffect(() => {
    if (vatAccountId || accountOptions.length === 0) return;

    const keyword =
      code === "INV" || code === "OR" ? "output vat" : "input vat";

    const match = accountOptions.find((acc) =>
      String(acc.title || "").toLowerCase().includes(keyword)
    );

    if (match) setVatAccountId(String(match.id));
  }, [accountOptions]);

  async function loadEwtCodes() {
    try {
      const res = await fetch(`${API_BASE}/api/ewt-library`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        handleAuthError(res.status);
        setEwtCodes([]);
        return;
      }

      setEwtCodes(Array.isArray(data) ? data.filter((e) => e.status === "ACTIVE") : []);
    } catch (err) {
      console.error("LOAD EWT LIBRARY ERROR:", err);
      setEwtCodes([]);
    }
  }

  async function loadBankAccounts() {
    try {
      const res = await fetch(`${API_BASE}/api/bank-codes`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        handleAuthError(res.status);
        setBankAccounts([]);
        return;
      }

      setBankAccounts(Array.isArray(data) ? data.filter((b) => b.status === "ACTIVE") : []);
    } catch (err) {
      console.error("LOAD BANK CODES ERROR:", err);
      setBankAccounts([]);
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

      setAccountOptions(data);
    } catch (err) {
      console.error("LOAD COA ERROR:", err);
    }
  }

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
      const endpoint =
  code === "CV"
    ? "cv"
    : code === "OR"
    ? "or"
    : code === "INV"
    ? "invoices"
    : code === "PO"
    ? "purchase-orders"
    : "apv";
      const res = await fetch(`${API_BASE}/api/${endpoint}`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        handleAuthError(res.status);
        return;
      }

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

      if (code === "INV") {
  setTransactions(
    data.map((item) => ({
      id: item.id,
      referenceNo: item.referenceNo || item.voucherNo,
      date: item.transactionDate,
      party: item.customerName,
      amount: item.totalDebit || item.totalCredit,
      paidAmount: item.paidAmount || 0,
      balanceAmount:
        item.balanceAmount ?? item.totalDebit ?? item.totalCredit,
      status: item.paymentStatus || item.status,
      invoiceType: item.invoiceType || "Standard",
      form: {
        date: item.transactionDate,
        referenceNo: item.referenceNo || item.voucherNo,
        party: item.customerName,
        partyId: item.customerId,
        description: item.description,
        checkNo: item.remarks || "",
        status: item.status,
      },
      lines: [],
    }))
  );
}

if (code === "OR") {
  setTransactions(
    data.map((item) => ({
      id: item.id,
      referenceNo: item.referenceNo || item.voucherNo,
      date: item.transactionDate,
      party: item.customerName,
      amount: item.totalDebit || item.totalCredit,
      status: item.status,
      form: {
        date: item.transactionDate,
        referenceNo: item.referenceNo || item.voucherNo,
        party: item.customerName,
        partyId: item.customerId,
        description: item.description,
        checkNo: item.receiptNo || "",
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

      if (code === "PO") {
        setTransactions(
          data.map((item) => ({
            id: item.id,
            referenceNo: item.referenceNo || item.voucherNo,
            date: item.transactionDate,
            party: item.supplierName,
            amount: item.totalCredit || item.totalDebit,
            status: item.status,
            form: {
              date: item.transactionDate,
              referenceNo: item.referenceNo || item.voucherNo,
              party: item.supplierName,
              partyId: item.supplierId,
              description: item.description,
              checkNo: "",
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
        headers: authHeaders(),
      }
    );

    const data = await res.json();

    if (!res.ok) {
      if (handleAuthError(res.status)) return;
      alert(data.message || "Failed to load unpaid APV records");
      return;
    }

    setUnpaidApvs(data);
  } catch (err) {
    console.error("LOAD UNPAID APV ERROR:", err);
  }
}

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
        headers: authHeaders(),
      }
    );

    const data = await res.json();

    if (!res.ok) {
      handleAuthError(res.status);
      setUnpaidInvoices([]);
      return;
    }

    setUnpaidInvoices(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error("LOAD UNPAID INVOICES ERROR:", err);
    setUnpaidInvoices([]);
  }
}

  async function loadOpenPos() {
    try {
      const res = await fetch(`${API_BASE}/api/purchase-orders/open`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        handleAuthError(res.status);
        setOpenPos([]);
        return;
      }

      setOpenPos(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("LOAD OPEN PURCHASE ORDERS ERROR:", err);
      setOpenPos([]);
    }
  }

  async function selectPo(po) {
    try {
      const res = await fetch(`${API_BASE}/api/purchase-orders/${po.id}`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to load Purchase Order details");
        return;
      }

      setForm((prev) => ({
        ...prev,
        party: data.supplierName || "",
        partyId: data.supplierId || null,
        description: data.description || prev.description,
      }));

      setLines(
        (data.lines || []).map((line) => ({
          id: crypto.randomUUID(),
          accountId: line.accountId || "",
          particulars: line.particulars || "",
          genRef: line.genRef || "",
          genName: line.genName || "",
          debit: line.debit || "",
          credit: line.credit || "",
        }))
      );

      setSourcePoId(po.id);
      setSourcePoNo(po.voucherNo || "");
      setShowPoModal(false);
    } catch (err) {
      console.error("SELECT PURCHASE ORDER ERROR:", err);
      alert("Unable to load Purchase Order details.");
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

  const selectedEwt = ewtCodes.find((e) => e.atcCode === atcCode);

  function handleAtcCodeChange(value) {
    setAtcCode(value);

    const ewt = ewtCodes.find((e) => e.atcCode === value);
    if (ewt) {
      const suggested = (totals.totalCredit * Number(ewt.rate || 0)) / 100;
      setTaxWithheldAmount(suggested ? suggested.toFixed(2) : "");
    } else {
      setTaxWithheldAmount("");
    }
  }

  const vatType =
    code === "INV" || code === "OR"
      ? "Output VAT"
      : code === "APV" || code === "CV"
      ? "Input VAT"
      : null;

  const vatAmount =
    (Number(vatTaxableAmount || 0) * Number(vatRate || 0)) / 100;

  function handleAddVatLine() {
    if (!vatAccountId) {
      alert("Please select the VAT account first.");
      return;
    }

    if (!vatTaxableAmount || Number(vatTaxableAmount) <= 0) {
      alert("Please enter a taxable amount greater than zero.");
      return;
    }

    const isOutput = vatType === "Output VAT";
    const amount = Math.round(vatAmount * 100) / 100;

    setLines((prev) => [
      ...prev,
      {
        ...createLine(),
        accountId: vatAccountId,
        particulars: `${vatType} (${vatRate}%)`,
        debit: isOutput ? "" : String(amount),
        credit: isOutput ? String(amount) : "",
      },
    ]);

    setVatTaxableAmount("");
  }

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
setUnpaidApvs([]);
setShowApvModal(false);

setInvoiceApplications([]);
setUnpaidInvoices([]);
setShowInvoiceModal(false);

setOpenPos([]);
setShowPoModal(false);
setSourcePoId(null);
setSourcePoNo("");

setAtcCode("");
setTaxWithheldAmount("");
setPayeeTin("");

setVatTaxableAmount("");
setVatRate("12");

setInvoiceType("Standard");
setRecurrenceFrequency("Monthly");

setPaymentMethod(code === "CV" ? "Check" : "Cash");
setBankAccountId("");
setCheckNumber("");
setCheckDate("");

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
      const endpoint =
  code === "CV"
    ? "cv"
    : code === "OR"
    ? "or"
    : code === "INV"
    ? "invoices"
    : code === "PO"
    ? "purchase-orders"
    : "apv";
      const res = await fetch(`${API_BASE}/api/${endpoint}/${transaction.id}`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (res.ok) {
        setForm({
  date: data.transactionDate,
  referenceNo: data.referenceNo || data.voucherNo,

  party:
    code === "CV"
      ? data.payeeName
      : code === "OR" || code === "INV"
      ? data.customerName
      : data.supplierName,

  partyId:
    code === "CV"
      ? data.payeeId
      : code === "OR" || code === "INV"
      ? data.customerId
      : data.supplierId,

  description: data.description,

  checkNo:
    code === "CV"
      ? data.checkNo || ""
      : code === "OR"
      ? data.receiptNo || ""
      : data.remarks || "",

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

       if (code === "CV") {
  setApvApplications(data.applications || []);
} else {
  setApvApplications([]);
}

if (code === "OR") {
  setInvoiceApplications(data.applications || []);
} else {
  setInvoiceApplications([]);
}

if (code === "APV" && data.sourcePoId) {
  setSourcePoId(data.sourcePoId);

  fetch(`${API_BASE}/api/purchase-orders/${data.sourcePoId}`, {
    credentials: "include",
    headers: authHeaders(),
  })
    .then((r) => r.json())
    .then((po) => setSourcePoNo(po.voucherNo || ""))
    .catch(() => setSourcePoNo(""));
} else {
  setSourcePoId(null);
  setSourcePoNo("");
}

if (code === "APV") {
  setAtcCode(data.atcCode || "");
  setTaxWithheldAmount(data.taxWithheldAmount || "");
  setPayeeTin(data.payeeTin || "");
}

if (code === "INV") {
  setInvoiceType(data.invoiceType === "Recurring" ? "Recurring" : "Standard");
  setRecurrenceFrequency(data.recurrenceFrequency || "Monthly");
}

if (code === "OR" || code === "CV") {
  setPaymentMethod(data.paymentMethod === "Check" ? "Check" : "Cash");
  setBankAccountId(data.bankAccountId || "");
  setCheckNumber(data.checkNo || "");
  setCheckDate(data.checkDate || "");
}
        setMode("form");
        return;
      }

      if (handleAuthError(res.status)) return;
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

    if (code === "APV") {
      setPayeeTin(selectedParty?.tin || "");

      if (selectedParty?.atcCode && ewtCodes.some((e) => e.atcCode === selectedParty.atcCode)) {
        handleAtcCodeChange(selectedParty.atcCode);
      }
    }

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

  async function handlePostTransactionClick() {
  const hasAPorARLine = lines.some((line) =>
    isAPorARAccount(line.accountId)
  );

  // Check Voucher: apply payment to APV
  if (code === "CV" && hasAPorARLine) {
    await loadUnpaidApvs();
    setShowApvModal(true);
    return;
  }

  // Official Receipt: apply payment to Invoice
  if (code === "OR" && hasAPorARLine) {
    await loadUnpaidInvoices();
    setShowInvoiceModal(true);
    return;
  }

  // APV and Invoice post normally
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

        customerId: updatedForm.partyId || null,
        customerName: updatedForm.party,

        transactionDate: updatedForm.date,
        dueDate: updatedForm.date,
        referenceNo: updatedForm.referenceNo,
        description: updatedForm.description,
        remarks: updatedForm.checkNo,
        receiptNo: updatedForm.checkNo,
        
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

            invoiceApplications:
  code === "OR"
    ? invoiceApplications.map((item) => ({
        sourceType: item.sourceType || "INV",
        sourceId: Number(item.sourceId || item.invoiceId),
        appliedType: "OR",
        amount: Number(item.amount || 0),
        applicationDate: form.date,
      }))
    : [],

        sourcePoId: code === "APV" ? sourcePoId : null,

        atcCode: code === "APV" ? atcCode || null : null,
        taxType: code === "APV" ? selectedEwt?.taxType || null : null,
        taxRate: code === "APV" ? selectedEwt?.rate || null : null,
        taxWithheldAmount: code === "APV" ? Number(taxWithheldAmount) || null : null,
        payeeTin: code === "APV" ? payeeTin || null : null,

        invoiceType: code === "INV" ? invoiceType : null,
        recurrenceFrequency: code === "INV" && invoiceType === "Recurring" ? recurrenceFrequency : null,

        paymentMethod: code === "OR" || code === "CV" ? paymentMethod : null,
        bankAccountId: code === "OR" || code === "CV" ? bankAccountId || null : null,
        checkNo: (code === "OR" || code === "CV") && paymentMethod === "Check" ? checkNumber : null,
        checkDate: (code === "OR" || code === "CV") && paymentMethod === "Check" ? checkDate : null,
      };

      const endpoint =
  code === "CV"
    ? "cv"
    : code === "OR"
    ? "or"
    : code === "INV"
    ? "invoices"
    : code === "PO"
    ? "purchase-orders"
    : "apv";
      const isExisting = selectedTransaction?.id;

      const res = await fetch(
        isExisting
          ? `${API_BASE}/api/${endpoint}/${selectedTransaction.id}`
          : `${API_BASE}/api/${endpoint}`,
        {
          method: isExisting ? "PUT" : "POST",
          headers: {
            "Content-Type": "application/json",
            ...authHeaders(),
          },
          credentials: "include",
          body: JSON.stringify(payload),
        }
      );

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to save transaction.");
        return;
      }

      alert(`${title} ${status} saved successfully.`);
      await loadTransactions();
      if (code === "CV") {
  await loadUnpaidApvs();
}

if (code === "OR") {
  await loadUnpaidInvoices();
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
                          <td>
                            {transaction.referenceNo}
                            {code === "INV" && transaction.invoiceType === "Recurring" && (
                              <span className="transaction-recurring-tag">Recurring</span>
                            )}
                          </td>
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

                {code === "APV" && (
                  sourcePoId ? (
                    <div className="transaction-status-pill">
                      Linked to PO {sourcePoNo || `#${sourcePoId}`}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="transaction-secondary-button"
                      onClick={async () => {
                        await loadOpenPos();
                        setShowPoModal(true);
                      }}
                    >
                      📋 Load from PO
                    </button>
                  )
                )}

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

            {code === "INV" && (
              <div className="transaction-card">
                <div className="transaction-section-header">
                  <div>
                    <h2 className="transaction-section-title">Invoice Type</h2>
                    <p className="transaction-section-subtext">
                      Recurring invoices are for billing the same customer on a repeating schedule.
                    </p>
                  </div>
                </div>

                <div className="transaction-grid">
                  <div className="transaction-field">
                    <label className="transaction-label">Type</label>
                    <select
                      className="transaction-input"
                      value={invoiceType}
                      onChange={(e) => setInvoiceType(e.target.value)}
                    >
                      <option value="Standard">Standard</option>
                      <option value="Recurring">Recurring</option>
                    </select>
                  </div>

                  {invoiceType === "Recurring" && (
                    <div className="transaction-field">
                      <label className="transaction-label">Recurrence</label>
                      <select
                        className="transaction-input"
                        value={recurrenceFrequency}
                        onChange={(e) => setRecurrenceFrequency(e.target.value)}
                      >
                        <option value="Weekly">Weekly</option>
                        <option value="Monthly">Monthly</option>
                        <option value="Quarterly">Quarterly</option>
                        <option value="Annually">Annually</option>
                      </select>
                    </div>
                  )}
                </div>
              </div>
            )}

            {(code === "OR" || code === "CV") && (
              <div className="transaction-card">
                <div className="transaction-section-header">
                  <div>
                    <h2 className="transaction-section-title">Cash / Check Details</h2>
                    <p className="transaction-section-subtext">
                      Captures the bank account and check reference this {code === "OR" ? "receipt" : "payment"}{" "}
                      moved through, for bank reconciliation.
                    </p>
                  </div>
                </div>

                <div className="transaction-grid">
                  <div className="transaction-field">
                    <label className="transaction-label">Payment Method</label>
                    <select
                      className="transaction-input"
                      value={paymentMethod}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                    >
                      <option value="Cash">Cash</option>
                      <option value="Check">Check</option>
                    </select>
                  </div>

                  <div className="transaction-field">
                    <label className="transaction-label">Bank Account</label>
                    <select
                      className="transaction-input"
                      value={bankAccountId}
                      onChange={(e) => setBankAccountId(e.target.value)}
                    >
                      <option value="">Select bank account</option>
                      {bankAccounts.map((bank) => (
                        <option key={bank.id} value={bank.id}>
                          {bank.bankCode} - {bank.bankName} ({bank.accountNo})
                        </option>
                      ))}
                    </select>
                  </div>

                  {paymentMethod === "Check" && (
                    <>
                      <div className="transaction-field">
                        <label className="transaction-label">Check No.</label>
                        <input
                          type="text"
                          className="transaction-input"
                          value={checkNumber}
                          onChange={(e) => setCheckNumber(e.target.value)}
                          placeholder="Enter check number"
                        />
                      </div>

                      <div className="transaction-field">
                        <label className="transaction-label">Check Date</label>
                        <input
                          type="date"
                          className="transaction-input"
                          value={checkDate}
                          onChange={(e) => setCheckDate(e.target.value)}
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {code === "APV" && (
              <div className="transaction-card">
                <div className="transaction-section-header">
                  <div>
                    <h2 className="transaction-section-title">Withholding Tax</h2>
                    <p className="transaction-section-subtext">
                      Optional &mdash; only fill in if tax was withheld from this supplier payment.
                    </p>
                  </div>
                </div>

                <div className="transaction-grid">
                  <div className="transaction-field">
                    <label className="transaction-label">ATC Code</label>
                    <select
                      value={atcCode}
                      onChange={(e) => handleAtcCodeChange(e.target.value)}
                      className="transaction-input"
                    >
                      <option value="">None</option>
                      {ewtCodes.map((ewt) => (
                        <option key={ewt.id} value={ewt.atcCode}>
                          {ewt.atcCode} - {ewt.description} ({ewt.rate}%)
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="transaction-field">
                    <label className="transaction-label">Tax Type</label>
                    <input
                      type="text"
                      value={selectedEwt ? (selectedEwt.taxType === "FINAL" ? "Final Tax" : "Expanded Withholding Tax") : ""}
                      readOnly
                      placeholder="Select an ATC code"
                      className="transaction-input transaction-input-readonly"
                    />
                  </div>

                  <div className="transaction-field">
                    <label className="transaction-label">Tax Withheld Amount</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={taxWithheldAmount}
                      onChange={(e) => setTaxWithheldAmount(e.target.value)}
                      disabled={!atcCode}
                      placeholder="0.00"
                      className="transaction-input"
                    />
                  </div>

                  <div className="transaction-field">
                    <label className="transaction-label">Payee TIN</label>
                    <input
                      type="text"
                      value={payeeTin}
                      onChange={(e) => setPayeeTin(e.target.value)}
                      placeholder="000-000-000-000"
                      className="transaction-input"
                    />
                  </div>
                </div>
              </div>
            )}

            {vatType && (
              <div className="transaction-card">
                <div className="transaction-section-header">
                  <div>
                    <h2 className="transaction-section-title">{vatType}</h2>
                    <p className="transaction-section-subtext">
                      Optional &mdash; enter the taxable amount to add a {vatType} line automatically.
                    </p>
                  </div>
                </div>

                <div className="transaction-grid">
                  <div className="transaction-field">
                    <label className="transaction-label">{vatType} Account</label>
                    <select
                      value={vatAccountId}
                      onChange={(e) => setVatAccountId(e.target.value)}
                      className="transaction-input"
                    >
                      <option value="">Select account</option>
                      {accountOptions.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.code} - {account.title}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="transaction-field">
                    <label className="transaction-label">Taxable Amount</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={vatTaxableAmount}
                      onChange={(e) => setVatTaxableAmount(e.target.value)}
                      placeholder="0.00"
                      className="transaction-input"
                    />
                  </div>

                  <div className="transaction-field">
                    <label className="transaction-label">VAT Rate (%)</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={vatRate}
                      onChange={(e) => setVatRate(e.target.value)}
                      className="transaction-input"
                    />
                  </div>

                  <div className="transaction-field">
                    <label className="transaction-label">VAT Amount</label>
                    <input
                      type="text"
                      value={formatMoney(vatAmount)}
                      readOnly
                      className="transaction-input transaction-input-readonly"
                    />
                  </div>
                </div>

                <div className="transaction-section-actions">
                  <button
                    type="button"
                    className="transaction-add-button"
                    onClick={handleAddVatLine}
                  >
                    + Add {vatType} Line
                  </button>
                </div>
              </div>
            )}

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

            
{/* ===================== APV Modal ===================== */}

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

{/* ===================== INVOICE Modal ===================== */}

            {showInvoiceModal && (
              <div className="apv-modal-overlay">
                <div className="apv-modal">
                  <div className="apv-modal-header">
                    <div>
                      <h2>Outstanding Invoice</h2>
                      <p>Select Invoice records to apply this Official Receipt payment.</p>
                    </div>
                    <button
                      type="button"
                      className="apv-modal-close"
                      onClick={() => setShowInvoiceModal(false)}
                    >
                      ×
                    </button>
                  </div>

                  <div className="apv-modal-table-wrap">
                    <table className="apv-modal-table">
                      <thead>
                        <tr>
                          <th>Apply</th>
                          <th>Invoice No.</th>
                          <th>Customer</th>
                          <th className="text-right">Amount</th>
                          <th className="text-right">Paid</th>
                          <th className="text-right">Balance</th>
                          <th className="text-right">Amount to Receive</th>
                        </tr>
                      </thead>

                      <tbody>
                        {unpaidInvoices.length === 0 ? (
  <tr>
    <td colSpan="7" className="no-apv-message">
      No Outstanding Invoices
    </td>
  </tr>
) : (
                          unpaidInvoices.map((invoice) => {
                            const selected = invoiceApplications.find(
                              (item) => Number(item.sourceId || item.invoiceId) === Number(invoice.id)
                            );

                            return (
                              <tr key={invoice.id}>
                                <td className="text-center">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(selected)}
                                    onChange={() => toggleInvoiceApplication(invoice)}
                                  />
                                </td>
                                <td>{invoice.voucherNo}</td>
                                <td>{invoice.customerName}</td>
                                <td className="text-right">₱ {formatMoney(invoice.totalAmount)}</td>
                                <td className="text-right">₱ {formatMoney(invoice.paidAmount)}</td>
                                <td className="text-right">₱ {formatMoney(invoice.balanceAmount)}</td>
                                <td>
                                  <input
                                    type="number"
                                    min="0"
                                    max={invoice.balanceAmount}
                                    step="0.01"
                                    disabled={!selected}
                                    value={selected?.amount || ""}
                                    onChange={(e) =>
                                      updateInvoiceApplicationAmount(invoice.id, e.target.value)
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
                        invoiceApplications.reduce(
                          (sum, item) => sum + Number(item.amount || 0),
                          0
                        )
                      )}
                    </div>
                    <button
                      type="button"
                      className="transaction-secondary-button"
                      onClick={() => setShowInvoiceModal(false)}
                    >
                      Cancel
                    </button>
                    <button
  type="button"
  className="transaction-primary-button"
  onClick={() => {
    if (unpaidInvoices.length === 0) {
      setShowInvoiceModal(false);
      handleSave("Posted");
      return;
    }

    applySelectedInvoicesToLines();
    setTimeout(() => handleSave("Posted"), 100);
  }}
>
  Done
</button>
                  </div>
                </div>
              </div>
            )}

{/* ===================== Purchase Order Modal ===================== */}

            {showPoModal && (
              <div className="apv-modal-overlay">
                <div className="apv-modal">
                  <div className="apv-modal-header">
                    <div>
                      <h2>Open Purchase Orders</h2>
                      <p>Select a Purchase Order to load its supplier and lines into this APV.</p>
                    </div>
                    <button
                      type="button"
                      className="apv-modal-close"
                      onClick={() => setShowPoModal(false)}
                    >
                      ×
                    </button>
                  </div>

                  <div className="apv-modal-table-wrap">
                    <table className="apv-modal-table">
                      <thead>
                        <tr>
                          <th>PO No.</th>
                          <th>Date</th>
                          <th>Supplier</th>
                          <th className="text-right">Amount</th>
                          <th className="text-center">Action</th>
                        </tr>
                      </thead>

                      <tbody>
                        {openPos.length === 0 ? (
                          <tr>
                            <td colSpan="5" className="no-apv-message">
                              No Open Purchase Orders
                            </td>
                          </tr>
                        ) : (
                          openPos.map((po) => (
                            <tr key={po.id}>
                              <td>{po.voucherNo}</td>
                              <td>{po.transactionDate}</td>
                              <td>{po.supplierName}</td>
                              <td className="text-right">
                                ₱ {formatMoney(po.totalCredit || po.totalDebit)}
                              </td>
                              <td className="text-center">
                                <button
                                  type="button"
                                  className="transaction-view-button"
                                  onClick={() => selectPo(po)}
                                >
                                  Select
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="apv-modal-footer">
                    <button
                      type="button"
                      className="transaction-secondary-button"
                      onClick={() => setShowPoModal(false)}
                    >
                      Cancel
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

