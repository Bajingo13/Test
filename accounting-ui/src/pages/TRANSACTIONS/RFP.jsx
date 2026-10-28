import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { createRequestGuard, isCompanyLocked, pickInitialCompany } from "../../utils/trialBalanceCompany.mjs";
import {
  RFP_MODULE,
  RFP_STATUSES,
  STATUS_META,
  WORKFLOW_DIALOGS,
  apvPagePath,
  availableActions,
  belongsToCompany,
  buildConvertPayload,
  buildPayload,
  canOpenApvPage,
  emptyForm,
  errorMessage,
  formFromRfp,
  formatAmount,
  hasActiveFilters,
  listQuery,
  lookupsQuery,
  refineList,
} from "../../utils/rfpPage.mjs";
import RfpForm from "./RfpForm";
import RfpDetail, { StatusBadge, formatDateTime } from "./RfpDetail";
import RfpActionDialog from "./RfpActionDialog";
import RfpConvertDialog from "./RfpConvertDialog";
import "./RFP.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// One fetch wrapper for every RFP call: never throws, never logs bodies.
// status 0 = the request never reached the server.
async function api(path, { method = "GET", body } = {}) {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      credentials: "include",
      headers: { ...authHeaders(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

const DELETE_DIALOG = {
  title: "Delete Request for Payment",
  message: "This draft and its lines will be permanently deleted.",
  note: "none",
  confirm: "Delete",
  tone: "danger",
};

// Request for Payment (RFP): list / create / edit / view with the R3
// workflow actions and the R5 conversion to a Draft APV. Company context follows Trial Balance: a single-company
// user's company is preselected and locked; a Super Admin or multi-company
// user must choose, and nothing is requested before they do. The view is
// driven by the URL (?new=1, ?id=N, ?id=N&edit=1) - the RFP id is the only
// thing taken from it, never a company. Every read and mutation is
// re-authorized by the server.
export default function RFP() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rfpId = searchParams.get("id");
  const mode = searchParams.get("new") ? "create" : rfpId ? (searchParams.get("edit") ? "edit" : "view") : "list";

  const [ctx, setCtx] = useState({ status: "loading", companies: [], isSuperAdmin: false, userId: null, username: "", perms: new Set() });
  const [companyId, setCompanyId] = useState("");
  const [lookups, setLookups] = useState({ status: "idle", data: null, error: "" });
  const [list, setList] = useState({ status: "idle", rows: [], error: "" });
  const [detail, setDetail] = useState({ status: "idle", rfp: null, error: "", code: 0 });
  const [history, setHistory] = useState({ status: "idle", rows: [], error: "" });
  const [filters, setFilters] = useState({ status: "", search: "", from: "", to: "" });
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [dialog, setDialog] = useState(null); // { key, busy, error }

  // Separate guards so one area's request can't invalidate another's, and a
  // company change invalidates all of them.
  const guards = useRef({ lookups: createRequestGuard(), list: createRequestGuard(), detail: createRequestGuard() });
  const invalidateAll = () => Object.values(guards.current).forEach((g) => g.invalidate());

  const can = useCallback(
    (action) => ctx.isSuperAdmin || ctx.perms.has(`${RFP_MODULE}.${action}`),
    [ctx.isSuperAdmin, ctx.perms]
  );
  const companies = ctx.companies;
  const locked = isCompanyLocked({ companies, isSuperAdmin: ctx.isSuperAdmin });
  const company = companies.find((c) => String(c.id) === String(companyId)) || null;
  const showCompanyColumn = !locked;

  const loadContext = useCallback(async () => {
    setCtx((c) => ({ ...c, status: "loading" }));
    const [me, cos] = await Promise.all([api("/api/me/permissions"), api("/api/companies")]);
    if (!me.ok || !cos.ok) {
      invalidateAll();
      setCtx({ status: "error", companies: [], isSuperAdmin: false, userId: null, username: "", perms: new Set() });
      setCompanyId("");
      return;
    }
    const list = Array.isArray(cos.data) ? cos.data : [];
    const isSuperAdmin = me.data?.user?.roleCode === "SUPER_ADMIN";
    const perms = new Set((me.data?.permissions || []).filter((p) => p.granted).map((p) => `${p.moduleKey}.${p.action}`));
    setCtx({ status: "ready", companies: list, isSuperAdmin, userId: me.data?.user?.id ?? null, username: me.data?.user?.username || "", perms });
    setCompanyId((current) => pickInitialCompany({ companies: list, isSuperAdmin, current }));
  }, []);

  useEffect(() => {
    loadContext();
  }, [loadContext]);

  const canView = ctx.status === "ready" && can("VIEW");

  // Form options (suppliers / currencies / branches / accounts) of the
  // selected company.
  useEffect(() => {
    const query = canView ? lookupsQuery(companyId) : null;
    if (!query) {
      setLookups({ status: "idle", data: null, error: "" });
      return;
    }
    const ticket = guards.current.lookups.next();
    setLookups({ status: "loading", data: null, error: "" });
    api(`/api/rfp/lookups?${query}`).then((r) => {
      if (!guards.current.lookups.isCurrent(ticket)) return;
      if (r.ok && String(r.data?.companyId) === String(companyId)) setLookups({ status: "ready", data: r.data, error: "" });
      else setLookups({ status: "error", data: null, error: errorMessage(r.status, r.data, "Unable to load suppliers, currencies and accounts.") });
    });
  }, [canView, companyId]);

  const loadList = useCallback(() => {
    const query = listQuery({ companyId, status: filters.status });
    if (!query) return;
    const ticket = guards.current.list.next();
    setList((l) => ({ status: "loading", rows: l.rows, error: "" }));
    api(`/api/rfp?${query}`).then((r) => {
      if (!guards.current.list.isCurrent(ticket)) return;
      const rows = Array.isArray(r.data) ? r.data : [];
      // Rows of any other company are never shown under this one.
      if (r.ok) setList({ status: "ready", rows: rows.filter((row) => belongsToCompany(row, companyId)), error: "" });
      else setList({ status: "error", rows: [], error: errorMessage(r.status, r.data, "Unable to load Requests for Payment.") });
    });
  }, [companyId, filters.status]);

  useEffect(() => {
    if (canView && mode === "list" && companyId) loadList();
  }, [canView, mode, companyId, loadList]);

  const loadDetail = useCallback(() => {
    if (!rfpId || !companyId) return;
    const ticket = guards.current.detail.next();
    setDetail((d) => ({ status: "loading", rfp: d.rfp && String(d.rfp.id) === rfpId ? d.rfp : null, error: "", code: 0 }));
    setHistory((h) => ({ status: "loading", rows: h.rows, error: "" }));
    Promise.all([api(`/api/rfp/${encodeURIComponent(rfpId)}`), api(`/api/rfp/${encodeURIComponent(rfpId)}/history`)]).then(([d, h]) => {
      if (!guards.current.detail.isCurrent(ticket)) return;
      if (d.ok) setDetail({ status: "ready", rfp: d.data, error: "", code: 200 });
      else setDetail({ status: "error", rfp: null, error: errorMessage(d.status, d.data, "Unable to load the Request for Payment."), code: d.status });
      if (h.ok) setHistory({ status: "ready", rows: Array.isArray(h.data) ? h.data : [], error: "" });
      else setHistory({ status: "error", rows: [], error: errorMessage(h.status, h.data, "Unable to load the history.") });
    });
  }, [rfpId, companyId]);

  useEffect(() => {
    if (canView && (mode === "view" || mode === "edit") && companyId) loadDetail();
    else {
      guards.current.detail.invalidate();
      setDetail({ status: "idle", rfp: null, error: "", code: 0 });
      setHistory({ status: "idle", rows: [], error: "" });
    }
  }, [canView, mode, companyId, loadDetail]);

  // Switching company drops everything shown for the previous one (and
  // anything still in flight for it) and returns to the list. Choosing the
  // FIRST company keeps the URL's RFP: nothing was shown yet, and the
  // detail is only displayed if it belongs to the chosen company.
  function changeCompany(value) {
    const switching = Boolean(companyId);
    invalidateAll();
    setCompanyId(value);
    setList({ status: "idle", rows: [], error: "" });
    setDetail({ status: "idle", rfp: null, error: "", code: 0 });
    setHistory({ status: "idle", rows: [], error: "" });
    setNotice("");
    if (switching && mode !== "list") setSearchParams({});
  }

  const go = (params) => {
    setFormError("");
    setSearchParams(params);
  };

  const rfp = detail.rfp && belongsToCompany(detail.rfp, companyId) ? detail.rfp : null;
  const wrongCompany = detail.rfp && !belongsToCompany(detail.rfp, companyId) ? detail.rfp : null;
  const actions = useMemo(() => availableActions({ rfp, can, userId: ctx.userId }), [rfp, can, ctx.userId]);
  const accountsById = useMemo(() => new Map((lookups.data?.accounts || []).map((a) => [a.id, a])), [lookups.data]);
  const canViewApv = ctx.isSuperAdmin || ctx.perms.has("TRANSACTIONS.APV.VIEW");
  const apvPath = canOpenApvPage({ rfp, companies, isSuperAdmin: ctx.isSuperAdmin, canViewApv }) ? apvPagePath(rfp.convertedApvId) : null;
  const visibleRows = useMemo(() => refineList(list.rows, filters), [list.rows, filters]);

  async function save(form) {
    setSaving(true);
    setFormError("");
    const isCreate = mode === "create";
    const payload = buildPayload(form, { companyId, isCreate });
    const r = isCreate
      ? await api("/api/rfp", { method: "POST", body: payload })
      : await api(`/api/rfp/${encodeURIComponent(rfpId)}`, { method: "PUT", body: payload });
    setSaving(false);
    if (!r.ok) {
      setFormError(errorMessage(r.status, r.data, "Unable to save the Request for Payment."));
      return;
    }
    setNotice(
      isCreate
        ? `Request for Payment ${r.data.rfpNo} was created as a draft.`
        : r.data.status === "RETURNED"
          ? `Request for Payment ${r.data.rfpNo} was updated. It is still RETURNED - resubmit it when the corrections are complete.`
          : `Request for Payment ${r.data.rfpNo} was updated.`
    );
    go({ id: String(r.data.id) });
  }

  async function confirmDialog(note) {
    const key = dialog.key;
    setDialog((d) => ({ ...d, busy: true, error: "" }));
    const r =
      key === "delete"
        ? await api(`/api/rfp/${encodeURIComponent(rfpId)}`, { method: "DELETE" })
        : await api(`/api/rfp/${encodeURIComponent(rfpId)}/${WORKFLOW_DIALOGS[key].route || key}`, { method: "POST", body: note ? { note } : {} });
    if (!r.ok) {
      setDialog((d) => ({ ...d, busy: false, error: errorMessage(r.status, r.data, "The action could not be completed.") }));
      return;
    }
    setDialog(null);
    if (key === "delete") {
      setNotice(`Request for Payment ${rfp?.rfpNo || ""} was deleted.`);
      go({});
      return;
    }
    setNotice(`Request for Payment ${r.data.rfpNo} is now ${STATUS_META[r.data.status]?.label || r.data.status}.`);
    loadDetail();
  }

  // R5: the payload never carries a company - the server uses the RFP's own.
  async function confirmConvert(form) {
    setDialog((d) => ({ ...d, busy: true, error: "" }));
    const r = await api(`/api/rfp/${encodeURIComponent(rfpId)}/convert`, { method: "POST", body: buildConvertPayload(form) });
    if (!r.ok) {
      setDialog((d) => ({ ...d, busy: false, error: errorMessage(r.status, r.data, "The Request for Payment could not be converted.") }));
      return;
    }
    setDialog(null);
    setNotice(`Request for Payment ${r.data.rfpNo} was converted to ${r.data.apv?.status || "Draft"} APV ${r.data.apv?.voucherNo || ""}.`);
    loadDetail();
  }

  // --- render --------------------------------------------------------------

  if (ctx.status === "loading") {
    return <div className="rfp-page"><div className="rfp-state">Loading...</div></div>;
  }
  if (ctx.status === "error") {
    return (
      <div className="rfp-page">
        <h1>Request for Payment</h1>
        <div className="rfp-banner rfp-banner-error" role="alert">
          Unable to load your companies and permissions.{" "}
          <button type="button" className="rfp-link-btn" onClick={loadContext}>Retry</button>
        </div>
      </div>
    );
  }
  if (!canView) {
    return (
      <div className="rfp-page">
        <h1>Request for Payment</h1>
        <div className="rfp-card rfp-state">You do not have permission to view Requests for Payment.</div>
      </div>
    );
  }

  const formOpen = mode === "create" || mode === "edit";

  return (
    <div className="rfp-page">
      <div className="rfp-page-header">
        <div>
          <h1>Request for Payment</h1>
          <p className="rfp-subtle">Requests to pay a supplier. Approval does not post to the books or create an AP voucher.</p>
        </div>
        {mode === "list" && companyId && can("CREATE") ? (
          <button type="button" className="rfp-btn rfp-btn-primary" onClick={() => go({ new: "1" })}>
            + New RFP
          </button>
        ) : null}
        {mode !== "list" ? (
          <button type="button" className="rfp-btn rfp-btn-secondary" onClick={() => go({})} disabled={saving}>
            ← Back to list
          </button>
        ) : null}
      </div>

      <div className="rfp-card rfp-company-bar">
        <label className="rfp-field">
          <span>Company</span>
          {locked ? (
            <div className="rfp-readonly">{company?.name}</div>
          ) : (
            <select id="rfp-company" value={companyId} onChange={(e) => changeCompany(e.target.value)} disabled={(formOpen && Boolean(companyId)) || saving}>
              <option value="">Select a company</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
        </label>
        {!companies.length ? <div className="rfp-subtle">You are not assigned to any company.</div> : null}
        {formOpen && !locked && companyId ? <div className="rfp-subtle">The company cannot be changed while the form is open.</div> : null}
      </div>

      {notice ? (
        <div className="rfp-banner rfp-banner-success" role="status">
          <span>{notice}</span>
          <button type="button" className="rfp-link-btn" onClick={() => setNotice("")} aria-label="Dismiss">Dismiss</button>
        </div>
      ) : null}

      {!companyId ? (
        <div className="rfp-card rfp-state">Select a company to continue.</div>
      ) : mode === "list" ? (
        <div className="rfp-card">
          <div className="rfp-filters">
            <label className="rfp-field">
              <span>Status</span>
              <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
                <option value="">All statuses</option>
                {RFP_STATUSES.map((s) => (
                  <option key={s} value={s}>{STATUS_META[s].label}</option>
                ))}
              </select>
            </label>
            <label className="rfp-field rfp-filter-search">
              <span>Search</span>
              <input
                type="search"
                placeholder="RFP no., supplier, purpose, requester"
                value={filters.search}
                onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
              />
            </label>
            <label className="rfp-field">
              <span>RFP Date From</span>
              <input type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
            </label>
            <label className="rfp-field">
              <span>RFP Date To</span>
              <input type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
            </label>
            {hasActiveFilters(filters) ? (
              <button type="button" className="rfp-btn rfp-btn-secondary rfp-filter-clear" onClick={() => setFilters({ status: "", search: "", from: "", to: "" })}>
                Clear filters
              </button>
            ) : null}
          </div>

          {list.status === "loading" && !list.rows.length ? <div className="rfp-state">Loading RFPs...</div> : null}
          {list.status === "error" ? (
            <div className="rfp-banner rfp-banner-error" role="alert">
              {list.error} <button type="button" className="rfp-link-btn" onClick={loadList}>Retry</button>
            </div>
          ) : null}
          {list.status === "ready" && visibleRows.length === 0 ? (
            <div className="rfp-state">
              No RFPs found.
              {hasActiveFilters(filters) ? <div className="rfp-subtle">Try adjusting your filters.</div> : null}
            </div>
          ) : null}
          {visibleRows.length > 0 && list.status !== "error" ? (
            <div className="rfp-table-wrap">
              <table className="rfp-table rfp-list-table">
                <thead>
                  <tr>
                    <th>RFP No.</th>
                    <th>RFP Date</th>
                    <th>Supplier</th>
                    <th>Purpose</th>
                    <th>Requested Payment</th>
                    <th className="rfp-num">Total</th>
                    <th>Currency</th>
                    {showCompanyColumn ? <th>Company</th> : null}
                    <th>Status</th>
                    <th>Requester</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <button type="button" className="rfp-link-btn rfp-strong" onClick={() => go({ id: String(r.id) })}>
                          {r.rfpNo}
                        </button>
                      </td>
                      <td>{r.rfpDate}</td>
                      <td>{r.supplierName}</td>
                      <td className="rfp-ellipsis" title={r.purpose || ""}>{r.purpose}</td>
                      <td>{r.requestedPaymentDate}</td>
                      <td className="rfp-num">{formatAmount(r.totalAmount)}</td>
                      <td>{r.currencyCode}</td>
                      {showCompanyColumn ? <td>{r.companyName}</td> : null}
                      <td><StatusBadge status={r.status} /></td>
                      <td>{r.requesterUsername}</td>
                      <td>{formatDateTime(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {(filters.search || filters.from || filters.to) && list.status === "ready" ? (
            <p className="rfp-subtle rfp-footnote">Search and date filters narrow the {list.rows.length} RFP(s) loaded for this company.</p>
          ) : null}
        </div>
      ) : mode === "create" ? (
        lookups.status === "ready" ? (
          <RfpForm
            key={`create-${companyId}`}
            mode="create"
            initialForm={emptyForm()}
            lookups={lookups.data}
            companyName={company?.name}
            requesterName={ctx.username}
            saving={saving}
            serverError={formError}
            onSave={save}
            onCancel={() => go({})}
          />
        ) : lookups.status === "error" ? (
          <div className="rfp-banner rfp-banner-error" role="alert">{lookups.error}</div>
        ) : (
          <div className="rfp-card rfp-state">Loading form...</div>
        )
      ) : wrongCompany ? (
        <div className="rfp-card rfp-state">
          This Request for Payment belongs to {wrongCompany.companyName}, not the selected company.
          {!locked && companies.some((c) => String(c.id) === String(wrongCompany.companyId)) ? (
            <div>
              <button type="button" className="rfp-btn rfp-btn-secondary" onClick={() => {
                const id = String(wrongCompany.companyId);
                invalidateAll();
                setDetail({ status: "idle", rfp: null, error: "", code: 0 });
                setCompanyId(id);
              }}>
                Switch to {wrongCompany.companyName}
              </button>
            </div>
          ) : null}
        </div>
      ) : detail.status === "error" ? (
        <div className="rfp-card rfp-state">
          <div className="rfp-banner rfp-banner-error" role="alert">{detail.error}</div>
          <button type="button" className="rfp-btn rfp-btn-secondary" onClick={() => go({})}>Back to list</button>
        </div>
      ) : !rfp ? (
        <div className="rfp-card rfp-state">Loading RFP...</div>
      ) : mode === "edit" ? (
        !actions.edit ? (
          <div className="rfp-card rfp-state">
            Only DRAFT or RETURNED Requests for Payment can be edited by users with edit permission.
            <div><button type="button" className="rfp-btn rfp-btn-secondary" onClick={() => go({ id: rfpId })}>View RFP</button></div>
          </div>
        ) : lookups.status === "ready" ? (
          <RfpForm
            key={`edit-${rfp.id}-${rfp.updatedAt}`}
            mode="edit"
            initialForm={formFromRfp(rfp)}
            lookups={lookups.data}
            companyName={rfp.companyName}
            requesterName={rfp.requesterUsername}
            rfpNo={rfp.rfpNo}
            fallbackSupplier={{ id: rfp.supplierId, name: rfp.supplierName, tin: rfp.supplierTin }}
            returnNote={rfp.status === "RETURNED" ? rfp.decisionNote || "" : undefined}
            saving={saving}
            serverError={formError}
            onSave={save}
            onCancel={() => go({ id: rfpId })}
          />
        ) : lookups.status === "error" ? (
          <div className="rfp-banner rfp-banner-error" role="alert">{lookups.error}</div>
        ) : (
          <div className="rfp-card rfp-state">Loading form...</div>
        )
      ) : (
        <RfpDetail
          rfp={rfp}
          accountsById={accountsById}
          actions={actions}
          history={history}
          apvPath={apvPath}
          onEdit={() => go({ id: rfpId, edit: "1" })}
          onAction={(key) => setDialog({ key, busy: false, error: "" })}
        />
      )}

      {dialog && rfp && dialog.key === "convert" ? (
        <RfpConvertDialog
          key={`convert-${rfp.id}-${lookups.status}`}
          rfp={rfp}
          accounts={lookups.data?.accounts || []}
          accountsStatus={lookups.status}
          accountsError={lookups.error}
          busy={dialog.busy}
          error={dialog.error}
          onConfirm={confirmConvert}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog && rfp && dialog.key !== "convert" ? (
        <RfpActionDialog
          key={dialog.key}
          config={dialog.key === "delete" ? DELETE_DIALOG : WORKFLOW_DIALOGS[dialog.key]}
          rfpNo={rfp.rfpNo}
          busy={dialog.busy}
          error={dialog.error}
          onConfirm={confirmDialog}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
