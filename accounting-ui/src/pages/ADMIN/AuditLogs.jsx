import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import {
  EMPTY_FILTERS,
  EMPTY_VALUE,
  SCOPE_ALL,
  SCOPE_SYSTEM,
  actionTone,
  appendPage,
  buildAuditQuery,
  buildChangeRows,
  companyScope,
  describeEntity,
  errorMessageFor,
  filenameFromDisposition,
  formatScalar,
  formatTimestamp,
  hasActiveFilters,
  humanizeKey,
  readPageHeaders,
} from "../../utils/auditLogQuery.mjs";
import "./AuditLogs.css";

const API_URL = import.meta.env.VITE_API_URL || "";
const PAGE_SIZE = 50;
const TEXT_DEBOUNCE_MS = 500;
// Typed filters are applied after a pause in typing; selects and dates apply at once.
const DEBOUNCED_KEYS = ["q", "module", "action", "entityType"];
const pickText = (f) => Object.fromEntries(DEBOUNCED_KEYS.map((k) => [k, String(f[k] ?? "").trim()]));

// Suggestions only (free text is allowed - the server matches exactly).
const MODULE_SUGGESTIONS = [
  "AUTH", "USERS", "INVITATIONS", "ROLES", "PERMISSION_TEMPLATES", "ACCESS_RESTRICTIONS", "ACCESS_CONTROL",
  "AUDIT_LOGS", "TRANSACTIONS", "TRANSACTIONS.OR", "TRANSACTIONS.INVOICE", "INV", "JV", "PO", "QUOTATION", "PETTY_CASH",
  "BANK_RECON", "ACCOUNTING_PERIODS", "FX_REVALUATION", "RECURRING.TRANSACTIONS", "FILESETUP.CURRENCY_SETUP",
  "FILESETUP.TAX_SETUP", "PRINT.DOCUMENT_TEMPLATES", "TRIAL_BALANCE_CHECKER", "GL_BEGINNING", "BEGINNING_BALANCE_IMPORT",
];
const ACTION_SUGGESTIONS = [
  "CREATE", "EDIT", "UPDATE", "DELETE", "POST", "VOID", "CANCEL", "REVERSE", "LOGIN_SUCCESS", "LOGIN_FAILURE",
  "ACCESS_DENIED", "ACCESS_UPDATED", "USER_ACTIVATED", "USER_DEACTIVATED", "USER_SUSPENDED", "USER_UNLOCKED",
  "SESSION_REVOKED", "USER_INVITED", "INVITATION_ACCEPTED", "INVITATION_REVOKED", "PERMISSION_CHANGED",
  "TEMPLATE_CREATED", "TEMPLATE_UPDATED", "TEMPLATE_DELETED", "TEMPLATE_APPLIED", "RESTRICTION_ADDED",
  "RESTRICTION_REMOVED", "MATCH", "UNMATCH", "FINALIZE", "REOPEN", "EXPORT",
];

function ScopeBadge({ row }) {
  return row.companyId ? (
    <span className="al-badge al-scope-company">Company</span>
  ) : (
    <span className="al-badge al-scope-system">System</span>
  );
}

function ActionBadge({ action }) {
  return <span className={`al-badge al-action al-tone-${actionTone(action)}`}>{action || EMPTY_VALUE}</span>;
}

function CompanyCell({ row }) {
  return (
    <div className="al-company-cell">
      <span>{row.companyId ? row.companyName || `Company #${row.companyId}` : "System"}</span>
      <ScopeBadge row={row} />
    </div>
  );
}

function ChangesTable({ beforeData, afterData }) {
  const { rows, changedCount, truncated } = useMemo(() => buildChangeRows(beforeData, afterData), [beforeData, afterData]);
  if (rows.length === 0) return <p className="al-muted">No before/after data recorded for this event.</p>;
  return (
    <>
      <p className="al-muted al-changes-summary">
        {changedCount > 0 ? `${changedCount} field${changedCount === 1 ? "" : "s"} changed` : "No field differences"}
        {truncated ? " · showing the first entries only" : ""}
      </p>
      <div className="al-changes-wrap">
        <table className="al-changes">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.path || "value"} className={r.changed ? "al-changed" : ""}>
                <th scope="row">{r.label}</th>
                <td>{r.before}</td>
                <td>{r.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function DetailDrawer({ state, onClose, onRetry }) {
  const closeRef = useRef(null);
  useEffect(() => {
    if (!state.open) return undefined;
    closeRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.open, onClose]);

  if (!state.open) return null;
  const log = state.data;
  const fields = log
    ? [
        ["Date / Time", formatTimestamp(log.createdAt)],
        ["User", log.userId ? `#${log.userId}` : EMPTY_VALUE],
        ["Username", formatScalar(log.username)],
        ["Company", log.companyId ? log.companyName || `Company #${log.companyId}` : "System"],
        ["Scope", log.companyId ? "Company event" : "System event"],
        ["Module", formatScalar(log.module)],
        ["Action", formatScalar(log.action)],
        ["Entity Type", log.entityType ? humanizeKey(log.entityType) : EMPTY_VALUE],
        ["Entity ID", formatScalar(log.entityId)],
        ["Description", formatScalar(log.description)],
        ["IP Address", formatScalar(log.ipAddress)],
        ["User Agent", formatScalar(log.userAgent)],
      ]
    : [];

  return (
    <div className="al-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="al-drawer" role="dialog" aria-modal="true" aria-labelledby="al-drawer-title">
        <div className="al-drawer-header">
          <div>
            <h2 id="al-drawer-title">Audit Record</h2>
            {log && <p className="al-muted">#{log.id}</p>}
          </div>
          <button type="button" ref={closeRef} className="al-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="al-drawer-body">
          {state.loading && <p className="al-muted">Loading audit record...</p>}
          {state.error && (
            <div className="al-error-banner" role="alert">
              <span>{state.error}</span>
              {state.retryable && (
                <button type="button" className="al-btn" onClick={onRetry}>Retry</button>
              )}
            </div>
          )}
          {log && (
            <>
              <div className="al-badges-row">
                <ActionBadge action={log.action} />
                <ScopeBadge row={log} />
              </div>
              <dl className="al-fields">
                {fields.map(([label, value]) => (
                  <div key={label} className="al-field">
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <h3 className="al-section-title">Changes</h3>
              <ChangesTable beforeData={log.beforeData} afterData={log.afterData} />
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

export default function AuditLogs() {
  const [access, setAccess] = useState({ status: "loading", isSuperAdmin: false, canListUsers: false });
  const [companies, setCompanies] = useState([]);
  const [users, setUsers] = useState([]);

  const [filters, setFilters] = useState({ ...EMPTY_FILTERS });
  const [debouncedText, setDebouncedText] = useState(pickText(EMPTY_FILTERS));

  const [rows, setRows] = useState([]);
  const [page, setPage] = useState({ nextCursor: null, hasMore: false });
  const [listState, setListState] = useState({ status: "idle", error: null, retryable: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState("");

  const [detail, setDetail] = useState({ open: false, id: null, loading: false, data: null, error: null, retryable: false });
  const detailCache = useRef(new Map());

  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState(null);

  // Every list request gets a sequence number; responses for an older
  // filter set are dropped so rows from different filters never mix.
  const requestSeq = useRef(0);

  // ---- access + lookups ----
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/me/permissions`, { headers: authHeaders() });
        if (handleAuthError(res.status)) return;
        const data = await res.json().catch(() => null);
        if (!res.ok || !data) {
          setAccess({ status: "error", isSuperAdmin: false, canListUsers: false });
          return;
        }
        const granted = (key, action) => data.permissions?.some((p) => p.moduleKey === key && p.action === action && p.granted);
        const isSuperAdmin = data.user?.roleCode === "SUPER_ADMIN";
        if (!granted("ADMIN.AUDIT_LOGS", "VIEW")) {
          setAccess({ status: "denied", isSuperAdmin, canListUsers: false });
          return;
        }
        setAccess({ status: "ready", isSuperAdmin, canListUsers: granted("ADMIN.USER_SETTINGS", "VIEW") });
      } catch (err) {
        console.error("AUDIT LOGS ACCESS CHECK ERROR:", err?.message || "network error");
        setAccess({ status: "error", isSuperAdmin: false, canListUsers: false });
      }
    })();
  }, []);

  useEffect(() => {
    if (access.status !== "ready") return;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/companies`, { headers: authHeaders() });
        const data = await res.json().catch(() => null);
        if (res.ok && Array.isArray(data)) setCompanies(data);
      } catch {
        // The scope selector still offers All (server-scoped) without a list.
      }
      if (!access.canListUsers) return;
      try {
        const res = await fetch(`${API_URL}/api/users`, { headers: authHeaders() });
        const data = await res.json().catch(() => null);
        if (res.ok && Array.isArray(data)) setUsers(data);
      } catch {
        // User filter is optional; search still matches usernames.
      }
    })();
  }, [access.status, access.canListUsers]);

  // ---- text-filter debounce ----
  useEffect(() => {
    const next = pickText(filters);
    const t = setTimeout(() => {
      setDebouncedText((prev) => (DEBOUNCED_KEYS.every((k) => prev[k] === next[k]) ? prev : next));
    }, TEXT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [filters.q, filters.module, filters.action, filters.entityType]);

  const appliedFilters = useMemo(() => ({ ...filters, ...debouncedText }), [filters, debouncedText]);
  const queryString = useMemo(
    () => buildAuditQuery(appliedFilters, { isSuperAdmin: access.isSuperAdmin }),
    [appliedFilters, access.isSuperAdmin]
  );

  // ---- list ----
  const fetchPage = useCallback(
    async (cursor) => {
      const qs = buildAuditQuery(appliedFilters, { isSuperAdmin: access.isSuperAdmin, cursor, limit: PAGE_SIZE });
      const res = await fetch(`${API_URL}/api/audit-logs?${qs}`, { headers: authHeaders() });
      if (handleAuthError(res.status)) return { aborted: true };
      const data = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(data)) {
        const status = res.status;
        return { error: errorMessageFor(status, { serverMessage: data?.message }), retryable: status >= 500 };
      }
      return { items: data, ...readPageHeaders(res.headers) };
    },
    [appliedFilters, access.isSuperAdmin]
  );

  const loadFirstPage = useCallback(async () => {
    const seq = ++requestSeq.current;
    setListState({ status: "loading", error: null, retryable: false });
    setRows([]);
    setPage({ nextCursor: null, hasMore: false });
    setLoadMoreError("");
    try {
      const result = await fetchPage(null);
      if (seq !== requestSeq.current || result.aborted) return;
      if (result.error) {
        setListState({ status: "error", error: result.error, retryable: result.retryable });
        return;
      }
      setRows(result.items);
      setPage({ nextCursor: result.nextCursor, hasMore: result.hasMore });
      setListState({ status: "ready", error: null, retryable: false });
    } catch (err) {
      if (seq !== requestSeq.current) return;
      console.error("AUDIT LOGS LOAD ERROR:", err?.message || "network error");
      setListState({ status: "error", error: errorMessageFor(0), retryable: true });
    }
  }, [fetchPage]);

  useEffect(() => {
    if (access.status === "ready") loadFirstPage();
  }, [access.status, queryString, loadFirstPage]);

  async function loadMore() {
    if (!page.hasMore || !page.nextCursor || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    setLoadMoreError("");
    try {
      const result = await fetchPage(page.nextCursor);
      if (seq !== requestSeq.current || result.aborted) return;
      if (result.error) {
        setLoadMoreError(result.error);
        return;
      }
      setRows((prev) => appendPage(prev, result.items));
      setPage({ nextCursor: result.nextCursor, hasMore: result.hasMore });
    } catch (err) {
      if (seq === requestSeq.current) setLoadMoreError(errorMessageFor(0));
      console.error("AUDIT LOGS LOAD MORE ERROR:", err?.message || "network error");
    } finally {
      if (seq === requestSeq.current) setLoadingMore(false);
    }
  }

  // ---- detail ----
  const openDetail = useCallback(async (id) => {
    if (detailCache.current.has(id)) {
      setDetail({ open: true, id, loading: false, data: detailCache.current.get(id), error: null, retryable: false });
      return;
    }
    setDetail({ open: true, id, loading: true, data: null, error: null, retryable: false });
    try {
      const res = await fetch(`${API_URL}/api/audit-logs/${encodeURIComponent(id)}`, { headers: authHeaders() });
      if (handleAuthError(res.status)) return;
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        setDetail({ open: true, id, loading: false, data: null, error: errorMessageFor(res.status, { detail: true, serverMessage: data?.message }), retryable: res.status >= 500 });
        return;
      }
      detailCache.current.set(id, data);
      setDetail({ open: true, id, loading: false, data, error: null, retryable: false });
    } catch (err) {
      console.error("AUDIT LOG DETAIL ERROR:", err?.message || "network error");
      setDetail({ open: true, id, loading: false, data: null, error: errorMessageFor(0), retryable: true });
    }
  }, []);

  const closeDetail = useCallback(() => setDetail((d) => ({ ...d, open: false })), []);

  // ---- export (server-side, same filters) ----
  async function exportCsv() {
    setExporting(true);
    setExportNotice(null);
    try {
      const res = await fetch(`${API_URL}/api/audit-logs/export?${queryString}`, { headers: authHeaders() });
      if (handleAuthError(res.status)) return;
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setExportNotice({ tone: "error", text: errorMessageFor(res.status, { serverMessage: data?.message }) });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameFromDisposition(res.headers.get("Content-Disposition"));
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const truncated = res.headers.get("X-Export-Truncated") === "true";
      const max = res.headers.get("X-Export-Max-Rows");
      setExportNotice(
        truncated
          ? { tone: "warning", text: `Export downloaded. It was limited to the newest ${max} records - narrow the filters to export the rest.` }
          : { tone: "success", text: "Export downloaded." }
      );
    } catch (err) {
      console.error("AUDIT LOGS EXPORT ERROR:", err?.message || "network error");
      setExportNotice({ tone: "error", text: errorMessageFor(0) });
    } finally {
      setExporting(false);
    }
  }

  function setFilter(key, value) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  function clearFilters() {
    setFilters({ ...EMPTY_FILTERS });
    setDebouncedText(pickText(EMPTY_FILTERS));
  }

  // ---- render ----
  if (access.status === "loading") {
    return <div className="al-page"><p className="al-muted">Loading...</p></div>;
  }
  if (access.status === "denied" || access.status === "error") {
    return (
      <div className="al-page">
        <h1>Audit Logs</h1>
        <div className="al-card">
          <div className="al-error-banner" role="alert">
            {access.status === "denied"
              ? "You do not have permission to view audit logs."
              : "Unable to check your access to audit logs. Please refresh the page."}
          </div>
        </div>
      </div>
    );
  }

  const filtersActive = hasActiveFilters(filters);

  return (
    <div className="al-page">
      <div className="al-header">
        <div>
          <h1>Audit Logs</h1>
          <p className="al-intro">
            A record of system and user activity: who did what, when, and in which company.
            {access.isSuperAdmin ? " System events (sign-ins, users, roles, invitations) are visible to Super Admins only." : ""}
          </p>
        </div>
        <button type="button" className="al-btn al-btn-primary" onClick={exportCsv} disabled={exporting || listState.status === "loading"}>
          {exporting ? "Exporting..." : "Export CSV"}
        </button>
      </div>

      <div className="al-card">
        <div className="al-toolbar" role="search">
          <label className="al-control al-control-wide">
            <span>Search</span>
            <input type="search" value={filters.q} placeholder="Description, user, action, module..." maxLength={100} onChange={(e) => setFilter("q", e.target.value)} />
          </label>
          <label className="al-control">
            <span>{access.isSuperAdmin ? "Scope" : "Company"}</span>
            <select value={filters.scope} onChange={(e) => setFilter("scope", e.target.value)}>
              <option value={SCOPE_ALL}>{access.isSuperAdmin ? "All Companies" : "All my companies"}</option>
              {access.isSuperAdmin && <option value={SCOPE_SYSTEM}>System Events</option>}
              {companies.map((c) => (
                <option key={c.id} value={companyScope(c.id)}>{c.name}</option>
              ))}
            </select>
          </label>
          <label className="al-control">
            <span>Date From</span>
            <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter("from", e.target.value)} />
          </label>
          <label className="al-control">
            <span>Date To</span>
            <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter("to", e.target.value)} />
          </label>
          {access.canListUsers && (
            <label className="al-control">
              <span>User</span>
              <select value={filters.userId} onChange={(e) => setFilter("userId", e.target.value)}>
                <option value="">All users</option>
                {users.map((u) => (
                  <option key={u.id} value={String(u.id)}>{(u.full_name || "").trim() || u.username}</option>
                ))}
              </select>
            </label>
          )}
          <label className="al-control">
            <span>Module</span>
            <input list="al-module-options" value={filters.module} placeholder="Any" maxLength={30} onChange={(e) => setFilter("module", e.target.value.toUpperCase())} />
          </label>
          <label className="al-control">
            <span>Action</span>
            <input list="al-action-options" value={filters.action} placeholder="Any" maxLength={40} onChange={(e) => setFilter("action", e.target.value.toUpperCase())} />
          </label>
          <label className="al-control">
            <span>Entity Type</span>
            <input value={filters.entityType} placeholder="Any" maxLength={40} onChange={(e) => setFilter("entityType", e.target.value.toUpperCase())} />
          </label>
          <div className="al-toolbar-actions">
            <button type="button" className="al-btn" onClick={clearFilters} disabled={!filtersActive}>Clear Filters</button>
          </div>
          <datalist id="al-module-options">{MODULE_SUGGESTIONS.map((m) => <option key={m} value={m} />)}</datalist>
          <datalist id="al-action-options">{ACTION_SUGGESTIONS.map((a) => <option key={a} value={a} />)}</datalist>
        </div>

        {exportNotice && (
          <div className={`al-notice al-notice-${exportNotice.tone}`} role={exportNotice.tone === "error" ? "alert" : "status"}>
            {exportNotice.text}
          </div>
        )}

        {listState.status === "loading" && <p className="al-muted al-state" aria-live="polite">Loading audit records...</p>}

        {listState.status === "error" && (
          <div className="al-error-banner al-state" role="alert">
            <span>{listState.error}</span>
            {listState.retryable && <button type="button" className="al-btn" onClick={loadFirstPage}>Retry</button>}
          </div>
        )}

        {listState.status === "ready" && rows.length === 0 && (
          <div className="al-empty al-state">
            <p>No audit records found.</p>
            {filtersActive && <p className="al-muted">Try adjusting your filters.</p>}
          </div>
        )}

        {listState.status === "ready" && rows.length > 0 && (
          <>
            <div className="al-table-wrap">
              <table className="al-table">
                <thead>
                  <tr>
                    <th scope="col">Date / Time</th>
                    <th scope="col">User</th>
                    <th scope="col">Company</th>
                    <th scope="col">Module</th>
                    <th scope="col">Action</th>
                    <th scope="col">Entity</th>
                    <th scope="col">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className={detail.open && detail.id === row.id ? "al-row-selected" : ""}
                      tabIndex={0}
                      onClick={() => openDetail(row.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openDetail(row.id);
                        }
                      }}
                      aria-label={`Audit record ${row.id}: ${row.action}`}
                    >
                      <td className="al-nowrap">{formatTimestamp(row.createdAt)}</td>
                      <td>{formatScalar(row.username)}</td>
                      <td><CompanyCell row={row} /></td>
                      <td className="al-nowrap">{formatScalar(row.module)}</td>
                      <td><ActionBadge action={row.action} /></td>
                      <td className="al-nowrap">{describeEntity(row.entityType, row.entityId)}</td>
                      <td className="al-description">{formatScalar(row.description)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="al-footer">
              <span className="al-muted">{rows.length} record{rows.length === 1 ? "" : "s"} shown</span>
              {loadMoreError && <span className="al-inline-error" role="alert">{loadMoreError}</span>}
              {page.hasMore && (
                <button type="button" className="al-btn" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "Loading..." : "Load More"}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <DetailDrawer state={detail} onClose={closeDetail} onRetry={() => { detailCache.current.delete(detail.id); openDetail(detail.id); }} />
    </div>
  );
}
