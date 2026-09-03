import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import TransactionPrintOptionsModal from "../../components/TransactionPrintOptionsModal";
import RecurringTemplateModal from "../../components/RecurringTemplateModal";
import { computeEwtTaxableBase, computeEwtAmount } from "../../utils/ewtCalculations.mjs";
import usePermissions from "../../hooks/usePermissions";
import { getTransactionModuleConfig } from "./transactionModuleConfig";
import { getVoucherToolbarVisibility } from "./voucherToolbarRules.mjs";
import { formatMoney } from "./transactionFormUtils";
import TransactionVoucherHeader from "./TransactionVoucherHeader";
import TransactionSummaryPanel from "./TransactionSummaryPanel";
import CurrencySummary from "./CurrencySummary";
import AccountingEntriesGrid from "./AccountingEntriesGrid";
import EntryTotals from "./EntryTotals";
import ViewField from "./ViewField";
import VoucherToolbar from "./VoucherToolbar";
import AddEntryMenu from "./AddEntryMenu";
import VatEntryModal from "./VatEntryModal";
import EwtEntryModal from "./EwtEntryModal";
import TaxDetailsViewModal from "./TaxDetailsViewModal";
import LegacyVatEntryModal from "./LegacyVatEntryModal";
import LegacyEwtEntryModal from "./LegacyEwtEntryModal";
import CashCheckDetailsModal from "./CashCheckDetailsModal";
import { filterTransactions, deriveStatusOptions, sortTransactions } from "./transactionListFilters.mjs";
import {
  inputVatAccounts,
  outputVatAccounts,
  ewtControlAccounts,
  defaultTaxAccountId,
  missingTaxAccountMessage,
} from "./taxAccountRules.mjs";
import { applyApvTaxBalancing } from "./apvJournalBalance.mjs";
import { hasSettlementSourceApplications, settlementTaxWarning } from "./legacyTaxEntryPolicy.mjs";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import "./TransactionFormLayout.css";

const CURRENCY_MODULE_KEY = "FILESETUP.CURRENCY_SETUP";

// Phase 7G: explicit whitelist, not "every currency-eligible module" -
// PCV/DM/CM are currency-eligible too (transactionModuleConfig.js) but were
// never named in this checkpoint's scope, so they deliberately keep the
// original stacked layout (TransactionVoucherHeader + a separate
// CurrencySummary card) untouched. A Set, not an array, purely so the
// several `.has(code)` checks below read as a plain membership test.
const COMPACT_HEADER_MODULES = new Set(["INV", "OR", "APV", "CV", "PO", "JV"]);

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem("user") || "null");
  } catch {
    return null;
  }
}

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
  // Phase 5: filters this module's own document date (Invoice: "Invoice
  // Date", OR: "Receipt Date", etc.) - each already normalized to `date` on
  // every transaction row by loadTransactions() below. Independent of
  // search/status - "Clear" here only ever resets these two, never the
  // other filters (see the toolbar JSX).
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
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
  // Phase 7K: APV/CV Cancel (Draft) / Void (Posted) reason modal.
  const [cancelVoidAction, setCancelVoidAction] = useState(null); // "cancel" | "void" | null
  const [cancelVoidReason, setCancelVoidReason] = useState("");

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
  // Phase 6D: reference-only VAT catalog, loaded once for INV/APV only
  // (mirrors ewtCodes above exactly) and passed down to VatEntryModal.
  // LegacyVatEntryModal (OR/CV/PO) never receives this - those three
  // modules gain no new API dependency, per the explicit non-scope.
  const [vatRateCodes, setVatRateCodes] = useState([]);
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
  // Phase 7L Part E: shown when a VAT/EWT line was added to a modern APV
  // but the payable line could not be identified for auto-balancing.
  const [balanceAssistMessage, setBalanceAssistMessage] = useState("");

  // Transaction-entry UI standardization: OR/CV/PO's VAT/EWT/Cash-Check
  // fields are NOT moving to the Invoice/APV tagged-line workflow (that
  // would risk double-recognizing tax on a settlement document, exactly
  // what Phase 7D's audit and Phase 7E's warning were built to prevent).
  // Only the container changes - these three modals wrap the EXACT same
  // state/handlers (vatAccountId/vatTaxableAmount/vatRate, atcCode/
  // taxWithheldAmount/payeeTin, paymentMethod/bankAccountId/checkNumber/
  // checkDate) that already existed as always-visible cards, now reached
  // through the same "+ Add Entry" menu Invoice/APV use instead of always
  // taking up page space.
  const [showLegacyVatModal, setShowLegacyVatModal] = useState(false);
  const [showLegacyEwtModal, setShowLegacyEwtModal] = useState(false);
  const [showCashCheckModal, setShowCashCheckModal] = useState(false);

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

  // Phase 7A: Invoice-only Due Date. `dueDateTouched` tracks whether the
  // user has manually edited Due Date on the CURRENT brand-new, unsaved
  // Invoice - while untouched, changing the Invoice Date also carries Due
  // Date along with it (a convenient default, not a hard link); once the
  // user edits Due Date directly, or once an existing saved Invoice is
  // loaded (its due_date is already intentional, real accounting data),
  // Invoice Date changes never overwrite it again. Only ever read/written
  // for code === "INV" - every other module ignores this state entirely
  // and keeps sending dueDate === transactionDate exactly as before.
  const [dueDate, setDueDate] = useState(new Date().toISOString().split("T")[0]);
  const [dueDateTouched, setDueDateTouched] = useState(false);

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

    // Phase 6D: Invoice/APV only - see the explicit OR/CV/PO non-scope
    // (LegacyVatEntryModal.jsx is untouched and gains no new API call).
    if (["INV", "APV"].includes(code)) {
      loadVatRateCodes();
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

  // Seed the default VAT control account from the COA "Validation Rules"
  // (INPUT VAT / OUTPUT VAT assignment in coa_validations, exposed on every
  // /api/coa row as `account.validations`) - never from the account title.
  // Auto-selects only when exactly one validated account exists; otherwise
  // the tax modal forces an explicit pick / shows the missing-config
  // message (see missingTaxAccountMessage wiring below).
  useEffect(() => {
    const wantsOutputVat = code === "INV" || code === "OR";
    const wantsInputVat = code === "APV" || code === "CV" || code === "PO";
    if (vatAccountId || accountOptions.length === 0 || (!wantsOutputVat && !wantsInputVat)) return;
    const matches = wantsOutputVat
      ? outputVatAccounts(accountOptions)
      : inputVatAccounts(accountOptions);
    const def = defaultTaxAccountId(matches);
    if (def) setVatAccountId(def);
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

  // Phase 6D: same shape/fallback as loadEwtCodes() above - any failure
  // (network error, non-200, empty catalog) leaves vatRateCodes as [],
  // which VatEntryModal treats as "no picker, fall back to manual entry"
  // (section 15's deployment-safety rule) rather than blocking anything.
  async function loadVatRateCodes() {
    try {
      const res = await fetch(`${API_BASE}/api/vat-rate-codes?activeOnly=true`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        handleAuthError(res.status);
        setVatRateCodes([]);
        return;
      }

      setVatRateCodes(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("LOAD VAT RATE LIBRARY ERROR:", err);
      setVatRateCodes([]);
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
  // whatever was posted to the VAT account. See utils/ewtCalculations.mjs.
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
    // Phase 7L Part F: block legacy EWT on a settlement voucher (CV paying
    // an APV / OR paying an Invoice) - the source document already carries
    // the withholding.
    if (hasSourceApplications) return;
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

  // Tax-modal account lists, sourced from the COA "Validation Rules"
  // (coa_validations -> /api/coa `account.validations`), never from account
  // title/code text. The Regular Journal Entry dropdown filters these same
  // accounts OUT (see AccountingEntriesGrid); the tax modals filter them
  // IN. An empty list is a valid state - the modal then shows the
  // missing-configuration message instead of falling back to any heuristic.
  const vatModalAccounts = useMemo(() => {
    if (vatType === "Output VAT") return outputVatAccounts(accountOptions);
    if (vatType === "Input VAT") return inputVatAccounts(accountOptions);
    return [];
  }, [accountOptions, vatType]);
  const ewtModalAccounts = useMemo(
    () => ewtControlAccounts(accountOptions),
    [accountOptions]
  );
  const vatMissingMessage = missingTaxAccountMessage(
    vatType === "Output VAT" ? "OUTPUT_VAT" : "INPUT_VAT"
  );
  const ewtMissingMessage = missingTaxAccountMessage("EWT");

  // Phase 7E section 6: Phase 7D's audit conclusively found that OR/CV tax
  // entry can double-recognize tax when the voucher is settling an existing
  // source document (Invoice for OR, APV for CV) - the source document
  // already carries its own VAT/EWT. When it isn't settling anything (a
  // legitimate direct/invoice-less OR or CV), the legacy tax card below is
  // still the correct, unchanged way to record tax - see Phase 7D's "OR/CV
  // dual nature" finding. This flag never changes accounting policy; it
  // only warns and blocks NEW entry through the legacy fields.
  // Phase 7L Part F: settlement vouchers (OR->Invoice, CV->APV) never
  // record their own VAT/EWT - see legacyTaxEntryPolicy.mjs.
  const hasSourceApplications = hasSettlementSourceApplications({
    code,
    invoiceApplications,
    apvApplications,
  });
  const sourceDuplicationWarning = settlementTaxWarning(code);

  const vatAmount =
    (Number(vatTaxableAmount || 0) * Number(vatRate || 0)) / 100;

  function handleAddVatLine() {
    // Phase 7L Part F: a settlement voucher (OR paying an Invoice, CV
    // paying an APV) must never record a second VAT line - tax is already
    // recognized on the source document. The legacy modal disables its
    // fields + Add button when hasSourceApplications; this is the matching
    // backstop for any other call path.
    if (hasSourceApplications) return;
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

  // Phase 7L Part E: commit a new/edited/removed tax-aware line set and,
  // for a modern APV, deterministically rebalance the payable CREDIT so
  // total debit === total credit - but ONLY when the AP/control line is
  // unambiguous. Otherwise the lines are committed unchanged and a
  // validation message is shown (never a silent change to an arbitrary
  // line). Non-APV modules commit verbatim, exactly as before.
  function commitTaxAwareLines(nextLines) {
    if (code !== "APV") {
      setLines(nextLines);
      setBalanceAssistMessage("");
      return;
    }
    const result = applyApvTaxBalancing(nextLines, { isAPorARAccount, enabled: true });
    setBalanceAssistMessage(result.status === "AMBIGUOUS" ? result.message : "");
    setLines(result.lines);
  }

  function handleVatEntryConfirm(entry) {
    const isOutput = vatEntryDirection === "OUTPUT";
    const selectedPartyForRef = partyOptions.find((p) => p.id === entry.partyId);

    // Phase 7E: a ZERO_RATED / EXEMPT entry has VAT 0 - its journal line
    // documents the classification (and carries the base in taxEntry), it
    // is never a "fake 0% standard VAT" line.
    const treatment = String(entry.vatTreatment || "STANDARD").toUpperCase();
    const isZeroTreatment = treatment === "ZERO_RATED" || treatment === "EXEMPT";
    const kindLabel = isOutput ? "Output VAT" : "Input VAT";
    const particulars = isZeroTreatment
      ? `${treatment === "ZERO_RATED" ? "Zero-Rated" : "VAT-Exempt"} ${isOutput ? "Sales" : "Purchase"}`
      : `${kindLabel} (${entry.vatRate}%)`;

    const lineData = {
      accountId: entry.accountId,
      particulars,
      genRef: selectedPartyForRef?.code || "",
      genName: entry.partyName || "",
      debit: isOutput ? "" : String(entry.vatAmount),
      credit: isOutput ? String(entry.vatAmount) : "",
      taxEntry: { entryType: isOutput ? "OUTPUT_VAT" : "INPUT_VAT", ...entry },
    };

    const nextLines = editingTaxLineId
      ? lines.map((l) => (l.id === editingTaxLineId ? { ...l, ...lineData } : l))
      : [...lines, { ...createLine(), ...lineData }];
    commitTaxAwareLines(nextLines);

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

    const nextLines = editingTaxLineId
      ? lines.map((l) => (l.id === editingTaxLineId ? { ...l, ...lineData } : l))
      : [...lines, { ...createLine(), ...lineData }];
    commitTaxAwareLines(nextLines);

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
    if (lines.length <= 2) {
      removeLine(id);
      return;
    }
    // Phase 7L Part E: removing a VAT/EWT line must not leave the payable
    // inflated by the removed tax - rebalance the (unambiguous) AP credit
    // to Gross - EWT with no cumulative drift across add -> remove -> add.
    commitTaxAwareLines(lines.filter((l) => l.id !== id));
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
    setBalanceAssistMessage("");
    setForm({
      date: new Date().toISOString().split("T")[0],
      referenceNo: "",
      party: "",
      partyId: null,
      description: defaultDescription,
      checkNo: "",
      status: "Draft",
    });

    // Phase 7A: only meaningful for Invoice - see the dueDate state's own
    // comment. Harmless to reset unconditionally for every module since
    // no other module ever reads it.
    setDueDate(new Date().toISOString().split("T")[0]);
    setDueDateTouched(false);

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
    () => filterTransactions(transactions, { searchQuery, statusFilter, dateFrom, dateTo }),
    [transactions, searchQuery, statusFilter, dateFrom, dateTo]
  );
  const statusFilterOptions = useMemo(() => deriveStatusOptions(transactions), [transactions]);

  // Phase 7B: source -> filters -> sort -> render. sortBy is independent of
  // search/status/date - changing one never resets the other (spec section
  // 15). sortBy === null means "unsorted" - sortTransactions() then returns
  // filteredTransactions completely unchanged, preserving the original
  // loaded order (spec section 13), not a re-derived default.
  const [sortBy, setSortBy] = useState(null);
  const [sortDirection, setSortDirection] = useState("asc");

  const sortedTransactions = useMemo(
    () => sortTransactions(filteredTransactions, { sortBy, sortDirection }),
    [filteredTransactions, sortBy, sortDirection]
  );

  // Three-state cycle per column: unsorted -> ascending -> descending ->
  // unsorted again (clicking a DIFFERENT column always starts at ascending).
  function handleSortClick(column) {
    if (sortBy !== column) {
      setSortBy(column);
      setSortDirection("asc");
    } else if (sortDirection === "asc") {
      setSortDirection("desc");
    } else {
      setSortBy(null);
      setSortDirection("asc");
    }
  }

  function sortIndicator(column) {
    if (sortBy !== column) return null;
    return sortDirection === "asc" ? " ↑" : " ↓";
  }

  // Phase 7B Previous/Next (spec sections 15-16): navigates within the
  // already-loaded, module-scoped `transactions` array only - Invoice can
  // never step into APV, since each module fetches from its own endpoint.
  // Always lands back in view mode, same reasoning as targetFormMode's
  // default on handleView. Phase 7E: switched to the filtered list so
  // Previous/Next follows whatever Search/Status subset is active (spec
  // sections 16/30-G) - a transaction filtered out of view is no longer a
  // valid Previous/Next target. Phase 7B (this checkpoint): switched again
  // to sortedTransactions so Previous/Next always matches the row visually
  // adjacent in the table exactly as sorted, not the pre-sort order.
  const currentTransactionIndex = selectedTransaction?.id
    ? sortedTransactions.findIndex((t) => String(t.id) === String(selectedTransaction.id))
    : -1;
  const hasPreviousTransaction = currentTransactionIndex > 0;
  const hasNextTransaction =
    currentTransactionIndex >= 0 && currentTransactionIndex < sortedTransactions.length - 1;

  function handlePreviousTransaction() {
    if (!hasPreviousTransaction) return;
    handleView(sortedTransactions[currentTransactionIndex - 1]);
  }

  function handleNextTransaction() {
    if (!hasNextTransaction) return;
    handleView(sortedTransactions[currentTransactionIndex + 1]);
  }

  // Phase 7B status/permission gating (spec sections 7-10): PO's Open/
  // Closed/Draft lifecycle has no backend status restriction on Edit/
  // Delete at all (confirmed in Phase 7A.1 - see transactionModuleConfig.js),
  // so it's gated on permission + existing-record only; every other module
  // follows the real Draft/Posted rule the Phase 7A.1 backend guard
  // enforces, hiding Edit/Delete once a record is Posted so the frontend
  // stops offering an action the backend will now reject with 409.
  const alreadyReversed = !!selectedTransaction?.reversal?.reversed;
  const toolbarVisibility = getVoucherToolbarVisibility({
    moduleConfig, status: form.status, can, alreadyReversed,
  });

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

        // Phase 7A: an existing saved Invoice's due_date is already real,
        // intentional accounting data - never auto-follow Invoice Date
        // changes for it, hence dueDateTouched = true here (as opposed to
        // resetForm()'s false for a brand-new, never-saved Invoice).
        if (code === "INV") {
          setDueDate(data.dueDate || data.transactionDate || "");
          setDueDateTouched(true);
        }

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
    setBalanceAssistMessage("");
    setApvApplications([]);
    setFormMode(targetFormMode);
    setMode("form");
  }

  // Phase 7B Duplicate (Invoice only). Fetches the full source record
  // (the list row's own `lines`/tax data is empty - see loadTransactions()
  // above) then populates a brand-new, NEVER-SAVED form exactly like
  // handleAddNew() would, pre-filled with the source's business data.
  // Nothing is written until the user explicitly clicks Save Draft, which
  // goes through the exact same POST /api/invoices handleSave() already
  // uses for any new Invoice - no separate duplicate endpoint, no
  // INSERT...SELECT on the backend.
  async function handleDuplicate(transaction) {
    if (moduleConfigError) return;

    try {
      const endpoint = moduleConfig.endpoint;
      const res = await fetch(`${API_BASE}/api/${endpoint}/${transaction.id}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setError(data.message || "Unable to load source Invoice for duplication.");
        return;
      }

      // Same baseline a brand-new Invoice starts from (clears APV/PO/EWT/
      // currency/etc. state) - then overridden below with the copied
      // fields. Never touches the source record itself; nothing here is a
      // write.
      resetForm();

      const today = new Date().toISOString().split("T")[0];

      setForm({
        date: today,
        // Phase 7B: left blank, exactly like any other brand-new Invoice
        // (this codebase has no real auto-numbering scheme anywhere - every
        // voucher_no/referenceNo is free-text - so "the existing numbering
        // flow" for a new Invoice IS the user typing one in; never copies
        // the source's voucher_no).
        referenceNo: "",
        party: data.customerName,
        partyId: data.customerId,
        description: data.description,
        checkNo: "",
        status: "Draft",
      });

      setDueDate(today);
      setDueDateTouched(false);

      setLines(
        (data.lines || []).map((line) => {
          const sourceTaxEntry = (data.taxEntries || []).find((te) => te.lineId === line.id);
          // Reproduce the same user-entered VAT setup (party/rate/amounts/
          // classification/account) but strip the source's own DB identity
          // (id, lineId) - those referenced the OLD line's real row. A
          // fresh transaction_tax_entries row is generated normally by the
          // existing save path when this duplicate is actually saved.
          const { id: _teId, lineId: _teLineId, ...taxEntryRest } = sourceTaxEntry || {};

          return {
            id: crypto.randomUUID(),
            accountId: line.accountId || "",
            particulars: line.particulars || "",
            genRef: line.genRef || "",
            genName: line.genName || "",
            debit: (line.foreignDebit ?? line.debit) || "",
            credit: (line.foreignCredit ?? line.credit) || "",
            ...(sourceTaxEntry ? { taxEntry: { ...taxEntryRest, transactionDate: today } } : {}),
          };
        })
      );

      // EWT header fields (ATC code/withheld amount/payee TIN) - same
      // reasoning as the VAT lines above: reproduce the same setup, no DB
      // identity to strip since these are plain header values, not rows.
      setAtcCode(data.atcCode || "");
      setTaxWithheldAmount(data.taxWithheldAmount || "");
      setTaxWithheldTouched(Boolean(data.atcCode));
      setPayeeTin(data.payeeTin || "");

      // Currency: preserve the SELECTED currency, but resolve a FRESH rate
      // for today via the exact same handleCurrencyChange() every other
      // "pick a currency" moment in this form already uses - never trusts
      // the source's old, date-stale snapshot. This matches this app's own
      // established principle (confirmed by reading handleCurrencyChange
      // itself): a rate is only ever snapshotted at save time, and
      // re-resolved fresh every time a currency is actively selected
      // before that. The old snapshot is for a different transaction date
      // and would be a silently wrong rate to carry forward.
      if (CURRENCY_ELIGIBLE && data.currency && data.currency.currencyId) {
        await handleCurrencyChange(String(data.currency.currencyId));
      }

      // Phase 7B: Invoice attachments - audited, none exist anywhere in
      // this codebase (no attachment table, no upload route, no UI for
      // it), so there is nothing to decide whether to copy.

      setSelectedTransaction(null);
      setFormMode("edit");
      setMode("form");
    } catch (err) {
      console.error("DUPLICATE INVOICE ERROR:", err);
      setError("Unable to connect to server.");
    }
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

  // Phase 7K: open the Cancel/Void reason modal for APV/CV.
  function openCancelVoid(action) {
    setCancelVoidReason("");
    setCancelVoidAction(action);
  }

  async function postCancelVoidReverse(action, reason) {
    const res = await fetch(
      `${API_BASE}/api/${moduleConfig.endpoint}/${selectedTransaction.id}/${action}`,
      {
        method: "POST",
        credentials: "include",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ reason, companyId: selectedTransaction.companyId ?? form.companyId ?? undefined }),
      }
    );
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async function submitCancelVoid() {
    // Double-submit / double-click guard: `deleting` is already the button's
    // disabled flag, but bail here too so a fast second invocation can never
    // fire a second request (Phase 7K.1 §11).
    if (deleting) return;
    if (!selectedTransaction?.id || moduleConfigError || !cancelVoidAction) return;
    const reason = cancelVoidReason.trim();
    if (!reason) { alert("A reason is required."); return; }

    setDeleting(true);
    try {
      let action = cancelVoidAction;
      let { res, data } = await postCancelVoidReverse(action, reason);

      // Phase 7K.1: a Void whose ORIGINAL period is closed comes back as
      // 409 REVERSAL_REQUIRED - retry the same reason as a Reverse (posts a
      // reversing JV dated today; original stays Posted).
      if (!res.ok && res.status === 409 && data.code === "REVERSAL_REQUIRED") {
        action = "reverse";
        ({ res, data } = await postCancelVoidReverse("reverse", reason));
      }

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || `Failed to ${action} transaction.`);
        setCancelVoidAction(null);
        await handleView(selectedTransaction);
        return;
      }
      setCancelVoidAction(null);
      const verb = action === "void" ? "voided" : action === "reverse" ? "reversed" : "cancelled";
      alert(
        action === "reverse" && data.reversalVoucher
          ? `${title} reversed via ${data.reversalVoucher} (dated ${data.reversalDate}). The original stays Posted.`
          : `${title} ${verb} successfully.`
      );
      await loadTransactions();
      setMode("list");
    } catch (err) {
      console.error("CANCEL/VOID/REVERSE TRANSACTION ERROR:", err);
      alert("Unable to connect to server.");
      setCancelVoidAction(null);
    } finally {
      setDeleting(false);
    }
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

  // Phase 7A: Invoice-only Date/Due Date interaction (see the dueDate
  // state's own comment for the full rule). Only passed as TransactionSummaryPanel's
  // onDateChange for code === "INV" (see the compact-header wiring below);
  // every other compact-header module passes plain updateForm("date", ...)
  // instead, since none of them show/edit a Due Date.
  function handleInvoiceDateChange(value) {
    updateForm("date", value);
    if (!dueDateTouched) {
      setDueDate(value);
    }
  }

  function handleDueDateChange(value) {
    setDueDate(value);
    setDueDateTouched(true);
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
        // Phase 7A: Invoice sends its real, user-editable Due Date; every
        // other module keeps sending dueDate === transactionDate exactly
        // as before this checkpoint (unchanged behavior, per the explicit
        // non-scope instruction).
        dueDate: code === "INV" ? (dueDate || updatedForm.date) : updatedForm.date,
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
        // Phase 7G: a per-company duplicate voucher number (409) - surface
        // it in the form's error box too and leave every field as typed so
        // the user can just change the number and Save again.
        if (res.status === 409 && data.code === "DUPLICATE_VOUCHER_NO") {
          setError(data.message);
          return;
        }
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

                <label className="transaction-date-filter-label">
                  From
                  <input
                    type="date"
                    className="transaction-input"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    aria-label="Filter from date"
                  />
                </label>
                <label className="transaction-date-filter-label">
                  To
                  <input
                    type="date"
                    className="transaction-input"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    aria-label="Filter to date"
                  />
                </label>
                {(dateFrom || dateTo) && (
                  <button
                    type="button"
                    className="transaction-secondary-button"
                    onClick={() => { setDateFrom(""); setDateTo(""); }}
                  >
                    Clear Dates
                  </button>
                )}
              </div>

              <div className="transaction-table-container">
                <table className="transaction-table">
                  <thead>
                    <tr>
                      <th className="transaction-sortable-th" onClick={() => handleSortClick("referenceNo")}>
                        {code} No.{sortIndicator("referenceNo")}
                      </th>
                      <th className="transaction-sortable-th" onClick={() => handleSortClick("date")}>
                        Date{sortIndicator("date")}
                      </th>
                      <th className="transaction-sortable-th" onClick={() => handleSortClick("party")}>
                        {partyLabel}{sortIndicator("party")}
                      </th>
                      <th className="text-right transaction-sortable-th" onClick={() => handleSortClick("amount")}>
                        Amount{sortIndicator("amount")}
                      </th>
                      <th className="transaction-sortable-th" onClick={() => handleSortClick("status")}>
                        Status{sortIndicator("status")}
                      </th>
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
                    ) : sortedTransactions.length === 0 ? (
                      <tr>
                        <td colSpan="6" className="transaction-empty">
                          No transactions found.
                        </td>
                      </tr>
                    ) : (
                      sortedTransactions.map((transaction) => (
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
                            {/* Phase 7B: Invoice-only, gated on the existing
                                CREATE permission - no new permission
                                invented. Not offered on any other module
                                (unaudited, out of this checkpoint's scope). */}
                            {code === "INV" && can(moduleConfig.moduleKey, "CREATE") && (
                              <button
                                className="transaction-view-button"
                                onClick={() => handleDuplicate(transaction)}
                              >
                                Duplicate
                              </button>
                            )}
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
              showCancel={toolbarVisibility.showCancel}
              showVoid={toolbarVisibility.showVoid}
              showReverse={toolbarVisibility.showReverse}
              showPrint={!!printModuleType && toolbarVisibility.showPrint}
              showRecurring={!!recurringModuleType}
              showPrevious
              showNext
              hasPrevious={hasPreviousTransaction}
              hasNext={hasNextTransaction}
              showPost
              onEdit={handleEditClick}
              onDelete={handleDeleteClick}
              onCancel={() => openCancelVoid("cancel")}
              onVoid={() => openCancelVoid("void")}
              onReverse={() => openCancelVoid("reverse")}
              onPrint={() => setShowPrintOptionsModal(true)}
              onRecurring={() => setShowRecurringModal(true)}
              onPrevious={handlePreviousTransaction}
              onNext={handleNextTransaction}
              onBackToList={handleBackToList}
              onSaveDraft={() => handleSave("Draft")}
              onPost={handlePostTransactionClick}
            />

            {/* Phase 7K.1: closed-period-reversed APV/CV keeps status Posted
                but is logically reversed by a linked JV. */}
            {formMode === "view" && alreadyReversed && (
              <div className="transaction-tax-duplication-warning" role="status" style={{ margin: "8px 0" }}>
                ⦸ REVERSED BY {selectedTransaction.reversal.reversedByVoucher}
                {selectedTransaction.reversal.reversalDate ? ` on ${selectedTransaction.reversal.reversalDate}` : ""} — the original stays Posted; the two net to zero.
              </div>
            )}

            {/* Phase 7E section 7: view mode reads like a real accounting
                document with clearly labeled sections (Voucher Information /
                Accounting Entries / Totals) rather than an unlabeled block
                of fields - edit mode skips this title since the page's own
                "Edit {code}" heading already establishes context. */}
            {formMode === "view" && (
              <h2 className="transaction-view-section-title">Voucher Information</h2>
            )}

            {/* Phase 7G: compact top section, generalized from Phase 7F's
                Invoice-only version to every module in COMPACT_HEADER_MODULES
                (INV/OR/APV/CV/PO/JV - see that constant's own comment).
                Left (Customer or Supplier or Payee/Transaction Type or
                Check No./Description, via the unchanged
                TransactionVoucherHeader) and right (Reference No./Date/
                Currency/Due Date/Exchange Rate/Invoice Type, via
                TransactionSummaryPanel) render side by side in one
                2-column grid instead of stacking as separate full-width
                cards. Currency (and, for Invoice only, Due Date/Invoice
                Type) is MOVED here (not duplicated), so no separate
                CurrencySummary card renders below for any module in this
                set. PCV/DM/CM (currency-eligible but NOT in this set) keep
                the original stacked layout untouched. */}
            {COMPACT_HEADER_MODULES.has(code) ? (
              <div className="transaction-top-section">
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
                  hideDateAndReference
                />

                <TransactionSummaryPanel
                  code={code}
                  viewOnly={formMode === "view"}
                  form={form}
                  updateForm={updateForm}
                  dueDate={dueDate}
                  onDateChange={code === "INV" ? handleInvoiceDateChange : (value) => updateForm("date", value)}
                  onDueDateChange={handleDueDateChange}
                  showDueDate={code === "INV"}
                  currencyEligible={CURRENCY_ELIGIBLE}
                  currencyOptions={currencyOptions}
                  selectedCurrencyId={selectedCurrencyId}
                  baseCurrency={baseCurrency}
                  currencySnapshot={currencySnapshot}
                  handleCurrencyChange={handleCurrencyChange}
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
                  totals={totals}
                  showInvoiceType={code === "INV"}
                  invoiceType={invoiceType}
                  setInvoiceType={setInvoiceType}
                  recurrenceFrequency={recurrenceFrequency}
                  setRecurrenceFrequency={setRecurrenceFrequency}
                />
              </div>
            ) : (
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
            )}

            {CURRENCY_ELIGIBLE && !COMPACT_HEADER_MODULES.has(code) && (
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

            {/* Transaction-entry UI standardization: in edit mode this card
                is retired in favor of "+ Add Entry > Cash / Bank / Check"
                (see CashCheckDetailsModal.jsx) plus the compact status chip
                rendered next to that menu - same fields, same state, just
                reached through the same unified entry point Invoice/APV
                use. View mode is completely unchanged. */}
            {(code === "OR" || code === "CV") && formMode === "view" && (
              <div className="transaction-card">
                <div className="transaction-section-header">
                  <div>
                    <h2 className="transaction-section-title">Cash / Check Details</h2>
                  </div>
                </div>

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
              </div>
            )}

            {/* Phase 7C (spec section 3/25): the permanent EWT card is
                retired for Invoice/APV - EWT is now entered via "+ Add
                Entry" and lives as a journal line + View/Edit Tax Details.
                OR/CV/PO keep this exact card, completely untouched, since
                Phase 7C only restructures Invoice/APV (spec section 30). */}
            {/* Transaction-entry UI standardization: in edit mode this card
                is retired in favor of "+ Add Entry > EWT / Withholding Tax"
                (see LegacyEwtEntryModal.jsx) plus the compact status chip
                next to that menu when atcCode is already set - same fields,
                same state, same header-only persistence (never a
                transaction_tax_entries row), just reached through the same
                unified entry point Invoice/APV use. View mode unchanged. */}
            {ewtEligible && !["INV", "APV"].includes(code) && formMode === "view" && (
              <div className="transaction-card">
                <div className="transaction-section-header">
                  <div>
                    <h2 className="transaction-section-title">
                      {ewtOutbound ? "Withholding Tax" : "Tax Withheld by Customer"}
                    </h2>
                  </div>
                </div>

                {atcCode ? (
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
                )}
              </div>
            )}

            {/* Transaction-entry UI standardization: this card is fully
                retired (it was edit-mode-only, no view branch) in favor of
                "+ Add Entry > Output VAT / Input VAT" (see
                LegacyVatEntryModal.jsx) - same fields, same handleAddVatLine
                behavior (a plain, untagged line - never
                transaction_tax_entries), just reached through the same
                unified entry point Invoice/APV use. */}

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
                    {/* Transaction-entry UI standardization: every module now
                        uses the same "+ Add Entry" menu shell - only the
                        options offered differ, per what that module actually
                        supports. Invoice/APV keep the Phase 7C tagged-line
                        workflow unchanged. OR/CV/PO's VAT/EWT/Cash-Check
                        options open the Legacy*Modal wrappers around their
                        pre-existing, protected (non-tagged) behavior - never
                        the Invoice/APV workflow, which would risk
                        double-recognizing tax on a settlement document
                        (Phase 7D/7E). JV/Petty Cash/Debit Memo/Credit Memo
                        get an empty taxOptions list - they were never
                        tax-eligible, so the menu offers Regular Journal
                        Entry only. */}
                    <AddEntryMenu
                      onRegular={addLine}
                      taxOptions={[
                        ...(code === "INV" ? [{ key: "output_vat", label: "Output VAT", onClick: () => openAddVatEntry("OUTPUT") }] : []),
                        ...(code === "APV" ? [{ key: "input_vat", label: "Input VAT", onClick: () => openAddVatEntry("INPUT") }] : []),
                        ...(code === "INV" || code === "APV" ? [{ key: "ewt", label: "EWT / Withholding Tax", onClick: openAddEwtEntry }] : []),
                        ...(vatType && !["INV", "APV"].includes(code) ? [{ key: "legacy_vat", label: vatType, onClick: () => setShowLegacyVatModal(true) }] : []),
                        ...(ewtEligible && !["INV", "APV"].includes(code) ? [{ key: "legacy_ewt", label: "EWT / Withholding Tax", onClick: () => setShowLegacyEwtModal(true) }] : []),
                        ...(code === "OR" || code === "CV" ? [{ key: "cash_check", label: "Cash / Bank / Check", onClick: () => setShowCashCheckModal(true) }] : []),
                      ]}
                    />

                    {(code === "OR" || code === "CV") && (
                      <button
                        type="button"
                        className="transaction-entry-status-chip"
                        onClick={() => setShowCashCheckModal(true)}
                      >
                        💳 {paymentMethod}{paymentMethod === "Check" && checkNumber ? ` #${checkNumber}` : ""}
                      </button>
                    )}

                    {ewtEligible && !["INV", "APV"].includes(code) && atcCode && (
                      <button
                        type="button"
                        className="transaction-entry-status-chip"
                        onClick={() => setShowLegacyEwtModal(true)}
                      >
                        EWT: {atcCode} ({formatMoney(taxWithheldAmount)})
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

              {formMode !== "view" && balanceAssistMessage ? (
                <div className="transaction-tax-duplication-warning" role="alert">
                  ⚠ {balanceAssistMessage}
                </div>
              ) : null}

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

            {/* Phase 7K / 7K.1: APV/CV Cancel (Draft) / Void or Reverse (Posted) reason modal. */}
            {cancelVoidAction && (
              <div className="apv-modal-overlay">
                <div className="apv-modal confirm-dialog">
                  <div className="apv-modal-header">
                    <div>
                      <h2>
                        {cancelVoidAction === "reverse"
                          ? `Reverse this Posted ${title}?`
                          : cancelVoidAction === "void"
                            ? `Void this Posted ${title}?`
                            : `Cancel this Draft ${title}?`}
                      </h2>
                      <p>
                        {cancelVoidAction === "reverse"
                          ? `The original ${title} stays Posted. A reversing Journal Voucher dated today is created so the two net to zero. If the original period is open, Void is used instead automatically.`
                          : cancelVoidAction === "void"
                            ? `The ${title} is retained for audit but stops being recognized in the ledger.`
                            : `The ${title} is retained for audit but marked Cancelled.`}
                        {code === "CV" && (cancelVoidAction === "void" || cancelVoidAction === "reverse") &&
                          " Any payable balances it settled will be reopened and recalculated."}
                      </p>
                    </div>
                    <button type="button" className="apv-modal-close" onClick={() => setCancelVoidAction(null)} aria-label="Close">×</button>
                  </div>
                  <div className="tax-entry-modal-body">
                    <div className="transaction-field">
                      <label className="transaction-label">Reason (required)</label>
                      <textarea
                        className="transaction-input"
                        rows={3}
                        maxLength={500}
                        value={cancelVoidReason}
                        onChange={(e) => setCancelVoidReason(e.target.value)}
                        placeholder={`Why is this ${title} being ${cancelVoidAction === "reverse" ? "reversed" : cancelVoidAction === "void" ? "voided" : "cancelled"}?`}
                      />
                    </div>
                  </div>
                  <div className="apv-modal-footer">
                    <button type="button" className="transaction-secondary-button" onClick={() => setCancelVoidAction(null)} disabled={deleting}>
                      Close
                    </button>
                    <button type="button" className="transaction-danger-button" onClick={submitCancelVoid} disabled={deleting || !cancelVoidReason.trim()}>
                      {deleting ? "Working..." : cancelVoidAction === "reverse" ? "Reverse" : cancelVoidAction === "void" ? "Void" : "Cancel Draft"}
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
              taxAccountOptions={vatModalAccounts}
              missingAccountMessage={vatMissingMessage}
              vatRateCodes={vatRateCodes}
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
              taxAccountOptions={ewtModalAccounts}
              missingAccountMessage={ewtMissingMessage}
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

        {/* Transaction-entry UI standardization: unlike the modals above,
            these three are NOT scoped to INV/APV - they're only ever opened
            by OR/CV/PO's Add Entry menu (see the taxOptions wiring), but are
            mounted unconditionally (each returns null while its own `open`
            is false) rather than re-gating on `code` a second time. */}
        <LegacyVatEntryModal
          open={showLegacyVatModal}
          onClose={() => setShowLegacyVatModal(false)}
          vatType={vatType}
          vatAccountId={vatAccountId}
          setVatAccountId={setVatAccountId}
          vatTaxableAmount={vatTaxableAmount}
          setVatTaxableAmount={setVatTaxableAmount}
          vatRate={vatRate}
          setVatRate={setVatRate}
          vatAmount={vatAmount}
          accountOptions={vatModalAccounts}
          missingAccountMessage={vatMissingMessage}
          hasSourceApplications={hasSourceApplications}
          sourceDuplicationWarning={sourceDuplicationWarning}
          onAddLine={handleAddVatLine}
        />

        <LegacyEwtEntryModal
          open={showLegacyEwtModal}
          onClose={() => setShowLegacyEwtModal(false)}
          ewtOutbound={ewtOutbound}
          atcCode={atcCode}
          handleAtcCodeChange={handleAtcCodeChange}
          ewtCodes={ewtCodes}
          selectedEwt={selectedEwt}
          ewtTaxableBase={ewtTaxableBase}
          taxWithheldAmount={taxWithheldAmount}
          setTaxWithheldAmount={setTaxWithheldAmount}
          setTaxWithheldTouched={setTaxWithheldTouched}
          payeeTin={payeeTin}
          setPayeeTin={setPayeeTin}
          hasSourceApplications={hasSourceApplications}
          sourceDuplicationWarning={sourceDuplicationWarning}
        />

        <CashCheckDetailsModal
          open={showCashCheckModal}
          onClose={() => setShowCashCheckModal(false)}
          code={code}
          paymentMethod={paymentMethod}
          setPaymentMethod={setPaymentMethod}
          bankAccountId={bankAccountId}
          setBankAccountId={setBankAccountId}
          bankAccounts={bankAccounts}
          checkNumber={checkNumber}
          setCheckNumber={setCheckNumber}
          checkDate={checkDate}
          setCheckDate={setCheckDate}
        />
      </div>
    </div>
  );
}

