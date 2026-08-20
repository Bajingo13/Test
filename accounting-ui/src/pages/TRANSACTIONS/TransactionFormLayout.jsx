import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import PartyQuickAddModal from "../../components/PartyQuickAddModal";
import TransactionPrintOptionsModal from "../../components/TransactionPrintOptionsModal";
import RecurringTemplateModal from "../../components/RecurringTemplateModal";
import { computeEwtTaxableBase, computeEwtAmount } from "../../utils/ewtCalculations";
import usePermissions from "../../hooks/usePermissions";
import { getTransactionModuleConfig } from "./transactionModuleConfig";
import "./TransactionFormLayout.css";

const CURRENCY_MODULE_KEY = "FILESETUP.CURRENCY_SETUP";

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem("user") || "null");
  } catch {
    return null;
  }
}

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

// Checkpoint 3FX: for the application modal's "estimated FX" preview only
// (informational, section 14) - never posted from here. The backend
// independently recalculates everything at save time (section 29) via
// transactionCurrencyService.buildApplication, so this never needs to be
// more precise than a display estimate.
function roundTo2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export default function TransactionFormLayout({
  title,
  code,
  partyLabel,
  showCheckNo = false,
  defaultDescription = "",
  defaultLines = [createLine(), createLine()],
  partyType = null,
  printModuleType = null,
  recurringModuleType = null,
}) {
  const [searchParams] = useSearchParams();
  const { can: canCurrency } = usePermissions();

  // Checkpoint 6: a single explicit module-routing config replaces what
  // used to be three duplicated endpoint ternaries, each defaulting an
  // unrecognized code to "apv" - the exact bug that let Petty Cash
  // Voucher and Debit/Credit Memo silently save into apv_headers (see
  // the Checkpoint 6 completion report). An unmapped code now fails
  // clearly (moduleConfigError, rendered below) instead of ever
  // resolving to another module's endpoint. currencyEligible now covers
  // Petty Cash/Memo too - Checkpoint 6 gave them real backend currency
  // support (transactionCurrencyService), closing the gap the old
  // comment here used to document.
  let moduleConfig = null;
  let moduleConfigError = null;
  try {
    moduleConfig = getTransactionModuleConfig(code);
  } catch (err) {
    moduleConfigError = err.message;
  }

  const CURRENCY_ELIGIBLE = moduleConfig?.currencyEligible ?? false;

  const [mode, setMode] = useState("list");
  const [transactions, setTransactions] = useState([]);
  const [selectedTransaction, setSelectedTransaction] = useState(null);
  const [showPrintOptionsModal, setShowPrintOptionsModal] = useState(false);
  const [showRecurringModal, setShowRecurringModal] = useState(false);

  const [accountOptions, setAccountOptions] = useState([]);
  const [partyOptions, setPartyOptions] = useState([]);
  const [unpaidApvs, setUnpaidApvs] = useState([]);
  const [showApvModal, setShowApvModal] = useState(false);
  const [apvApplications, setApvApplications] = useState([]);
  const [showPartyModal, setShowPartyModal] = useState(false);

  const [invoiceApplications, setInvoiceApplications] = useState([]);
  const [unpaidInvoices, setUnpaidInvoices] = useState([]);
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);

  // Posting after applySelectedApvsToLines()/applySelectedInvoicesToLines()
  // must wait for THAT state update to actually land in `lines` before
  // handleSave("Posted") reads it - a setTimeout after the setLines() call
  // does NOT do this: the timeout closure still captures the pre-update
  // `lines` from the render the click happened on (a stale-closure bug),
  // so the auto-filled AR/AP line's amount never reached the save and
  // "Each line must have either debit or credit" fired every time. A flag
  // consumed by a useEffect keyed on `lines` guarantees the save only runs
  // after the state update has actually been committed and re-rendered.
  const [pendingAutoPost, setPendingAutoPost] = useState(false);

  const [openPos, setOpenPos] = useState([]);
  const [showPoModal, setShowPoModal] = useState(false);
  const [sourcePoId, setSourcePoId] = useState(null);
  const [sourcePoNo, setSourcePoNo] = useState("");

  const [ewtCodes, setEwtCodes] = useState([]);
  const [atcCode, setAtcCode] = useState("");
  const [taxWithheldAmount, setTaxWithheldAmount] = useState("");
  // Tracks whether the user has typed over the auto-suggested EWT amount, so
  // the live recompute below (when lines/VAT change) doesn't clobber a
  // deliberate manual override.
  const [taxWithheldTouched, setTaxWithheldTouched] = useState(false);
  const [payeeTin, setPayeeTin] = useState("");

  const [vatAccountId, setVatAccountId] = useState("");
  const [vatTaxableAmount, setVatTaxableAmount] = useState("");
  const [vatRate, setVatRate] = useState("12");

  // Multi-currency (Checkpoint 3A) - selectedCurrencyId defaults to the
  // company base currency once loaded. currencySnapshot mirrors what the
  // backend's transaction_currency_snapshots row will look like; for an
  // EXISTING transaction it is loaded verbatim from the stored snapshot
  // (never re-resolved just from opening it - section 8/36), and only
  // changes here when the user explicitly clicks Refresh or submits an
  // override.
  const [currencyOptions, setCurrencyOptions] = useState([]);
  const [baseCurrency, setBaseCurrency] = useState(null);
  const [selectedCurrencyId, setSelectedCurrencyId] = useState("");
  const [currencySnapshot, setCurrencySnapshot] = useState(null);
  const [rateResolving, setRateResolving] = useState(false);
  const [rateError, setRateError] = useState("");
  const [pendingRateAction, setPendingRateAction] = useState(null); // "refresh" | "override" | null
  const [refreshPreview, setRefreshPreview] = useState(null);
  const [showOverrideForm, setShowOverrideForm] = useState(false);
  const [overrideRateValue, setOverrideRateValue] = useState("");
  const [overrideReason, setOverrideReason] = useState("");

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

    if (["APV", "CV", "PO", "INV", "OR"].includes(code)) {
      loadEwtCodes();
    }

    if (CURRENCY_ELIGIBLE) {
      loadCurrencies();
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

  async function loadCurrencies() {
    try {
      const res = await fetch(`${API_BASE}/api/currencies`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        handleAuthError(res.status);
        return;
      }
      const active = Array.isArray(data) ? data.filter((c) => c.isActive) : [];
      setCurrencyOptions(active);
      const base = active.find((c) => c.isBaseCurrency) || null;
      setBaseCurrency(base);
      setSelectedCurrencyId((prev) => prev || (base ? String(base.id) : ""));
    } catch (err) {
      console.error("LOAD CURRENCIES ERROR:", err);
    }
  }

  // Read-only lookup (Phase 2's resolver via the resolve-only endpoint) -
  // never persists anything itself. Used both for the initial rate-card
  // display when a foreign currency is picked, and for a Refresh preview.
  async function resolveRateFor(currencyId) {
    setRateResolving(true);
    setRateError("");
    try {
      const res = await fetch(`${API_BASE}/api/exchange-rates/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ currencyId, transactionDate: form.date }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRateError(data.message || "Failed to resolve exchange rate.");
        return null;
      }
      if (data.rate == null) {
        setRateError(data.errorMessage || `No approved exchange rate is available for this currency on ${form.date}.`);
        return null;
      }
      return {
        exchangeRate: data.rate,
        rateSource: data.provider,
        rateBasis: data.rateBasis,
        rateDate: data.effectiveDate,
        rateStatus: data.status,
        rateRetrievedAt: data.retrievalTimestamp,
        rateIngestionMethod: data.derivationMethod ? "DERIVED" : "API",
        rateLocked: false,
      };
    } catch (err) {
      console.error("RESOLVE RATE ERROR:", err);
      setRateError("Unable to connect to server.");
      return null;
    } finally {
      setRateResolving(false);
    }
  }

  async function handleCurrencyChange(currencyId) {
    setSelectedCurrencyId(currencyId);
    setPendingRateAction(null);
    setShowOverrideForm(false);
    setRefreshPreview(null);
    setRateError("");

    const currency = currencyOptions.find((c) => String(c.id) === String(currencyId));
    if (!currency || currency.isBaseCurrency) {
      setCurrencySnapshot(null);
      return;
    }
    const resolved = await resolveRateFor(currencyId);
    if (resolved) setCurrencySnapshot(resolved);
  }

  // Shows old-vs-new for confirmation (section 8) rather than silently
  // replacing the draft's rate - only applied to currencySnapshot once the
  // user explicitly confirms via confirmRefresh().
  async function handleRefreshRateClick() {
    const fresh = await resolveRateFor(selectedCurrencyId);
    if (!fresh) return;
    if (currencySnapshot && Math.abs(fresh.exchangeRate - currencySnapshot.exchangeRate) < 0.0000001) {
      setRateError("The resolved rate is unchanged - no refresh needed.");
      return;
    }
    setRefreshPreview(fresh);
  }

  function confirmRefresh() {
    setCurrencySnapshot(refreshPreview);
    setPendingRateAction("refresh");
    setRefreshPreview(null);
  }

  function submitOverride() {
    const rate = Number(overrideRateValue);
    if (!rate || !Number.isFinite(rate) || rate <= 0) {
      setRateError("Override exchange rate must be greater than zero.");
      return;
    }
    if (!overrideReason.trim()) {
      setRateError("A reason is required to override the exchange rate.");
      return;
    }
    setRateError("");
    setCurrencySnapshot((prev) => ({ ...(prev || {}), exchangeRate: rate }));
    setPendingRateAction("override");
    setShowOverrideForm(false);
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

      const wantsSupplier = partyLabel.toLowerCase().includes("supplier");
      const wantsCustomer = partyLabel.toLowerCase().includes("customer");

      let filtered = data;

      if (wantsSupplier && wantsCustomer) {
        // e.g. Debit/Credit Memo's "Customer / Supplier" label - both types
        // are legitimate here, unlike the single-type cases below.
        filtered = data.filter((item) => item.type === "SUPPLIER" || item.type === "CUSTOMER");
      } else if (wantsSupplier) {
        filtered = data.filter((item) => item.type === "SUPPLIER");
      } else if (wantsCustomer) {
        filtered = data.filter((item) => item.type === "CUSTOMER");
      }

      const active = filtered.filter((item) => item.status === "ACTIVE");
      setPartyOptions(active);
      return active;
    } catch (err) {
      console.error("LOAD GENLIB ERROR:", err);
      return partyOptions;
    }
  }

  async function loadTransactions() {
    if (moduleConfigError) return;
    try {
      const endpoint = moduleConfig.endpoint;
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
            // totalDebit/totalCredit are base-currency GL values (section
            // 14) - the LIST display shows the transaction's own foreign
            // total (from its currency snapshot) with its own symbol when
            // one exists, matching section 35's "USD Invoice: $1,000" -
            // never the base amount mislabeled with a foreign symbol.
            amount: item.foreignTotal ?? (item.totalCredit || item.totalDebit),
            paidAmount: item.paidAmount || 0,
            balanceAmount: item.balanceAmount ?? item.totalCredit ?? item.totalDebit,
            status: item.paymentStatus || item.status,
            currencySymbol: item.currencySymbol || null,
            currencyCode: item.currencyCode || null,
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
      // See the APV mapping above for why foreignTotal takes priority.
      amount: item.foreignTotal ?? (item.totalDebit || item.totalCredit),
      paidAmount: item.paidAmount || 0,
      balanceAmount:
        item.balanceAmount ?? item.totalDebit ?? item.totalCredit,
      status: item.paymentStatus || item.status,
      invoiceType: item.invoiceType || "Standard",
      currencySymbol: item.currencySymbol || null,
      currencyCode: item.currencyCode || null,
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
      amount: item.foreignTotal ?? (item.totalDebit || item.totalCredit),
      status: item.status,
      currencySymbol: item.currencySymbol || null,
      currencyCode: item.currencyCode || null,
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
            amount: item.foreignTotal ?? (item.totalCredit || item.totalDebit),
            status: item.status,
            currencySymbol: item.currencySymbol || null,
            currencyCode: item.currencyCode || null,
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
            amount: item.foreignTotal ?? (item.totalCredit || item.totalDebit),
            status: item.status,
            currencySymbol: item.currencySymbol || null,
            currencyCode: item.currencyCode || null,
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

      if (code === "JV") {
        setTransactions(
          data.map((item) => ({
            id: item.id,
            referenceNo: item.referenceNo || item.voucherNo,
            date: item.transactionDate,
            party: item.preparedFor,
            amount: item.foreignTotal ?? (item.totalDebit || item.totalCredit),
            status: item.status,
            currencySymbol: item.currencySymbol || null,
            currencyCode: item.currencyCode || null,
            form: {
              date: item.transactionDate,
              referenceNo: item.referenceNo || item.voucherNo,
              party: item.preparedFor,
              partyId: null,
              description: item.description,
              checkNo: "",
              status: item.status,
            },
            lines: [],
          }))
        );
      }

      // Checkpoint 6 - PCV/DM/CM previously had no branch here at all, so
      // setTransactions() was simply never called for them: the list page
      // permanently showed "No transactions yet" even though the API
      // correctly returned real rows (the endpoint-routing fix alone
      // wasn't enough - this per-module mapping is a second, separate
      // place the old code hardcoded a fixed module list). Found via
      // live Playwright verification, not a code review guess.
      if (code === "PCV") {
        setTransactions(
          data.map((item) => ({
            id: item.id,
            referenceNo: item.referenceNo || item.voucherNo,
            date: item.transactionDate,
            party: item.payeeName,
            amount: item.foreignTotal ?? (item.totalDebit || item.totalCredit),
            status: item.status,
            currencySymbol: item.currencySymbol || null,
            currencyCode: item.currencyCode || null,
            form: {
              date: item.transactionDate,
              referenceNo: item.referenceNo || item.voucherNo,
              party: item.payeeName,
              partyId: item.payeeId,
              description: item.description,
              checkNo: "",
              status: item.status,
            },
            lines: [],
          }))
        );
      }

      if (code === "DM" || code === "CM") {
        setTransactions(
          data.map((item) => ({
            id: item.id,
            referenceNo: item.referenceNo || item.voucherNo,
            date: item.transactionDate,
            party: item.partyName,
            amount: item.foreignTotal ?? (item.totalDebit || item.totalCredit),
            status: item.status,
            currencySymbol: item.currencySymbol || null,
            currencyCode: item.currencyCode || null,
            form: {
              date: item.transactionDate,
              referenceNo: item.referenceNo || item.voucherNo,
              party: item.partyName,
              partyId: item.partyId,
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

  async function loadUnpaidApvs(overrideId, overrideName) {
  try {
    const supplierId = overrideId !== undefined ? overrideId : form.partyId;
    const supplierName = overrideName !== undefined ? overrideName : form.party;

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

  async function loadUnpaidInvoices(overrideId, overrideName) {
  try {
    const customerId = overrideId !== undefined ? overrideId : form.partyId;
    const customerName = overrideName !== undefined ? overrideName : form.party;

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
          // Carries the PO's own foreign-currency line amount forward when
          // one exists, not its base-converted debit/credit - otherwise the
          // new APV would treat the PO's base equivalent as if it were the
          // foreign amount and convert it a second time.
          debit: (line.foreignDebit ?? line.debit) || "",
          credit: (line.foreignCredit ?? line.credit) || "",
        }))
      );

      setSourcePoId(po.id);
      setSourcePoNo(po.voucherNo || "");
      setShowPoModal(false);

      // Section 14: carry the PO's currency selection forward, but let the
      // APV independently resolve its OWN transaction-date rate rather than
      // inheriting the PO's historical rate - handleCurrencyChange() always
      // re-resolves via resolveRateFor(), it never copies data.currency's
      // rate verbatim. A base-currency PO needs no action; selectedCurrencyId
      // already defaults to the base currency.
      if (data.currency && data.currency.currencyId !== data.currency.baseCurrencyId) {
        handleCurrencyChange(String(data.currency.currencyId));
      }
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

  // EWT must be computed on the VAT-exclusive amount, never on VAT itself.
  // This form has no VAT-inclusive entry mode - the user enters the
  // exclusive base into the VAT helper below, which posts VAT as its own
  // line, so the exclusive base is simply the transaction total minus
  // whatever was posted to the VAT account. See utils/ewtCalculations.js.
  const ewtTaxableBase = useMemo(
    () => computeEwtTaxableBase({ grossAmount: totals.totalCredit, lines, vatAccountId }),
    [totals.totalCredit, lines, vatAccountId]
  );

  const suggestedEwtAmount = useMemo(
    () =>
      selectedEwt
        ? computeEwtAmount({ taxableBase: ewtTaxableBase, ewtRate: selectedEwt.rate })
        : 0,
    [ewtTaxableBase, selectedEwt]
  );

  function handleAtcCodeChange(value) {
    setAtcCode(value);
    setTaxWithheldTouched(false);

    const ewt = ewtCodes.find((e) => e.atcCode === value);
    if (ewt) {
      const base = computeEwtTaxableBase({ grossAmount: totals.totalCredit, lines, vatAccountId });
      const suggested = computeEwtAmount({ taxableBase: base, ewtRate: ewt.rate });
      setTaxWithheldAmount(suggested ? String(suggested) : "");
    } else {
      setTaxWithheldAmount("");
    }
  }

  // Keeps the suggested amount in sync as lines/VAT change while an ATC
  // code is already selected - but never overwrites a value the user (or a
  // loaded historical record) has already set.
  useEffect(() => {
    if (!atcCode || taxWithheldTouched) return;
    setTaxWithheldAmount(suggestedEwtAmount ? String(suggestedEwtAmount) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestedEwtAmount, atcCode]);

  const vatType =
    code === "INV" || code === "OR"
      ? "Output VAT"
      : code === "APV" || code === "CV" || code === "PO"
      ? "Input VAT"
      : null;

  // EWT direction differs by module: APV/CV/PO are outbound - the company
  // is the withholding agent, computes and remits EWT, and issues Form 2307
  // to the payee (hence the Payee TIN field). INV/OR are inbound - the
  // customer is the withholding agent; EWT here just records what they
  // already withheld from what they owe (evidenced by a 2307 they issue to
  // us), so there's no "payee" to collect a TIN for - see or_headers'
  // existing "Creditable Withholding Tax" line convention.
  const ewtOutbound = code === "APV" || code === "CV" || code === "PO";
  const ewtInbound = code === "INV" || code === "OR";
  const ewtEligible = ewtOutbound || ewtInbound;

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
setTaxWithheldTouched(false);
setPayeeTin("");

setSelectedCurrencyId(baseCurrency ? String(baseCurrency.id) : "");
setCurrencySnapshot(null);
setPendingRateAction(null);
setRefreshPreview(null);
setShowOverrideForm(false);
setRateError("");

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
    if (moduleConfigError) return;

    try {
      const endpoint = moduleConfig.endpoint;
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
      : code === "JV"
      ? data.preparedFor
      : code === "PCV"
      ? data.payeeName
      : code === "DM" || code === "CM"
      ? data.partyName
      : data.supplierName,

  partyId:
    code === "CV"
      ? data.payeeId
      : code === "OR" || code === "INV"
      ? data.customerId
      : code === "JV"
      ? null
      : code === "PCV"
      ? data.payeeId
      : code === "DM" || code === "CM"
      ? data.partyId
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
            // debit/credit store the BASE-currency GL amount (Checkpoint
            // 3A) - the editable form must show the transaction's own
            // foreign amount instead, or re-saving would resubmit the
            // already-converted base figure and get converted AGAIN.
            // foreignDebit/foreignCredit are undefined for modules with no
            // currency columns (OR/CV/JV/PO), so this falls back to
            // debit/credit unchanged for them.
            debit: (line.foreignDebit ?? line.debit) || "",
            credit: (line.foreignCredit ?? line.credit) || "",
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

if (ewtEligible) {
  setAtcCode(data.atcCode || "");
  setTaxWithheldAmount(data.taxWithheldAmount || "");
  // Loaded from a stored record - treat as user-set so the live-recompute
  // effect doesn't overwrite a saved (possibly historical/manually-adjusted)
  // amount just because the transaction was opened for viewing/editing.
  setTaxWithheldTouched(Boolean(data.atcCode));
  setPayeeTin(data.payeeTin || "");
}

if (CURRENCY_ELIGIBLE) {
  setPendingRateAction(null);
  setRefreshPreview(null);
  setShowOverrideForm(false);
  setRateError("");
  if (data.currency) {
    // Section 7/36: the STORED snapshot is loaded verbatim - never
    // re-resolved just because the transaction was opened.
    setSelectedCurrencyId(String(data.currency.currencyId));
    setCurrencySnapshot({
      exchangeRate: data.currency.exchangeRate,
      rateSource: data.currency.rateSource,
      rateBasis: data.currency.rateBasis,
      rateDate: data.currency.rateDate,
      rateStatus: data.currency.rateStatus,
      rateRetrievedAt: data.currency.rateRetrievedAt,
      rateIngestionMethod: data.currency.rateIngestionMethod,
      rateLocked: data.currency.rateLocked,
      overrideRate: data.currency.overrideRate,
      overrideReason: data.currency.overrideReason,
      systemRate: data.currency.systemRate,
    });
  } else if (data.currencyId) {
    setSelectedCurrencyId(String(data.currencyId));
    setCurrencySnapshot(null);
  } else {
    // Predates multi-currency (section 37) - implicitly the base
    // currency, never guessed as anything else.
    setSelectedCurrencyId(baseCurrency ? String(baseCurrency.id) : "");
    setCurrencySnapshot(null);
  }
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

  // optionsOverride lets a caller pass a just-fetched party list instead of
  // relying on `partyOptions` state, which wouldn't reflect a record created
  // a moment earlier in the same tick (see handlePartyCreated below).
  function handlePartyChange(value, optionsOverride) {
    const options = optionsOverride || partyOptions;
    const selectedParty = options.find(
      (party) => party.name.toLowerCase() === value.toLowerCase()
    );

    setForm((prev) => ({
      ...prev,
      party: value,
      partyId: selectedParty ? selectedParty.id : null,
      // Checkpoint 6: Debit/Credit Memo needs to know whether the picked
      // party is a customer or supplier (party.type from /api/genlib,
      // matching general_libraries.party_type) - nothing before this
      // checkpoint needed it captured in form state, since every other
      // party-bearing module has a fixed single partyType.
      partyType: selectedParty ? selectedParty.type : null,
    }));

    if (ewtEligible) {
      if (ewtOutbound) setPayeeTin(selectedParty?.tin || "");

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

// Outstanding invoices/APVs are loaded fresh in handlePostTransactionClick, right
// when the user tries to post with an AR/AP line present - not here. Loading them
// here used to run via setTimeout with a stale closure over the *previous* party
// (this handler fires on every keystroke), so the list almost always came back
// empty or filtered by the wrong customer/supplier.
  }

  // Fired by PartyQuickAddModal after a successful save. Re-fetches the
  // party list (so the new record is present) and selects it through the
  // exact same handlePartyChange path a manual pick goes through - reuses
  // its existing AP/AR line-sync and APV TIN/ATC side effects rather than
  // duplicating that logic here.
  async function handlePartyCreated(newRecord) {
    const freshOptions = await loadParties();
    handlePartyChange(newRecord.name, freshOptions);
    setShowPartyModal(false);
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

  // Checkpoint 3B section 6: the OR/CV's OWN resolved currency must match
  // the source document's currency before an application is even
  // selectable - never silently convert, never let the backend be the
  // first place this gets caught.
  function sourceCurrencyMismatch(sourceDoc) {
    const paymentCode =
      currencyOptions.find((c) => String(c.id) === String(selectedCurrencyId))?.currencyCode ||
      baseCurrency?.currencyCode;
    const sourceCode = sourceDoc.currencyCode || baseCurrency?.currencyCode;
    return !!paymentCode && !!sourceCode && paymentCode !== sourceCode;
  }

  // Section 15: summarizes every selected application with a non-zero
  // estimated FX difference and asks for one explicit confirmation before
  // posting - returns true to proceed. Same-rate-only selections (the
  // ordinary case) skip this entirely and return true immediately, so
  // normal same-currency-same-rate posting is completely unaffected.
  function confirmFxSettlement(applications, perspective) {
    const paymentRate = Number(currencySnapshot?.exchangeRate);
    if (!paymentRate) return true;

    const mismatched = applications
      .map((item) => {
        const sourceRate = Number(item.sourceExchangeRate);
        if (!sourceRate || Math.abs(sourceRate - paymentRate) < 0.000001) return null;
        const amount = Number(item.amount || 0);
        const diff = roundTo2(amount * (paymentRate - sourceRate));
        if (diff === 0) return null;
        const isGain = perspective === "PAYABLE" ? diff < 0 : diff > 0;
        return { voucherNo: item.voucherNo, amount, sourceRate, isGain, magnitude: Math.abs(diff) };
      })
      .filter(Boolean);

    if (!mismatched.length) return true;

    const lines = mismatched.map(
      (m) =>
        `${m.voucherNo}: ${baseCurrency?.currencySymbol || ""} ${formatMoney(m.magnitude)} ${m.isGain ? "Gain" : "Loss"} ` +
        `(source rate ${m.sourceRate.toFixed(6)} vs payment rate ${paymentRate.toFixed(6)})`
    );
    const totalGain = mismatched.filter((m) => m.isGain).reduce((s, m) => s + m.magnitude, 0);
    const totalLoss = mismatched.filter((m) => !m.isGain).reduce((s, m) => s + m.magnitude, 0);

    return window.confirm(
      "You are about to post a foreign-currency settlement at a different rate than the source document(s):\n\n" +
      lines.join("\n") +
      `\n\nTotal Realized Gain: ${baseCurrency?.currencySymbol || ""} ${formatMoney(totalGain)}` +
      `\nTotal Realized Loss: ${baseCurrency?.currencySymbol || ""} ${formatMoney(totalLoss)}` +
      "\n\nProceed?"
    );
  }

  function toggleApvApplication(apv) {
    if (sourceCurrencyMismatch(apv)) return;
    setApvApplications((prev) => {
      const exists = prev.find((item) => Number(item.sourceId || item.apvId || item.id) === Number(apv.id));

      if (exists) {
        return prev.filter((item) => Number(item.sourceId || item.apvId || item.id) !== Number(apv.id));
      }

      // For a foreign-currency APV, the balance the payment must respect
      // is the FOREIGN balance (section 7/9) - the base balance_amount is
      // a different currency's figure and would silently overstate what's
      // actually still owed in the APV's own currency.
      const isForeign = !!apv.currencyCode;
      const balance = isForeign
        ? Number(apv.foreignBalanceAmount ?? apv.foreignOriginalAmount ?? 0)
        : Number(apv.balanceAmount || apv.totalAmount || 0);
      const original = isForeign ? Number(apv.foreignOriginalAmount ?? 0) : Number(apv.totalAmount || 0);
      const paid = isForeign
        ? Number(apv.foreignOriginalAmount ?? 0) - Number(apv.foreignBalanceAmount ?? apv.foreignOriginalAmount ?? 0)
        : Number(apv.paidAmount || 0);

      return [
        ...prev,
        {
          sourceType: apv.sourceType || "APV",
          sourceId: apv.id,
          apvId: apv.id,
          voucherNo: apv.voucherNo,
          supplierName: apv.supplierName,
          currencyCode: apv.currencyCode || null,
          currencySymbol: apv.currencySymbol || null,
          sourceExchangeRate: apv.sourceExchangeRate ?? null,
          totalAmount: original,
          paidAmount: paid,
          balanceAmount: balance,
          amount: balance,
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
    if (sourceCurrencyMismatch(invoice)) return;
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

      // See toggleApvApplication for why a foreign-currency Invoice uses
      // its FOREIGN balance here instead of balance_amount (base).
      const isForeign = !!invoice.currencyCode;
      const balance = isForeign
        ? Number(invoice.foreignBalanceAmount ?? invoice.foreignOriginalAmount ?? 0)
        : Number(invoice.balanceAmount || invoice.totalAmount || 0);
      const original = isForeign ? Number(invoice.foreignOriginalAmount ?? 0) : Number(invoice.totalAmount || 0);
      const paid = isForeign
        ? Number(invoice.foreignOriginalAmount ?? 0) - Number(invoice.foreignBalanceAmount ?? invoice.foreignOriginalAmount ?? 0)
        : Number(invoice.paidAmount || 0);

      return [
        ...prev,
        {
          sourceType: invoice.sourceType || "INV",
          sourceId: invoice.id,
          invoiceId: invoice.id,
          voucherNo: invoice.voucherNo,
          customerName: invoice.customerName,
          currencyCode: invoice.currencyCode || null,
          currencySymbol: invoice.currencySymbol || null,
          sourceExchangeRate: invoice.sourceExchangeRate ?? null,
          totalAmount: original,
          paidAmount: paid,
          balanceAmount: balance,
          amount: balance,
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

  // Fires only after applySelectedApvsToLines()/applySelectedInvoicesToLines()'s
  // setLines() has actually been committed and this component re-rendered
  // with the auto-filled AR/AP line - see the pendingAutoPost declaration
  // above for why a setTimeout could not guarantee that ordering.
  useEffect(() => {
    if (pendingAutoPost) {
      setPendingAutoPost(false);
      handleSave("Posted");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoPost, lines]);

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
    if (moduleConfigError) {
      setError(moduleConfigError);
      return;
    }

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

        // Checkpoint 6 - Petty Cash reads payeeId/payeeName, Debit/Credit
        // Memo reads partyId/partyName/partyType (see server.js). Sent
        // redundantly alongside supplierId/customerId above, same
        // established pattern this payload already uses so each
        // module's backend route can read the one key pair it cares
        // about - discovered missing via live Playwright verification
        // (records were saving with an empty payee/party name).
        payeeId: updatedForm.partyId || null,
        payeeName: updatedForm.party,

        partyId: updatedForm.partyId || null,
        partyName: updatedForm.party,
        partyType: updatedForm.partyType || null,

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

        atcCode: ewtEligible ? atcCode || null : null,
        taxType: ewtEligible ? selectedEwt?.taxType || null : null,
        taxRate: ewtEligible ? selectedEwt?.rate || null : null,
        taxWithheldAmount: ewtEligible ? Number(taxWithheldAmount) || null : null,
        payeeTin: ewtOutbound ? payeeTin || null : null,

        invoiceType: code === "INV" ? invoiceType : null,
        recurrenceFrequency: code === "INV" && invoiceType === "Recurring" ? recurrenceFrequency : null,

        paymentMethod: code === "OR" || code === "CV" ? paymentMethod : null,
        bankAccountId: code === "OR" || code === "CV" ? bankAccountId || null : null,
        checkNo: (code === "OR" || code === "CV") && paymentMethod === "Check" ? checkNumber : null,
        checkDate: (code === "OR" || code === "CV") && paymentMethod === "Check" ? checkDate : null,

        // Multi-currency (Checkpoint 3A) - the backend independently
        // resolves/validates this (never trusts exchangeRate at face
        // value except for an explicit, permissioned override) per
        // transactionCurrencyService.resolveTransactionCurrency.
        currency: CURRENCY_ELIGIBLE && selectedCurrencyId ? {
          currencyId: selectedCurrencyId,
          exchangeRate: currencySnapshot?.exchangeRate ?? 1,
          rateDate: currencySnapshot?.rateDate || form.date,
          rateSource: currencySnapshot?.rateSource,
          rateBasis: currencySnapshot?.rateBasis,
          rateStatus: currencySnapshot?.rateStatus,
          rateRetrievedAt: currencySnapshot?.rateRetrievedAt,
          rateIngestionMethod: currencySnapshot?.rateIngestionMethod,
          isOverride: pendingRateAction === "override",
          overrideReason: pendingRateAction === "override" ? overrideReason : undefined,
          isRefresh: pendingRateAction === "refresh",
        } : undefined,
      };

      const endpoint = moduleConfig.endpoint;
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

  // Checkpoint 6: fail clearly instead of ever silently routing an
  // unmapped module code to another module's API endpoint (the old bug -
  // see transactionModuleConfig.js). This is a configuration error a
  // developer needs to fix, not a data/permission error a user can act
  // on, so it replaces the whole page rather than trying to render a
  // form that has no real endpoint behind it.
  if (moduleConfigError) {
    return (
      <div className="transaction-page">
        <div className="transaction-wrapper">
          <div className="transaction-card" style={{ padding: 24 }}>
            <h1 className="transaction-title">Configuration Error</h1>
            <p style={{ color: "var(--danger-text, #b91c1c)", marginTop: 12 }}>{moduleConfigError}</p>
          </div>
        </div>
      </div>
    );
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
                            {transaction.currencySymbol || baseCurrency?.currencySymbol || "₱"}{" "}
                            {formatMoney(transaction.amount)}
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

                {printModuleType && selectedTransaction?.id ? (
                  <button
                    type="button"
                    className="transaction-secondary-button"
                    onClick={() => setShowPrintOptionsModal(true)}
                  >
                    🖨 Print
                  </button>
                ) : (
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
                )}

                {recurringModuleType && selectedTransaction?.id && (
                  <button
                    type="button"
                    className="transaction-secondary-button"
                    onClick={() => setShowRecurringModal(true)}
                  >
                    🔁 Make Recurring
                  </button>
                )}

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
                  <div className="transaction-party-row">
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

                    {partyType && (
                      <button
                        type="button"
                        className="transaction-party-add-btn"
                        onClick={() => setShowPartyModal(true)}
                        title={
                          partyType === "BOTH"
                            ? "Add New Customer or Supplier"
                            : `Add New ${partyType === "SUPPLIER" ? "Supplier" : "Customer"}`
                        }
                        aria-label={
                          partyType === "BOTH"
                            ? "Add New Customer or Supplier"
                            : `Add New ${partyType === "SUPPLIER" ? "Supplier" : "Customer"}`
                        }
                      >
                        +
                      </button>
                    )}
                  </div>
                </div>

                {partyType && (
                  <PartyQuickAddModal
                    open={showPartyModal}
                    partyType={partyType}
                    onClose={() => setShowPartyModal(false)}
                    onCreated={handlePartyCreated}
                  />
                )}

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

            {CURRENCY_ELIGIBLE && (
              <div className="transaction-card">
                <div className="transaction-section-header">
                  <div>
                    <h2 className="transaction-section-title">Currency</h2>
                    <p className="transaction-section-subtext">
                      {currencySnapshot?.rateLocked
                        ? "This transaction is posted - its exchange rate is locked and cannot be changed."
                        : "Select the currency this transaction is denominated in. Defaults to the company base currency."}
                    </p>
                  </div>
                </div>

                <div className="transaction-grid">
                  <div className="transaction-field">
                    <label className="transaction-label">Transaction Currency</label>
                    <select
                      value={selectedCurrencyId}
                      onChange={(e) => handleCurrencyChange(e.target.value)}
                      disabled={currencySnapshot?.rateLocked}
                      className="transaction-input"
                    >
                      {currencyOptions.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.currencySymbol} {c.currencyCode} — {c.currencyName}{c.isBaseCurrency ? " (Base)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {rateError && <p className="transaction-rate-error">{rateError}</p>}

                {String(selectedCurrencyId) !== String(baseCurrency?.id || "") && (
                  <div className="transaction-rate-card">
                    {rateResolving ? (
                      <p>Resolving exchange rate…</p>
                    ) : currencySnapshot ? (
                      <>
                        <div className="transaction-rate-headline">
                          1 {currencyOptions.find((c) => String(c.id) === String(selectedCurrencyId))?.currencyCode} ={" "}
                          {Number(currencySnapshot.exchangeRate).toFixed(6)} {baseCurrency?.currencyCode}
                        </div>
                        <div className="transaction-rate-meta">
                          <span>Source: <strong>{currencySnapshot.rateSource || "—"}</strong></span>
                          {currencySnapshot.rateBasis && <span>Basis: <strong>{currencySnapshot.rateBasis}</strong></span>}
                          <span>Effective: <strong>{currencySnapshot.rateDate || "—"}</strong></span>
                          <span>Status: <strong>{currencySnapshot.rateStatus || "—"}</strong></span>
                          {currencySnapshot.rateLocked && <span className="transaction-rate-locked">🔒 Locked (Posted)</span>}
                          {pendingRateAction === "override" && <span className="transaction-rate-override-badge">Manual Override</span>}
                        </div>

                        {!currencySnapshot.rateLocked && (
                          <div className="transaction-rate-actions">
                            <button type="button" className="transaction-secondary-button" onClick={handleRefreshRateClick} disabled={rateResolving}>
                              Refresh Rate
                            </button>
                            {canCurrency(CURRENCY_MODULE_KEY, "OVERRIDE_RATE") && (
                              <button type="button" className="transaction-secondary-button" onClick={() => setShowOverrideForm((v) => !v)}>
                                Manual Override
                              </button>
                            )}
                          </div>
                        )}

                        {refreshPreview && (
                          <div className="transaction-rate-refresh-preview">
                            <p>
                              Previous Rate: <strong>{Number(currencySnapshot.exchangeRate).toFixed(6)}</strong> (as of {currencySnapshot.rateDate}) →{" "}
                              New Rate: <strong>{Number(refreshPreview.exchangeRate).toFixed(6)}</strong> (as of {refreshPreview.rateDate}, {refreshPreview.rateSource})
                            </p>
                            <div className="transaction-rate-actions">
                              <button type="button" className="transaction-secondary-button" onClick={() => setRefreshPreview(null)}>Cancel</button>
                              <button type="button" className="transaction-primary-button" onClick={confirmRefresh}>Use New Rate</button>
                            </div>
                          </div>
                        )}

                        {showOverrideForm && (
                          <div className="transaction-rate-override-form">
                            <div className="transaction-grid">
                              <div className="transaction-field">
                                <label className="transaction-label">Override Rate</label>
                                <input
                                  type="number"
                                  step="0.0000000001"
                                  min="0"
                                  value={overrideRateValue}
                                  onChange={(e) => setOverrideRateValue(e.target.value)}
                                  placeholder={String(currencySnapshot.exchangeRate)}
                                  className="transaction-input"
                                />
                              </div>
                              <div className="transaction-field">
                                <label className="transaction-label">Reason (required)</label>
                                <input
                                  type="text"
                                  value={overrideReason}
                                  onChange={(e) => setOverrideReason(e.target.value)}
                                  placeholder="e.g. Bank settlement rate used"
                                  className="transaction-input"
                                />
                              </div>
                            </div>
                            <div className="transaction-rate-actions">
                              <button type="button" className="transaction-secondary-button" onClick={() => setShowOverrideForm(false)}>Cancel</button>
                              <button type="button" className="transaction-primary-button" onClick={submitOverride}>Apply Override</button>
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <p>No exchange rate available yet.</p>
                    )}
                  </div>
                )}
              </div>
            )}

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

            {ewtEligible && (
              <div className="transaction-card">
                <div className="transaction-section-header">
                  <div>
                    <h2 className="transaction-section-title">
                      {ewtOutbound ? "Withholding Tax" : "Tax Withheld by Customer"}
                    </h2>
                    <p className="transaction-section-subtext">
                      {ewtOutbound
                        ? "Optional — only fill in if tax was withheld from this payment."
                        : "Optional — only fill in if the customer withheld tax from this amount (per the Form 2307 they issue you)."}
                      {" "}For VATable transactions, EWT is computed on the amount exclusive of VAT.
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
                    <label
                      className="transaction-label"
                      title="For VATable transactions, EWT is computed on the amount exclusive of VAT."
                    >
                      EWT Base (VAT-exclusive)
                    </label>
                    <input
                      type="text"
                      value={atcCode ? formatMoney(ewtTaxableBase) : ""}
                      readOnly
                      placeholder="Select an ATC code"
                      className="transaction-input transaction-input-readonly"
                      title="Gross amount minus VAT posted on this transaction."
                    />
                  </div>

                  <div className="transaction-field">
                    <label
                      className="transaction-label"
                      title="For VATable transactions, EWT is computed on the amount exclusive of VAT."
                    >
                      Tax Withheld Amount
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={taxWithheldAmount}
                      onChange={(e) => {
                        setTaxWithheldAmount(e.target.value);
                        setTaxWithheldTouched(true);
                      }}
                      disabled={!atcCode}
                      placeholder="0.00"
                      className="transaction-input"
                    />
                  </div>

                  {ewtOutbound && (
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
                  )}
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
                          <th>Source Rate</th>
                          <th className="text-right">Original</th>
                          <th className="text-right">Paid</th>
                          <th className="text-right">Balance</th>
                          <th className="text-right">Amount to Pay</th>
                        </tr>
                      </thead>

                      <tbody>
                        {unpaidApvs.length === 0 ? (
  <tr>
    <td colSpan="8" className="no-apv-message">
      No Payables Have Been Setup
    </td>
  </tr>
) : (
                          unpaidApvs.map((apv) => {
                            const selected = apvApplications.find(
                              (item) => Number(item.sourceId || item.apvId) === Number(apv.id)
                            );
                            const isForeign = !!apv.currencyCode;
                            const symbol = apv.currencySymbol || baseCurrency?.currencySymbol || "₱";
                            const displayOriginal = isForeign ? apv.foreignOriginalAmount : apv.totalAmount;
                            const displayBalance = isForeign
                              ? apv.foreignBalanceAmount ?? apv.foreignOriginalAmount
                              : apv.balanceAmount;
                            const displayPaid = isForeign
                              ? Number(apv.foreignOriginalAmount ?? 0) - Number(displayBalance ?? 0)
                              : apv.paidAmount;
                            const mismatch = sourceCurrencyMismatch(apv);
                            // Checkpoint 3FX section 14: estimate only (never posted from here -
                            // the backend independently recalculates everything at save time).
                            const paymentRate = isForeign ? Number(currencySnapshot?.exchangeRate) || null : null;
                            const estimatedFx =
                              isForeign && selected && paymentRate
                                ? roundTo2(Number(selected.amount || 0) * (paymentRate - Number(apv.sourceExchangeRate)))
                                : null;

                            return (
                              <tr key={apv.id}>
                                <td className="text-center">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(selected)}
                                    disabled={mismatch}
                                    onChange={() => toggleApvApplication(apv)}
                                  />
                                </td>
                                <td>{apv.voucherNo}</td>
                                <td>{apv.supplierName}</td>
                                <td>{isForeign ? Number(apv.sourceExchangeRate).toFixed(6) : "—"}</td>
                                <td className="text-right">{symbol} {formatMoney(displayOriginal)}</td>
                                <td className="text-right">{symbol} {formatMoney(displayPaid)}</td>
                                <td className="text-right">{symbol} {formatMoney(displayBalance)}</td>
                                <td>
                                  {mismatch ? (
                                    <span className="transaction-rate-error" style={{ fontSize: "0.75rem" }}>
                                      This payment currency differs from the source document currency. Cross-currency settlement is not enabled.
                                    </span>
                                  ) : (
                                    <>
                                      <input
                                        type="number"
                                        min="0"
                                        max={displayBalance}
                                        step="0.01"
                                        disabled={!selected}
                                        value={selected?.amount || ""}
                                        onChange={(e) =>
                                          updateApvApplicationAmount(apv.id, e.target.value)
                                        }
                                        className="apv-payment-input"
                                      />
                                      {estimatedFx !== null && estimatedFx !== 0 && (
                                        <div className="transaction-rate-meta" style={{ fontSize: "0.72rem", marginTop: 2 }}>
                                          {/* PAYABLE: paymentRate > sourceRate means paying MORE base than owed -> a LOSS */}
                                          Payment Rate {paymentRate.toFixed(6)} · Historical{" "}
                                          {baseCurrency?.currencySymbol} {formatMoney(Number(selected.amount) * Number(apv.sourceExchangeRate))} ·{" "}
                                          Est. {estimatedFx > 0 ? "FX Loss" : "FX Gain"}{" "}
                                          {baseCurrency?.currencySymbol} {formatMoney(Math.abs(estimatedFx))}
                                        </div>
                                      )}
                                    </>
                                  )}
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
                      Total Applied: {currencyOptions.find((c) => String(c.id) === String(selectedCurrencyId))?.currencySymbol || baseCurrency?.currencySymbol || "₱"} {formatMoney(
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

    // Section 15: a clear confirmation summary before posting any
    // different-rate (non-zero FX) settlement - never required for a
    // same-rate application, matching current UX for the ordinary case.
    if (!confirmFxSettlement(apvApplications, "PAYABLE")) return;

    applySelectedApvsToLines();
    setPendingAutoPost(true);
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
                          <th>Source Rate</th>
                          <th className="text-right">Original</th>
                          <th className="text-right">Paid</th>
                          <th className="text-right">Balance</th>
                          <th className="text-right">Amount to Receive</th>
                        </tr>
                      </thead>

                      <tbody>
                        {unpaidInvoices.length === 0 ? (
  <tr>
    <td colSpan="8" className="no-apv-message">
      No Outstanding Invoices
    </td>
  </tr>
) : (
                          unpaidInvoices.map((invoice) => {
                            const selected = invoiceApplications.find(
                              (item) => Number(item.sourceId || item.invoiceId) === Number(invoice.id)
                            );
                            const isForeign = !!invoice.currencyCode;
                            const symbol = invoice.currencySymbol || baseCurrency?.currencySymbol || "₱";
                            const displayOriginal = isForeign ? invoice.foreignOriginalAmount : invoice.totalAmount;
                            const displayBalance = isForeign
                              ? invoice.foreignBalanceAmount ?? invoice.foreignOriginalAmount
                              : invoice.balanceAmount;
                            const displayPaid = isForeign
                              ? Number(invoice.foreignOriginalAmount ?? 0) - Number(displayBalance ?? 0)
                              : invoice.paidAmount;
                            const mismatch = sourceCurrencyMismatch(invoice);
                            // RECEIVABLE: paymentRate > sourceRate means MORE base was received than
                            // recorded -> a GAIN (opposite sign convention from the payable/CV modal).
                            const paymentRate = isForeign ? Number(currencySnapshot?.exchangeRate) || null : null;
                            const estimatedFx =
                              isForeign && selected && paymentRate
                                ? roundTo2(Number(selected.amount || 0) * (paymentRate - Number(invoice.sourceExchangeRate)))
                                : null;

                            return (
                              <tr key={invoice.id}>
                                <td className="text-center">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(selected)}
                                    disabled={mismatch}
                                    onChange={() => toggleInvoiceApplication(invoice)}
                                  />
                                </td>
                                <td>{invoice.voucherNo}</td>
                                <td>{invoice.customerName}</td>
                                <td>{isForeign ? Number(invoice.sourceExchangeRate).toFixed(6) : "—"}</td>
                                <td className="text-right">{symbol} {formatMoney(displayOriginal)}</td>
                                <td className="text-right">{symbol} {formatMoney(displayPaid)}</td>
                                <td className="text-right">{symbol} {formatMoney(displayBalance)}</td>
                                <td>
                                  {mismatch ? (
                                    <span className="transaction-rate-error" style={{ fontSize: "0.75rem" }}>
                                      This payment currency differs from the source document currency. Cross-currency settlement is not enabled.
                                    </span>
                                  ) : (
                                    <>
                                      <input
                                        type="number"
                                        min="0"
                                        max={displayBalance}
                                        step="0.01"
                                        disabled={!selected}
                                        value={selected?.amount || ""}
                                        onChange={(e) =>
                                          updateInvoiceApplicationAmount(invoice.id, e.target.value)
                                        }
                                        className="apv-payment-input"
                                      />
                                      {estimatedFx !== null && estimatedFx !== 0 && (
                                        <div className="transaction-rate-meta" style={{ fontSize: "0.72rem", marginTop: 2 }}>
                                          Payment Rate {paymentRate.toFixed(6)} · Historical{" "}
                                          {baseCurrency?.currencySymbol} {formatMoney(Number(selected.amount) * Number(invoice.sourceExchangeRate))} ·{" "}
                                          Est. {estimatedFx > 0 ? "FX Gain" : "FX Loss"}{" "}
                                          {baseCurrency?.currencySymbol} {formatMoney(Math.abs(estimatedFx))}
                                        </div>
                                      )}
                                    </>
                                  )}
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
                      Total Applied: {currencyOptions.find((c) => String(c.id) === String(selectedCurrencyId))?.currencySymbol || baseCurrency?.currencySymbol || "₱"} {formatMoney(
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

    if (!confirmFxSettlement(invoiceApplications, "RECEIVABLE")) return;

    applySelectedInvoicesToLines();
    setPendingAutoPost(true);
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
              {printModuleType && selectedTransaction?.id ? (
                <button
                  type="button"
                  className="transaction-secondary-button"
                  onClick={() => setShowPrintOptionsModal(true)}
                >
                  🖨 Print
                </button>
              ) : (
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
              )}

              {recurringModuleType && selectedTransaction?.id && (
                <button
                  type="button"
                  className="transaction-secondary-button"
                  onClick={() => setShowRecurringModal(true)}
                >
                  🔁 Make Recurring
                </button>
              )}

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

        {printModuleType && (
          <TransactionPrintOptionsModal
            open={showPrintOptionsModal}
            onClose={() => setShowPrintOptionsModal(false)}
            transactionType={printModuleType}
            transactionId={selectedTransaction?.id}
            currentUser={getCurrentUser()}
          />
        )}

        {recurringModuleType && selectedTransaction?.id && (
          <RecurringTemplateModal
            open={showRecurringModal}
            onClose={() => setShowRecurringModal(false)}
            transactionType={recurringModuleType}
            transactionId={selectedTransaction.id}
            currentUser={getCurrentUser()}
          />
        )}
      </div>
    </div>
  );
}

