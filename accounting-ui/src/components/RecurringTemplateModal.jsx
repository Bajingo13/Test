import { useEffect, useState } from "react";
import { Repeat, Calendar, Loader2 } from "lucide-react";
import "./RecurringTemplateModal.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const FREQUENCIES = [
  { value: "DAILY", label: "Daily" },
  { value: "WEEKLY", label: "Weekly" },
  { value: "BIWEEKLY", label: "Every 2 Weeks" },
  { value: "MONTHLY", label: "Monthly" },
  { value: "BIMONTHLY", label: "Every 2 Months" },
  { value: "QUARTERLY", label: "Quarterly" },
  { value: "SEMIANNUAL", label: "Semiannual" },
  { value: "ANNUAL", label: "Annual" },
  { value: "CUSTOM", label: "Custom Interval" },
];

const WEEKDAYS = [
  { value: 0, label: "Sunday" }, { value: 1, label: "Monday" }, { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" }, { value: 4, label: "Thursday" }, { value: 5, label: "Friday" }, { value: 6, label: "Saturday" },
];

const MONTH_RULE_TYPES = [
  { value: "SAME_DAY", label: "Same calendar day each month" },
  { value: "LAST_DAY", label: "Last day of the month" },
  { value: "FIRST_BUSINESS_DAY", label: "First business day" },
  { value: "LAST_BUSINESS_DAY", label: "Last business day" },
  { value: "SPECIFIC_WEEKDAY", label: "Specific weekday (e.g. first Monday)" },
];

const ORDINALS = ["FIRST", "SECOND", "THIRD", "FOURTH", "LAST"];

const DATE_ADJUSTMENT_RULES = [
  { value: "KEEP_ORIGINAL", label: "Keep original date" },
  { value: "NEXT_BUSINESS_DAY", label: "Move to next business day" },
  { value: "PREVIOUS_BUSINESS_DAY", label: "Move to previous business day" },
  { value: "LAST_VALID_DAY", label: "Use last valid day of the month" },
  { value: "SKIP", label: "Skip occurrence" },
];

const DUE_DATE_MODES = [
  { value: "SAME_AS_TRANSACTION_DATE", label: "Same as transaction date" },
  { value: "ADD_DAYS", label: "Add N days" },
  { value: "ADD_WEEKS", label: "Add N weeks" },
  { value: "ADD_MONTHS", label: "Add N months" },
  { value: "END_OF_CURRENT_MONTH", label: "End of current month" },
  { value: "END_OF_NEXT_MONTH", label: "End of next month" },
  { value: "PAYMENT_TERMS", label: "Based on payment terms (days)" },
];

const AMOUNT_MODES = [
  { value: "FIXED", label: "Fixed amount", description: "Always use the template's saved amounts." },
  { value: "COPY_LAST", label: "Copy last generated amount", description: "Reuse whatever amount the previous occurrence actually used." },
  { value: "MANUAL_REVIEW", label: "Manual review required", description: "Generates a Draft flagged for review before posting." },
  { value: "PERCENTAGE_ADJUSTMENT", label: "Percentage adjustment", description: "Scale the amount by a fixed % starting after N occurrences." },
  { value: "ESCALATION", label: "Escalation by effective date", description: "Scale the amount by a fixed % once a chosen date is reached." },
];

const todayISO = () => new Date().toISOString().slice(0, 10);

export default function RecurringTemplateModal({ open, onClose, transactionType, transactionId, currentUser }) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const [bootstrap, setBootstrap] = useState(null);
  const [templateName, setTemplateName] = useState("");

  const [frequency, setFrequency] = useState("MONTHLY");
  const [intervalValue, setIntervalValue] = useState(1);
  const [customUnit, setCustomUnit] = useState("DAYS");
  const [weekday, setWeekday] = useState(1);
  const [monthRuleType, setMonthRuleType] = useState("SAME_DAY");
  const [monthDay, setMonthDay] = useState(1);
  const [monthRuleWeekday, setMonthRuleWeekday] = useState(1);
  const [monthRuleOrdinal, setMonthRuleOrdinal] = useState("FIRST");
  const [annualMonth, setAnnualMonth] = useState(1);
  const [annualDay, setAnnualDay] = useState(1);

  const [startDate, setStartDate] = useState(todayISO());
  const [endDate, setEndDate] = useState("");
  const [maxOccurrences, setMaxOccurrences] = useState("");
  const [dateAdjustmentRule, setDateAdjustmentRule] = useState("KEEP_ORIGINAL");

  const [dueDateMode, setDueDateMode] = useState("SAME_AS_TRANSACTION_DATE");
  const [dueDateParam, setDueDateParam] = useState(30);

  const [amountMode, setAmountMode] = useState("FIXED");
  const [percentAdjust, setPercentAdjust] = useState(5);
  const [effectiveAfterOccurrence, setEffectiveAfterOccurrence] = useState(1);
  const [escalationDate, setEscalationDate] = useState("");
  const [escalationPercent, setEscalationPercent] = useState(5);

  // Checkpoint 3D: template currency + rate policy (section 21-26). A
  // recurring template stores WHICH currency and HOW to resolve its rate -
  // it never permanently locks today's market rate (unless the policy is
  // explicitly Fixed Rate).
  const [currencyOptions, setCurrencyOptions] = useState([]);
  const [baseCurrency, setBaseCurrency] = useState(null);
  const [currencyId, setCurrencyId] = useState("");
  const [ratePolicy, setRatePolicy] = useState("RESOLVE_ON_GENERATION");
  const [fixedRate, setFixedRate] = useState("");
  const isForeignTemplate = currencyId && baseCurrency && String(currencyId) !== String(baseCurrency.id);

  const [previewDates, setPreviewDates] = useState([]);
  const [currentRatePreview, setCurrentRatePreview] = useState(null);
  const [rateResolving, setRateResolving] = useState(false);

  // Keep the day-of-month / weekday / annual-month-day fields in sync with
  // whatever start date the user picks, so "Monthly, same day" defaults to
  // the day they actually chose instead of a stale default of the 1st.
  // They can still override any of these afterward.
  useEffect(() => {
    if (!startDate) return;
    const d = new Date(`${startDate}T00:00:00`);
    if (Number.isNaN(d.getTime())) return;
    setMonthDay(d.getDate());
    setAnnualMonth(d.getMonth() + 1);
    setAnnualDay(d.getDate());
    setWeekday(d.getDay());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setSuccess(null);
    setPreviewDates([]);
    (async () => {
      try {
        const [bootstrapRes, currenciesRes] = await Promise.all([
          fetch(`${API_URL}/api/recurring-transactions/from-transaction/${transactionType}/${transactionId}`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", ...authHeaders() },
          }),
          fetch(`${API_URL}/api/currencies`, { headers: authHeaders() }),
        ]);
        const data = await handleResponse(bootstrapRes);
        setBootstrap(data);
        setTemplateName(`${data.partyName || "Recurring"} - ${transactionType.toUpperCase()}`);

        const currencyData = await currenciesRes.json().catch(() => []);
        const active = Array.isArray(currencyData) ? currencyData.filter((c) => c.isActive) : [];
        setCurrencyOptions(active);
        const base = active.find((c) => c.isBaseCurrency) || null;
        setBaseCurrency(base);
        // Default to whatever currency the SOURCE transaction actually
        // used (falls back to base currency for a base-currency source,
        // or if that currency is no longer active) - the user can still
        // change it before saving.
        const sourceStillActive = data.sourceCurrencyId && active.some((c) => String(c.id) === String(data.sourceCurrencyId));
        setCurrencyId(sourceStillActive ? String(data.sourceCurrencyId) : (base ? String(base.id) : ""));
      } catch (err) {
        setError(err.message || "Failed to load this transaction's data.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, transactionType, transactionId]);

  if (!open) return null;

  async function handleResponse(res) {
    if (res.status === 401 || res.status === 403) throw new Error("You don't have permission to do this.");
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) throw new Error(data?.message || `The server returned an error (${res.status}).`);
    return data;
  }

  function buildMonthRule() {
    if (frequency === "ANNUAL") return { month: Number(annualMonth), day: Number(annualDay) };
    if (!["MONTHLY", "BIMONTHLY", "QUARTERLY", "SEMIANNUAL"].includes(frequency)) return null;
    if (monthRuleType === "SPECIFIC_WEEKDAY") {
      return { type: "SPECIFIC_WEEKDAY", weekday: jsWeekdayToLuxon(monthRuleWeekday), ordinal: monthRuleOrdinal };
    }
    if (monthRuleType === "SAME_DAY") {
      return { type: "SAME_DAY", day: Number(monthDay) };
    }
    return { type: monthRuleType };
  }

  function jsWeekdayToLuxon(w) {
    const n = Number(w);
    return n === 0 ? 7 : n;
  }

  function buildDueDateRule() {
    const rule = { mode: dueDateMode };
    if (dueDateMode === "ADD_DAYS") rule.days = Number(dueDateParam);
    if (dueDateMode === "ADD_WEEKS") rule.weeks = Number(dueDateParam);
    if (dueDateMode === "ADD_MONTHS") rule.months = Number(dueDateParam);
    if (dueDateMode === "PAYMENT_TERMS") rule.termDays = Number(dueDateParam);
    return rule;
  }

  function buildAmountConfig() {
    if (amountMode === "PERCENTAGE_ADJUSTMENT") {
      return { percent: Number(percentAdjust), effectiveAfterOccurrence: Number(effectiveAfterOccurrence) };
    }
    if (amountMode === "ESCALATION") {
      return { escalations: escalationDate ? [{ effectiveDate: escalationDate, percent: Number(escalationPercent) }] : [] };
    }
    return {};
  }

  function buildScheduleConfig() {
    return {
      frequency,
      intervalValue: Number(intervalValue) || 1,
      customUnit: frequency === "CUSTOM" ? customUnit : undefined,
      weekday: frequency === "WEEKLY" || frequency === "BIWEEKLY" ? Number(weekday) : undefined,
      monthDay: frequency === "MONTHLY" && monthRuleType === "SAME_DAY" ? Number(monthDay) : undefined,
      monthRule: buildMonthRule(),
      startDate,
      endDate: endDate || undefined,
      maxOccurrences: maxOccurrences ? Number(maxOccurrences) : undefined,
      dateAdjustmentRule,
      amountMode,
    };
  }

  async function runPreview() {
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/recurring-transactions/preview-schedule?count=6`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(buildScheduleConfig()),
      });
      const data = await handleResponse(res);
      setPreviewDates(data.dates || []);
    } catch (err) {
      setError(err.message || "Failed to preview this schedule.");
    }
  }

  // Section 36: read-only "current available rate" for display - never
  // persisted, never used to generate anything. Only meaningful for
  // RESOLVE_ON_GENERATION, since FIXED_RATE already shows its own fixed
  // number and MANUAL_REVIEW deliberately shows none until approved.
  async function resolveCurrentRate() {
    if (!isForeignTemplate) return;
    setRateResolving(true);
    setCurrentRatePreview(null);
    try {
      const res = await fetch(`${API_URL}/api/exchange-rates/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ currencyId, transactionDate: startDate }),
      });
      const data = await handleResponse(res);
      setCurrentRatePreview(data.rate != null ? { rate: data.rate, effectiveDate: data.effectiveDate } : null);
    } catch (err) {
      setError(err.message || "Failed to resolve the current rate.");
    } finally {
      setRateResolving(false);
    }
  }

  async function handleSave() {
    if (!bootstrap) return;
    if (isForeignTemplate && ratePolicy === "FIXED_RATE" && (!fixedRate || Number(fixedRate) <= 0)) {
      setError("A Fixed Rate policy requires a fixed rate greater than zero.");
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`${API_URL}/api/recurring-transactions`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          moduleType: transactionType,
          templateName,
          partyId: bootstrap.partyId,
          partyName: bootstrap.partyName,
          descriptionTemplate: bootstrap.descriptionTemplate,
          lines: bootstrap.lines,
          currency: currencyOptions.find((c) => String(c.id) === String(currencyId))?.currencyCode || "PHP",
          currencyId: isForeignTemplate ? currencyId : null,
          ratePolicy: isForeignTemplate ? ratePolicy : "RESOLVE_ON_GENERATION",
          fixedRate: isForeignTemplate && ratePolicy === "FIXED_RATE" ? Number(fixedRate) : null,
          amountMode,
          amountConfig: buildAmountConfig(),
          dueDateRule: buildDueDateRule(),
          schedule: buildScheduleConfig(),
        }),
      });
      const data = await handleResponse(res);
      setSuccess(`Recurring template saved. First occurrence: ${data.nextRunDate}.`);
    } catch (err) {
      setError(err.message || "Failed to save the recurring template.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rtm-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rtm-modal" role="dialog" aria-modal="true" aria-label="Make Recurring">
        <div className="rtm-header">
          <div>
            <h2><Repeat size={18} /> Make Recurring</h2>
            <p className="rtm-subtitle">Save this transaction as a recurring template. Generated occurrences always start as Draft.</p>
          </div>
          <button type="button" className="rtm-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        {loading ? (
          <div className="rtm-body rtm-loading"><Loader2 className="rtm-spin" size={20} /> Loading transaction data...</div>
        ) : (
          <div className="rtm-body">
            <div className="rtm-columns">
              <div className="rtm-form-col">
                <div className="rtm-field">
                  <label>Template Name</label>
                  <input type="text" value={templateName} onChange={(e) => setTemplateName(e.target.value)} />
                </div>

                <div className="rtm-field">
                  <label>Currency</label>
                  <select
                    value={currencyId}
                    onChange={(e) => { setCurrencyId(e.target.value); setCurrentRatePreview(null); }}
                  >
                    {currencyOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.currencySymbol} {c.currencyCode} — {c.currencyName}{c.isBaseCurrency ? " (Base)" : ""}
                      </option>
                    ))}
                  </select>
                </div>

                {isForeignTemplate && (
                  <>
                    <div className="rtm-field">
                      <label>Rate Policy</label>
                      <select value={ratePolicy} onChange={(e) => { setRatePolicy(e.target.value); setCurrentRatePreview(null); }}>
                        <option value="RESOLVE_ON_GENERATION">Resolve on generation (recommended)</option>
                        <option value="FIXED_RATE">Fixed rate</option>
                        <option value="MANUAL_REVIEW">Manual review required</option>
                      </select>
                      <p className="rtm-hint">
                        {ratePolicy === "RESOLVE_ON_GENERATION" && "Each occurrence resolves its own rate on its own generation date - never copies today's rate forward."}
                        {ratePolicy === "FIXED_RATE" && "Every occurrence uses the fixed rate below until you edit the template. Already-generated occurrences are never changed."}
                        {ratePolicy === "MANUAL_REVIEW" && "Occurrences are held (RATE_REVIEW_REQUIRED) until a rate is explicitly approved - nothing generates automatically."}
                      </p>
                    </div>

                    {ratePolicy === "FIXED_RATE" && (
                      <div className="rtm-field">
                        <label>Fixed Rate</label>
                        <input type="number" step="0.000001" min="0" value={fixedRate} onChange={(e) => setFixedRate(e.target.value)} placeholder="e.g. 57.50" />
                      </div>
                    )}

                    {ratePolicy === "RESOLVE_ON_GENERATION" && (
                      <div className="rtm-field">
                        <button type="button" className="rtm-btn-secondary" onClick={resolveCurrentRate} disabled={rateResolving}>
                          {rateResolving ? "Checking..." : "Check Current Available Rate"}
                        </button>
                        {currentRatePreview && (
                          <p className="rtm-hint">
                            Current rate: {currentRatePreview.rate} (as of {currentRatePreview.effectiveDate}). Preview only — rate may change before generation.
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}

                <div className="rtm-field-row">
                  <div className="rtm-field">
                    <label>Frequency</label>
                    <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                      {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                  </div>
                  {(frequency === "CUSTOM") && (
                    <div className="rtm-field">
                      <label>Every N</label>
                      <div className="rtm-inline-pair">
                        <input type="number" min={1} value={intervalValue} onChange={(e) => setIntervalValue(e.target.value)} />
                        <select value={customUnit} onChange={(e) => setCustomUnit(e.target.value)}>
                          <option value="DAYS">Days</option>
                          <option value="WEEKS">Weeks</option>
                          <option value="MONTHS">Months</option>
                          <option value="YEARS">Years</option>
                        </select>
                      </div>
                    </div>
                  )}
                </div>

                {(frequency === "WEEKLY" || frequency === "BIWEEKLY") && (
                  <div className="rtm-field">
                    <label>Weekday</label>
                    <select value={weekday} onChange={(e) => setWeekday(e.target.value)}>
                      {WEEKDAYS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                    </select>
                  </div>
                )}

                {["MONTHLY", "BIMONTHLY", "QUARTERLY", "SEMIANNUAL"].includes(frequency) && (
                  <div className="rtm-field">
                    <label>Monthly Rule</label>
                    <select value={monthRuleType} onChange={(e) => setMonthRuleType(e.target.value)}>
                      {MONTH_RULE_TYPES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                    {monthRuleType === "SAME_DAY" && (
                      <input type="number" min={1} max={31} value={monthDay} onChange={(e) => setMonthDay(e.target.value)} style={{ marginTop: 8 }} />
                    )}
                    {monthRuleType === "SPECIFIC_WEEKDAY" && (
                      <div className="rtm-inline-pair" style={{ marginTop: 8 }}>
                        <select value={monthRuleOrdinal} onChange={(e) => setMonthRuleOrdinal(e.target.value)}>
                          {ORDINALS.map((o) => <option key={o} value={o}>{o.charAt(0) + o.slice(1).toLowerCase()}</option>)}
                        </select>
                        <select value={monthRuleWeekday} onChange={(e) => setMonthRuleWeekday(e.target.value)}>
                          {WEEKDAYS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                )}

                {frequency === "ANNUAL" && (
                  <div className="rtm-field">
                    <label>Month and Day</label>
                    <div className="rtm-inline-pair">
                      <select value={annualMonth} onChange={(e) => setAnnualMonth(e.target.value)}>
                        {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                          <option key={m} value={m}>{new Date(2000, m - 1, 1).toLocaleString("en-US", { month: "long" })}</option>
                        ))}
                      </select>
                      <input type="number" min={1} max={31} value={annualDay} onChange={(e) => setAnnualDay(e.target.value)} />
                    </div>
                  </div>
                )}

                <div className="rtm-field-row">
                  <div className="rtm-field">
                    <label>Start Date</label>
                    <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                  </div>
                  <div className="rtm-field">
                    <label>End Date (optional)</label>
                    <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                  </div>
                </div>

                <div className="rtm-field-row">
                  <div className="rtm-field">
                    <label>Max Occurrences (optional)</label>
                    <input type="number" min={1} value={maxOccurrences} onChange={(e) => setMaxOccurrences(e.target.value)} />
                  </div>
                  <div className="rtm-field">
                    <label>Date Adjustment Rule</label>
                    <select value={dateAdjustmentRule} onChange={(e) => setDateAdjustmentRule(e.target.value)}>
                      {DATE_ADJUSTMENT_RULES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                  </div>
                </div>

                <div className="rtm-field-row">
                  <div className="rtm-field">
                    <label>Due Date Rule</label>
                    <select value={dueDateMode} onChange={(e) => setDueDateMode(e.target.value)}>
                      {DUE_DATE_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select>
                  </div>
                  {["ADD_DAYS", "ADD_WEEKS", "ADD_MONTHS", "PAYMENT_TERMS"].includes(dueDateMode) && (
                    <div className="rtm-field">
                      <label>Value</label>
                      <input type="number" min={0} value={dueDateParam} onChange={(e) => setDueDateParam(e.target.value)} />
                    </div>
                  )}
                </div>

                <div className="rtm-field">
                  <label>Amount Mode</label>
                  <select value={amountMode} onChange={(e) => setAmountMode(e.target.value)}>
                    {AMOUNT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                  <p className="rtm-hint">{AMOUNT_MODES.find((m) => m.value === amountMode)?.description}</p>
                </div>

                {amountMode === "PERCENTAGE_ADJUSTMENT" && (
                  <div className="rtm-field-row">
                    <div className="rtm-field">
                      <label>Adjust By (%)</label>
                      <input type="number" value={percentAdjust} onChange={(e) => setPercentAdjust(e.target.value)} />
                    </div>
                    <div className="rtm-field">
                      <label>Effective After Occurrence #</label>
                      <input type="number" min={0} value={effectiveAfterOccurrence} onChange={(e) => setEffectiveAfterOccurrence(e.target.value)} />
                    </div>
                  </div>
                )}

                {amountMode === "ESCALATION" && (
                  <div className="rtm-field-row">
                    <div className="rtm-field">
                      <label>Effective Date</label>
                      <input type="date" value={escalationDate} onChange={(e) => setEscalationDate(e.target.value)} />
                    </div>
                    <div className="rtm-field">
                      <label>Adjust By (%)</label>
                      <input type="number" value={escalationPercent} onChange={(e) => setEscalationPercent(e.target.value)} />
                    </div>
                  </div>
                )}

                {bootstrap?.descriptionTemplate && (
                  <p className="rtm-hint">
                    Description supports variables: <code>{"{{month_name}}"}</code> <code>{"{{year}}"}</code> <code>{"{{sequence_number}}"}</code> — edit the description on the saved transaction before making it recurring if you want these substituted.
                  </p>
                )}
              </div>

              <div className="rtm-preview-col">
                <button type="button" className="rtm-btn-secondary" onClick={runPreview}>
                  <Calendar size={15} /> Preview Next Occurrences
                </button>
                {previewDates.length > 0 && (
                  <ul className="rtm-preview-list">
                    {previewDates.map((d, i) => <li key={d}>{i + 1}. {d}</li>)}
                  </ul>
                )}
                {error && <div className="rtm-error-banner">{error}</div>}
                {success && <div className="rtm-success-banner">{success}</div>}
              </div>
            </div>
          </div>
        )}

        <div className="rtm-footer">
          <button type="button" className="rtm-btn-secondary" onClick={onClose}>Close</button>
          <button type="button" className="rtm-btn-primary" disabled={loading || busy || !bootstrap} onClick={handleSave}>
            {busy ? "Saving..." : "Save Recurring Template"}
          </button>
        </div>
      </div>
    </div>
  );
}
