import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import TransactionPrintOptionsModal from "../../components/TransactionPrintOptionsModal";
import RecurringTemplateModal from "../../components/RecurringTemplateModal";
import { computeEwtTaxableBase, computeEwtAmount } from "../../utils/ewtCalculations";
import usePermissions from "../../hooks/usePermissions";
import { getTransactionModuleConfig } from "./transactionModuleConfig";
import { getVoucherToolbarVisibility } from "./voucherToolbarRules.mjs";
import { formatMoney } from "./transactionFormUtils";
import TransactionVoucherHeader from "./TransactionVoucherHeader";
import CurrencySummary from "./CurrencySummary";
import AccountingEntriesGrid from "./AccountingEntriesGrid";
import EntryTotals from "./EntryTotals";
import ViewField from "./ViewField";
import VoucherToolbar from "./VoucherToolbar";
import AddEntryMenu from "./AddEntryMenu";
import VatEntryModal from "./VatEntryModal";
import EwtEntryModal from "./EwtEntryModal";
import TaxDetailsViewModal from "./TaxDetailsViewModal";
import { filterTransactions, deriveStatusOptions } from "./transactionListFilters.mjs";
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
  const { can } = usePermissions();

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
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All Status");
  // Phase 7B: "view" opens a read-only voucher (the new default when
  // clicking View from the list); "edit" restores the pre-7B fully
  // editable form. Only meaningful while mode === "form".
  const [formMode, setFormMode] = useState("view");
  const [transactions, setTransactions] = useState([]);
  const [selectedTransaction, setSelectedTransaction] = useState(null);
  const [showPrintOptionsModal, setShowPrintOptionsModal] = useState(false);
  const [showRecurringModal, setShowRecurringModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

  // Phase 7C: Unified Journal Entry Tax Workflow. `editingTaxLineId` is
  // null when the popup is adding a brand-new tax entry, or the client
  // line.id being re-edited via "Edit Tax Details" (spec section 20).
  const [showVatEntryModal, setShowVatEntryModal] = useState(false);
  const [vatEntryDirection, setVatEntryDirection] = useState("INPUT");
  const [showEwtEntryModal, setShowEwtEntryModal] = useState(false);
  const [editingTaxLineId, setEditingTaxLineId] = useState(null);
  const [showTaxDetailsView, setShowTaxDetailsView] = useState(false);
  const [viewingTaxEntry, setViewingTaxEntry] = useState(null);

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

  // Phase 7E section 6: Phase 7D's audit conclusively found that OR/CV tax
  // entry can double-recognize tax when the voucher is settling an existing
  // source document (Invoice for OR, APV for CV) - the source document
  // already carries its own VAT/EWT. When it isn't settling anything (a
  // legitimate direct/invoice-less OR or CV), the legacy tax card below is
  // still the correct, unchanged way to record tax - see Phase 7D's "OR/CV
  // dual nature" finding. This flag never changes accounting policy; it
  // only warns and blocks NEW entry through the legacy fields.
  const hasSourceApplications =
    (code === "OR" && invoiceApplications.length > 0) ||
    (code === "CV" && apvApplications.length > 0);
  const sourceDuplicationWarning =
    code === "OR"
      ? "Tax is recognized on the source Invoice. Additional Output VAT on this settlement may duplicate tax."
      : code === "CV"
      ? "Tax is recognized on the source APV. Additional Input VAT/EWT may duplicate tax."
      : "";

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

  // Phase 7C: "+ Add Entry" workflow (INV/APV only - see spec sections
  // 28-30 and the AddEntryMenu wiring below). Confirming a popup builds
  // one journal line carrying `taxEntry` metadata; editing re-opens the
  // same popup pre-filled from that line's existing taxEntry. The tax
  // entry lives ON the line object itself (not a separate parallel
  // structure) - removing the line via the existing removeLine() already
  // removes its metadata for free (spec section 21), and the save payload
  // already includes it automatically wherever `lines` is serialized.
  function openAddVatEntry(direction) {
    setVatEntryDirection(direction);
    setEditingTaxLineId(null);
    setShowVatEntryModal(true);
  }

  function openEditVatEntry(line) {
    setVatEntryDirection(line.taxEntry.entryType === "OUTPUT_VAT" ? "OUTPUT" : "INPUT");
    setEditingTaxLineId(line.id);
    setShowVatEntryModal(true);
  }

  function handleVatEntryConfirm(entry) {
    const isOutput = vatEntryDirection === "OUTPUT";
    const selectedPartyForRef = partyOptions.find((p) => p.id === entry.partyId);

    const lineData = {
      accountId: entry.accountId,
      particulars: `${isOutput ? "Output VAT" : "Input VAT"} (${entry.vatRate}%)`,
      genRef: selectedPartyForRef?.code || "",
      genName: entry.partyName || "",
      debit: isOutput ? "" : String(entry.vatAmount),
      credit: isOutput ? String(entry.vatAmount) : "",
      taxEntry: { entryType: isOutput ? "OUTPUT_VAT" : "INPUT_VAT", ...entry },
    };

    if (editingTaxLineId) {
      setLines((prev) => prev.map((l) => (l.id === editingTaxLineId ? { ...l, ...lineData } : l)));
    } else {
      setLines((prev) => [...prev, { ...createLine(), ...lineData }]);
    }

    setShowVatEntryModal(false);
    setEditingTaxLineId(null);
  }

  function openAddEwtEntry() {
    setEditingTaxLineId(null);
    setShowEwtEntryModal(true);
  }

  function openEditEwtEntry(line) {
    setEditingTaxLineId(line.id);
    setShowEwtEntryModal(true);
  }

  function handleEwtEntryConfirm(entry) {
    const lineData = {
      accountId: entry.accountId,
      particulars: `EWT - ${entry.atcCode}`,
      genRef: entry.partyId ? (partyOptions.find((p) => p.id === entry.partyId)?.code || "") : "",
      genName: entry.partyName || "",
      // Inbound (INV): a Creditable WHT Receivable asset increases -> debit.
      // Outbound (APV): a Withholding Tax Payable liability increases -> credit.
      debit: ewtInbound ? String(entry.withheldAmount) : "",
      credit: ewtOutbound ? String(entry.withheldAmount) : "",
      taxEntry: { entryType: "EWT", ...entry },
    };

    if (editingTaxLineId) {
      setLines((prev) => prev.map((l) => (l.id === editingTaxLineId ? { ...l, ...lineData } : l)));
    } else {
      setLines((prev) => [...prev, { ...createLine(), ...lineData }]);
    }

    // Section 33/34 backward compatibility: keep the EXISTING header-level
    // EWT columns (read by resolveTaxWithholding and every existing EWT
    // report) in sync with the new journal line, rather than replacing
    // that mechanism.
    setAtcCode(entry.atcCode);
    setTaxWithheldAmount(String(entry.withheldAmount));
    setTaxWithheldTouched(true);
    if (ewtOutbound) setPayeeTin(entry.partyTin || "");

    setShowEwtEntryModal(false);
    setEditingTaxLineId(null);
  }

  // Routes the grid's single "Edit Tax Details" trigger to the correct
  // popup based on the line's own stable entry_type metadata (never a
  // title/particulars string match - spec section 36).
  function openEditVatEntryOrEwt(line) {
    if (!line.taxEntry) return;
    if (line.taxEntry.entryType === "EWT") {
      openEditEwtEntry(line);
    } else {
      openEditVatEntry(line);
    }
  }

  function openViewTaxDetails(line) {
    setViewingTaxEntry(line.taxEntry);
    setShowTaxDetailsView(true);
  }

  // Removing an EWT-generated line must also clear the header-level EWT
  // fields it was kept in sync with above - otherwise a stale atcCode
  // would still flow through resolveTaxWithholding on save with no
  // matching journal line to justify it (spec section 21's "no orphaned
  // tax schedule" requirement, applied to the legacy header mirror too).
  function handleRemoveTaxAwareLine(id) {
    const line = lines.find((l) => l.id === id);
    if (line?.taxEntry?.entryType === "EWT") {
      setAtcCode("");
      setTaxWithheldAmount("");
      setTaxWithheldTouched(false);
      if (ewtOutbound) setPayeeTin("");
    }
    removeLine(id);
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
    // Phase 7B: a brand-new, never-saved transaction has nothing to "view" -
    // it opens directly in edit mode, same as before 7B.
    setFormMode("edit");
    setMode("form");
  }

  function handleBackToList() {
    setMode("list");
    setError("");
  }

  // Phase 7B: switches the already-loaded transaction into edit mode
  // without re-fetching - the data is already in `form`/`lines` from the
  // handleView() call that opened this voucher (spec section 4: "Do not
  // re-fetch unless actually necessary").
  function handleEditClick() {
    setFormMode("edit");
  }

  // Phase 7E (spec section 14): the list's Search/Status controls now
  // actually filter - this is the same filtered list the table renders,
  // so Previous/Next (below) can share it and stay in sync with whatever
  // subset the user is currently looking at (spec sections 16/30-G).
  const filteredTransactions = useMemo(
    () => filterTransactions(transactions, { searchQuery, statusFilter }),
    [transactions, searchQuery, statusFilter]
  );
  const statusFilterOptions = useMemo(() => deriveStatusOptions(transactions), [transactions]);

  // Phase 7B Previous/Next (spec sections 15-16): navigates within the
  // already-loaded, module-scoped `transactions` array only - Invoice can
  // never step into APV, since each module fetches from its own endpoint.
  // Always lands back in view mode, same reasoning as targetFormMode's
  // default on handleView. Phase 7E: switched to the filtered list so
  // Previous/Next follows whatever Search/Status subset is active (spec
  // sections 16/30-G) - a transaction filtered out of view is no longer a
  // valid Previous/Next target.
  const currentTransactionIndex = selectedTransaction?.id
    ? filteredTransactions.findIndex((t) => String(t.id) === String(selectedTransaction.id))
    : -1;
  const hasPreviousTransaction = currentTransactionIndex > 0;
  const hasNextTransaction =
    currentTransactionIndex >= 0 && currentTransactionIndex < filteredTransactions.length - 1;

  function handlePreviousTransaction() {
    if (!hasPreviousTransaction) return;
    handleView(filteredTransactions[currentTransactionIndex - 1]);
  }

  function handleNextTransaction() {
    if (!hasNextTransaction) return;
    handleView(filteredTransactions[currentTransactionIndex + 1]);
  }

  // Phase 7B status/permission gating (spec sections 7-10): PO's Open/
  // Closed/Draft lifecycle has no backend status restriction on Edit/
  // Delete at all (confirmed in Phase 7A.1 - see transactionModuleConfig.js),
  // so it's gated on permission + existing-record only; every other module
  // follows the real Draft/Posted rule the Phase 7A.1 backend guard
  // enforces, hiding Edit/Delete once a record is Posted so the frontend
  // stops offering an action the backend will now reject with 409.
  const toolbarVisibility = getVoucherToolbarVisibility({ moduleConfig, status: form.status, can });

  // Phase 7B: the old CSV-export/browser-print fallback (only reachable
  // when a module had no printModuleType, or for a brand-new unsaved
  // transaction) was removed along with the old top-actions/bottom-bar
  // buttons that triggered it - see the Phase 7B report's "known
  // limitations" item. Every module now has a real printModuleType, and
  // the toolbar's Print button (which opens TransactionPrintOptionsModal)
  // only makes sense for an already-saved record with a real id to fetch.

  // Phase 7B: targetFormMode lets every caller that needs a fresh fetch +
  // populate (the list's View button, Previous/Next, and the post-save
  // reload) share this one function instead of duplicating it - see the
  // Phase 7B report's "read-only voucher implementation" item. Defaults to
  // "view" (the new default landing mode); Previous/Next also always pass
  // "view" explicitly, since navigating away from an in-progress edit is
  // expected to discard it, same as Back to List already does.
  async function handleView(transaction, targetFormMode = "view") {
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
          data.lines.map((line) => {
            // Phase 7C: correlates by the line's REAL database id (still
            // present on `line.id` at this exact point) - the very next
            // field below regenerates a fresh client UUID for React/
            // updateLine's own identity, which is NOT stable across
            // save/reload cycles (see taxEntryService.js's header comment
            // for why the tax-entries table links by DB line id instead).
            const matchingTaxEntry = (data.taxEntries || []).find((te) => te.lineId === line.id);

            return {
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
              ...(matchingTaxEntry ? { taxEntry: matchingTaxEntry } : {}),
            };
          })
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
        setFormMode(targetFormMode);
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
    setFormMode(targetFormMode);
    setMode("form");
  }

  // Phase 7B Delete (spec sections 11-13): a compact confirm dialog first
  // (never delete on click), then the real DELETE call. Errors - most
  // notably the Phase 7A.1 backend guard's 409 TRANSACTION_ALREADY_POSTED,
  // or AccountingPeriodService's period-closed rejection - surface the
  // server's own human-readable `message` (never raw JSON/SQL, matching
  // this file's existing alert(data.message) convention everywhere else),
  // and reload the record so a stale local view can't keep offering an
  // action the backend just refused.
  function handleDeleteClick() {
    setShowDeleteConfirm(true);
  }

  function cancelDeleteConfirm() {
    setShowDeleteConfirm(false);
  }

  async function confirmDelete() {
    if (!selectedTransaction?.id || moduleConfigError) return;

    setDeleting(true);
    try {
      const endpoint = moduleConfig.endpoint;
      const res = await fetch(`${API_BASE}/api/${endpoint}/${selectedTransaction.id}`, {
        method: "DELETE",
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to delete transaction.");
        setShowDeleteConfirm(false);
        // Section 33: revert/refresh state after a failed action (e.g. it
        // was posted by someone else a moment ago) instead of leaving the
        // voucher showing stale Edit/Delete buttons.
        await handleView(selectedTransaction);
        return;
      }

      setShowDeleteConfirm(false);
      alert(`${title} deleted successfully.`);
      await loadTransactions();
      setMode("list");
    } catch (err) {
      console.error("DELETE TRANSACTION ERROR:", err);
      alert("Unable to connect to server.");
      setShowDeleteConfirm(false);
    } finally {
      setDeleting(false);
    }
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
            // Phase 7C: carries this line's tax schedule metadata (if any)
            // through to the backend, which independently re-validates a
            // VAT-type entry against the centralized helper before saving -
            // see taxEntryService.js.
            ...(line.taxEntry ? { taxEntry: line.taxEntry } : {}),
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
        // Phase 7B (spec section 33): if someone else posted this record
        // in the meantime, the Phase 7A.1 backend guard now rejects this
        // save with 409 TRANSACTION_ALREADY_POSTED - continuing to edit a
        // form that can never save is pointless, so reload the record and
        // drop back to its (now Posted) read-only view. Any other error
        // (validation, network, generic 500) leaves the user's in-progress
        // edits alone so nothing typed is lost on a possibly-transient
        // failure.
        if (data.code === "TRANSACTION_ALREADY_POSTED" && isExisting) {
          await handleView({ id: selectedTransaction.id });
        }
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

      // Phase 7B (spec section 19, Playwright test A/B): saving an EXISTING
      // voucher returns to its read-only view instead of the list - the
      // voucher is now the workspace, matching "View -> Edit -> Save Draft
      // -> View again". A brand-new transaction has no prior "view" to
      // return to, so it keeps the original list-return behavior.
      if (isExisting) {
        await handleView({ id: selectedTransaction.id });
      } else {
        setMode("list");
      }
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
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  aria-label="Search transactions"
                />

                <select
                  className="transaction-input"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  aria-label="Filter by status"
                >
                  {statusFilterOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
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
                    ) : filteredTransactions.length === 0 ? (
                      <tr>
                        <td colSpan="6" className="transaction-empty">
                          No transactions found.
                        </td>
                      </tr>
                    ) : (
                      filteredTransactions.map((transaction) => (
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
                              View
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
                  {formMode === "edit"
                    ? selectedTransaction
                      ? `Edit ${code}`
                      : `Add New ${code}`
                    : `View ${code}`}
                </h1>
                <p className="transaction-subtitle">{title}</p>
              </div>

              <div className="transaction-form-top-actions no-print">
                <div className="transaction-status-pill">{form.status}</div>

                {code === "APV" && formMode === "edit" && (
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
              </div>
            </div>

            {/* Phase 7B: the single in-voucher action surface - replaces
                the old top-actions Print/Make Recurring/Back-to-List
                buttons AND the old bottom action bar (see the Phase 7B
                report's "bottom-bar removal/replacement" item). */}
            <VoucherToolbar
              formMode={formMode}
              isNew={!selectedTransaction?.id}
              saving={saving}
              deleting={deleting}
              code={code}
              showEdit={toolbarVisibility.showEdit}
              showDelete={toolbarVisibility.showDelete}
              showPrint={!!printModuleType && toolbarVisibility.showPrint}
              showRecurring={!!recurringModuleType}
              showPrevious
              showNext
              hasPrevious={hasPreviousTransaction}
              hasNext={hasNextTransaction}
              showPost
              onEdit={handleEditClick}
              onDelete={handleDeleteClick}
              onPrint={() => setShowPrintOptionsModal(true)}
              onRecurring={() => setShowRecurringModal(true)}
              onPrevious={handlePreviousTransaction}
              onNext={handleNextTransaction}
              onBackToList={handleBackToList}
              onSaveDraft={() => handleSave("Draft")}
              onPost={handlePostTransactionClick}
            />

            {/* Phase 7E section 7: view mode reads like a real accounting
                document with clearly labeled sections (Voucher Information /
                Accounting Entries / Totals) rather than an unlabeled block
                of fields - edit mode skips this title since the page's own
                "Edit {code}" heading already establishes context. */}
            {formMode === "view" && (
              <h2 className="transaction-view-section-title">Voucher Information</h2>
            )}

            <TransactionVoucherHeader
              viewOnly={formMode === "view"}
              code={code}
              title={title}
              partyLabel={partyLabel}
              partyType={partyType}
              showCheckNo={showCheckNo}
              form={form}
              updateForm={updateForm}
              handlePartyChange={handlePartyChange}
              partyOptions={partyOptions}
              showPartyModal={showPartyModal}
              setShowPartyModal={setShowPartyModal}
              handlePartyCreated={handlePartyCreated}
            />

            {CURRENCY_ELIGIBLE && (
              <CurrencySummary
                currencySnapshot={currencySnapshot}
                selectedCurrencyId={selectedCurrencyId}
                handleCurrencyChange={handleCurrencyChange}
                currencyOptions={currencyOptions}
                baseCurrency={baseCurrency}
                rateError={rateError}
                rateResolving={rateResolving}
                pendingRateAction={pendingRateAction}
                handleRefreshRateClick={handleRefreshRateClick}
                canCurrency={can}
                currencyModuleKey={CURRENCY_MODULE_KEY}
                showOverrideForm={showOverrideForm}
                setShowOverrideForm={setShowOverrideForm}
                refreshPreview={refreshPreview}
                setRefreshPreview={setRefreshPreview}
                confirmRefresh={confirmRefresh}
                overrideRateValue={overrideRateValue}
                setOverrideRateValue={setOverrideRateValue}
                overrideReason={overrideReason}
                setOverrideReason={setOverrideReason}
                submitOverride={submitOverride}
                viewOnly={formMode === "view"}
                totals={totals}
              />
            )}

            {code === "INV" && (
              <div className="transaction-card">
                <div className="transaction-section-header">
                  <div>
                    <h2 className="transaction-section-title">Invoice Type</h2>
                    {formMode === "edit" && (
                      <p className="transaction-section-subtext">
                        Recurring invoices are for billing the same customer on a repeating schedule.
                      </p>
                    )}
                  </div>
                </div>

                {formMode === "view" ? (
                  <div className="transaction-view-grid">
                    <ViewField label="Type" value={invoiceType} />
                    {invoiceType === "Recurring" && (
                      <ViewField label="Recurrence" value={recurrenceFrequency} />
                    )}
                  </div>
                ) : (
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
                )}
              </div>
            )}

            {(code === "OR" || code === "CV") && (
              <div className="transaction-card">
                <div className="transaction-section-header">
                  <div>
                    <h2 className="transaction-section-title">Cash / Check Details</h2>
                    {formMode === "edit" && (
                      <p className="transaction-section-subtext">
                        Captures the bank account and check reference this {code === "OR" ? "receipt" : "payment"}{" "}
                        moved through, for bank reconciliation.
                      </p>
                    )}
                  </div>
                </div>

                {formMode === "view" ? (
                  <div className="transaction-view-grid">
                    <ViewField label="Payment Method" value={paymentMethod} />
                    <ViewField
                      label="Bank Account"
                      value={
                        bankAccounts.find((b) => String(b.id) === String(bankAccountId))
                          ? `${bankAccounts.find((b) => String(b.id) === String(bankAccountId)).bankCode} - ${bankAccounts.find((b) => String(b.id) === String(bankAccountId)).bankName}`
                          : null
                      }
                    />
                    {paymentMethod === "Check" && (
                      <>
                        <ViewField label="Check No." value={checkNumber} />
                        <ViewField label="Check Date" value={checkDate} />
                      </>
                    )}
                  </div>
                ) : (
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
                )}
              </div>
            )}

            {/* Phase 7C (spec section 3/25): the permanent EWT card is
                retired for Invoice/APV - EWT is now entered via "+ Add
                Entry" and lives as a journal line + View/Edit Tax Details.
                OR/CV/PO keep this exact card, completely untouched, since
                Phase 7C only restructures Invoice/APV (spec section 30). */}
            {ewtEligible && !["INV", "APV"].includes(code) && (
              <div className="transaction-card">
                <div className="transaction-section-header">
                  <div>
                    <h2 className="transaction-section-title">
                      {ewtOutbound ? "Withholding Tax" : "Tax Withheld by Customer"}
                    </h2>
                    {formMode === "edit" && (
                      <p className="transaction-section-subtext">
                        {ewtOutbound
                          ? "Optional — only fill in if tax was withheld from this payment."
                          : "Optional — only fill in if the customer withheld tax from this amount (per the Form 2307 they issue you)."}
                        {" "}For VATable transactions, EWT is computed on the amount exclusive of VAT.
                      </p>
                    )}
                  </div>
                </div>

                {hasSourceApplications && (
                  <p className="transaction-tax-duplication-warning" role="alert">
                    ⚠ {sourceDuplicationWarning}
                  </p>
                )}

                {formMode === "view" ? (
                  atcCode ? (
                    <div className="transaction-view-grid">
                      <ViewField label="ATC Code" value={atcCode} />
                      <ViewField
                        label="Tax Type"
                        value={selectedEwt ? (selectedEwt.taxType === "FINAL" ? "Final Tax" : "Expanded Withholding Tax") : null}
                      />
                      <ViewField label="EWT Base (VAT-exclusive)" value={formatMoney(ewtTaxableBase)} />
                      <ViewField label="Tax Withheld Amount" value={formatMoney(taxWithheldAmount)} />
                      {ewtOutbound && <ViewField label="Payee TIN" value={payeeTin} />}
                    </div>
                  ) : (
                    <p className="transaction-section-subtext">No withholding tax recorded on this transaction.</p>
                  )
                ) : (
                <div className="transaction-grid">
                  <div className="transaction-field">
                    <label className="transaction-label">ATC Code</label>
                    <select
                      value={atcCode}
                      onChange={(e) => handleAtcCodeChange(e.target.value)}
                      className="transaction-input"
                      disabled={hasSourceApplications}
                      title={hasSourceApplications ? sourceDuplicationWarning : undefined}
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
                      disabled={!atcCode || hasSourceApplications}
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
                )}
              </div>
            )}

            {/* Phase 7C: same retirement as the EWT card above, for the
                same two modules only - see spec section 3/6/13/28/29. */}
            {formMode === "edit" && vatType && !["INV", "APV"].includes(code) && (
              <div className="transaction-card">
                <div className="transaction-section-header">
                  <div>
                    <h2 className="transaction-section-title">{vatType}</h2>
                    <p className="transaction-section-subtext">
                      Optional &mdash; enter the taxable amount to add a {vatType} line automatically.
                    </p>
                  </div>
                </div>

                {hasSourceApplications && (
                  <p className="transaction-tax-duplication-warning" role="alert">
                    ⚠ {sourceDuplicationWarning}
                  </p>
                )}

                <div className="transaction-grid">
                  <div className="transaction-field">
                    <label className="transaction-label">{vatType} Account</label>
                    <select
                      value={vatAccountId}
                      onChange={(e) => setVatAccountId(e.target.value)}
                      className="transaction-input"
                      disabled={hasSourceApplications}
                      title={hasSourceApplications ? sourceDuplicationWarning : undefined}
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
                      disabled={hasSourceApplications}
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
                  <h2 className="transaction-section-title">
                    {formMode === "view" ? "Accounting Entries" : "Journal Entries"}
                  </h2>
                  {formMode === "edit" && (
                    <p className="transaction-section-subtext">
                      Minimum of one debit and one credit
                    </p>
                  )}
                </div>

                {formMode === "edit" && (
                  <div className="transaction-section-actions">
                    {code === "INV" || code === "APV" ? (
                      <AddEntryMenu
                        onRegular={addLine}
                        taxOptions={[
                          ...(code === "INV" ? [{ key: "output_vat", label: "Output VAT", onClick: () => openAddVatEntry("OUTPUT") }] : []),
                          ...(code === "APV" ? [{ key: "input_vat", label: "Input VAT", onClick: () => openAddVatEntry("INPUT") }] : []),
                          { key: "ewt", label: "EWT / Withholding Tax", onClick: openAddEwtEntry },
                        ]}
                      />
                    ) : (
                      <button onClick={addLine} className="transaction-add-button">
                        + Add Line
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="transaction-table-container">
                <table className="transaction-table">
                  <AccountingEntriesGrid
                    lines={lines}
                    accountOptions={accountOptions}
                    partyOptions={partyOptions}
                    updateLine={updateLine}
                    removeLine={handleRemoveTaxAwareLine}
                    isAPorARAccount={isAPorARAccount}
                    onEditTaxDetails={openEditVatEntryOrEwt}
                    onViewTaxDetails={openViewTaxDetails}
                    viewOnly={formMode === "view"}
                  />
                  <EntryTotals totals={totals} viewOnly={formMode === "view"} />
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
                      aria-label="Close"
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
                      aria-label="Close"
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
                      aria-label="Close"
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


            {/* Phase 7B Delete confirmation (spec section 11) - reuses the
                existing apv-modal-* dialog pattern already established for
                the APV/Invoice/PO application modals above, sized down via
                .confirm-dialog. Never deletes on click. */}
            {showDeleteConfirm && (
              <div className="apv-modal-overlay">
                <div className="apv-modal confirm-dialog">
                  <div className="apv-modal-header">
                    <div>
                      <h2>Delete this Draft {title}?</h2>
                      <p>This action cannot be undone.</p>
                    </div>
                    <button
                      type="button"
                      className="apv-modal-close"
                      onClick={cancelDeleteConfirm}
                      aria-label="Close"
                    >
                      ×
                    </button>
                  </div>
                  <div className="apv-modal-footer">
                    <button
                      type="button"
                      className="transaction-secondary-button"
                      onClick={cancelDeleteConfirm}
                      disabled={deleting}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="transaction-danger-button"
                      onClick={confirmDelete}
                      disabled={deleting}
                    >
                      {deleting ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </div>
              </div>
            )}
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

        {(code === "INV" || code === "APV") && (
          <>
            <VatEntryModal
              open={showVatEntryModal}
              onClose={() => { setShowVatEntryModal(false); setEditingTaxLineId(null); }}
              direction={vatEntryDirection}
              partyLabel={partyLabel}
              partyOptions={partyOptions}
              accountOptions={accountOptions}
              defaultDate={form.date}
              existingEntry={editingTaxLineId ? lines.find((l) => l.id === editingTaxLineId)?.taxEntry : null}
              onConfirm={handleVatEntryConfirm}
            />

            <EwtEntryModal
              open={showEwtEntryModal}
              onClose={() => { setShowEwtEntryModal(false); setEditingTaxLineId(null); }}
              ewtCodes={ewtCodes}
              direction={ewtOutbound ? "OUTBOUND" : "INBOUND"}
              partyLabel={partyLabel}
              defaultParty={{
                name: form.party,
                id: form.partyId,
                tin: partyOptions.find((p) => p.id === form.partyId)?.tin || "",
                address: [
                  partyOptions.find((p) => p.id === form.partyId)?.address1,
                  partyOptions.find((p) => p.id === form.partyId)?.address2,
                  partyOptions.find((p) => p.id === form.partyId)?.address3,
                ].filter(Boolean).join(", "),
              }}
              accountOptions={accountOptions}
              lines={lines}
              grossAmount={totals.totalCredit}
              vatAccountId={lines.find((l) => l.taxEntry?.entryType === "OUTPUT_VAT" || l.taxEntry?.entryType === "INPUT_VAT")?.accountId}
              defaultDate={form.date}
              existingEntry={editingTaxLineId ? lines.find((l) => l.id === editingTaxLineId)?.taxEntry : null}
              onConfirm={handleEwtEntryConfirm}
            />

            <TaxDetailsViewModal
              open={showTaxDetailsView}
              onClose={() => { setShowTaxDetailsView(false); setViewingTaxEntry(null); }}
              entry={viewingTaxEntry}
            />
          </>
        )}
      </div>
    </div>
  );
}

