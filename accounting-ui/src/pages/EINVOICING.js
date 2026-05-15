import { requireAnyRole } from './authClient.js';

'use strict';

/* ===================== NAVBAR WAIT HELPER ===================== */
async function waitNavbar() {
  if (window.navbarReady) {
    try { await window.navbarReady; } catch {}
  }
}

/* -------------------- 0. DEBUG & DOM HELPERS -------------------- */
const DBG = {
  log: (...args) => console.log('[E-INVOICING]', ...args),
  warn: (...args) => console.warn('[E-INVOICING]', ...args),
  error: (...args) => console.error('[E-INVOICING]', ...args)
};

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
const safeSetValue = (selector, value) => { const el = $(selector); if (el) el.value = value; };
const safeSetText = (selector, text) => { const el = $(selector); if (el) el.textContent = text; };

/* -------------------- 1. UTILITIES -------------------- */
function dateToYYYYMMDD(dateValue) {
  if (!dateValue) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return dateValue;
  const d = new Date(dateValue);
  if (isNaN(d.getTime())) return "";
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getInputValue(name) {
  const el = document.querySelector(`input[name="${name}"], select[name="${name}"]`) || document.getElementById(name);
  if (!el) return '';
  return el.type === 'checkbox' ? el.checked : el.value;
}

function setInputValue(name, value) {
  const el = document.querySelector(`input[name="${name}"], select[name="${name}"]`) || document.getElementById(name);
  if (!el) return;
  el.type === 'checkbox' ? el.checked = !!value : ('value' in el ? el.value = value : el.textContent = value);
}

/* ✅ URL helpers */
function getUrlParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}
function setUrlParam(name, value) {
  const url = new URL(window.location.href);
  if (value === null || value === undefined || value === '') url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  window.history.replaceState({}, '', url.toString());
}

/* ===================== RBAC APPROVAL UI (Injected actions) ===================== */
window.addEventListener('DOMContentLoaded', async () => {
  await waitNavbar();

  const approveDropdown = document.querySelector('.dropdown[data-dropdown]');
  if (!approveDropdown) return;

  try {
    const meRes = await fetch('/auth/me', { credentials: 'include' });
    if (!meRes.ok) return approveDropdown.remove();

    const { user } = await meRes.json();
    if (!user) return approveDropdown.remove();

    const params = new URLSearchParams(window.location.search);
    const invoiceNo = params.get('invoice_no');
    if (!invoiceNo) return approveDropdown.remove();

    const invRes = await fetch(`/api/invoices/${invoiceNo}`);
    if (!invRes.ok) return approveDropdown.remove();

    const invoice = await invRes.json();

    const canApprove =
      user.permissions?.includes('invoice_approve') &&
      invoice.status === 'pending' &&
      invoice.created_by !== user.id;

    if (!canApprove) approveDropdown.remove();
  } catch (err) {
    console.error('RBAC approve UI error:', err);
    approveDropdown.remove();
  }
});

/* -------------------- EXCHANGE RATE FETCHING -------------------- */
const currencySelect = document.getElementById('currency');
const exchangeRateInput = document.getElementById('exchangeRate');

/* -------------------- EWT LIST -------------------- */
window._ewtList = [];

async function loadEWTList() {
  try {
    const res = await fetch('/api/ewt');
    if (!res.ok) throw new Error('Failed to fetch EWT list');
    const data = await res.json();

    window._ewtList = (data || []).map(e => ({
      id: Number(e.id),
      code: e.code,
      tax_rate: Number(e.tax_rate)
    }));
  } catch (err) {
    DBG.warn('Failed to load EWT list:', err);
    window._ewtList = [];
  }
}

function getEWTLabelById(id) {
  const e = window._ewtList?.find(x => Number(x.id) === Number(id));
  return e ? `${e.code} (${e.tax_rate}%)` : '';
}

if (currencySelect && exchangeRateInput) {
  async function updateExchangeRate() {
    const currency = String(currencySelect.value || '').toUpperCase();

    if (currency === 'PHP') {
      exchangeRateInput.value = 1;
      calculateTotals();
      return;
    }

    try {
      const res = await fetch(`/api/exchange-rate?to=${currency}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to fetch exchange rate');
      }

      const data = await res.json();
      const rate = parseFloat(data.rate);

      if (!rate || isNaN(rate)) throw new Error('Invalid exchange rate received');

      exchangeRateInput.value = rate.toFixed(4);
      calculateTotals();
    } catch (err) {
      console.error('Exchange rate error:', err);
      alert(`Failed to fetch exchange rate for ${currency}. Using fallback rate if available.`);
      exchangeRateInput.value = 1;
      calculateTotals();
    }
  }

  currencySelect.addEventListener('change', updateExchangeRate);
  updateExchangeRate();
}

/* -------------------- AUTO-RESIZE TEXTAREA -------------------- */
const textarea = document.getElementById('address');
if (textarea) {
  function autoResizeTextarea(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  textarea.addEventListener('input', () => autoResizeTextarea(textarea));
  window.addEventListener('load', () => autoResizeTextarea(textarea));
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function bindAutoResizeForAllItemDescs(ctx = document) {
  const list = ctx.querySelectorAll('.item-desc');
  list.forEach(t => {
    if (t.dataset.autoresizeBound === '1') return;

    autoResize(t);
    t.addEventListener('input', () => autoResize(t));
    t.dataset.autoresizeBound = '1';
  });
}

bindAutoResizeForAllItemDescs(document);

/* ===================== ✅ RECURRING HEADER UI ===================== */
function initRecurringHeaderUI() {
  const standard = document.getElementById('standardHeaderDates');
  const recurring = document.getElementById('recurringHeaderSettings');
  const modeInput = document.getElementById('invoiceMode');

  const startEl = document.getElementById('recurrenceStart');
  const endEl = document.getElementById('recurrenceEnd');
  const statusEl = document.getElementById('recurrenceStatus');
  const switchBtn = document.getElementById('switchToStandardBtn');

  if (!standard || !recurring || !modeInput) {
    DBG.warn('Recurring header UI missing elements (check invoice.html IDs)');
    return;
  }

  function showRecurring() {
    standard.style.display = 'none';
    recurring.style.display = 'block';
    modeInput.value = 'recurring';

    const invDate = document.getElementsByName('date')[0]?.value;
    const today = new Date().toISOString().split('T')[0];

    if (startEl && !startEl.value) startEl.value = invDate || today;
    if (statusEl && !statusEl.value) statusEl.value = 'active';

    setUrlParam('invoiceMode', 'recurring');
  }

  function showStandard() {
    standard.style.display = 'flex';
    recurring.style.display = 'none';
    modeInput.value = 'standard';

    if (startEl) startEl.value = '';
    if (endEl) endEl.value = '';
    if (statusEl) statusEl.value = 'active';

    setUrlParam('invoiceMode', 'standard');
  }

  const urlMode = (getUrlParam('invoiceMode') || 'standard').toLowerCase();
  if (urlMode === 'recurring') showRecurring();
  else showStandard();

  if (switchBtn && !switchBtn.dataset.bound) {
    switchBtn.addEventListener('click', () => showStandard());
    switchBtn.dataset.bound = '1';
  }

  const invoiceDateEl = document.getElementsByName('date')[0];
  if (invoiceDateEl && startEl) {
    invoiceDateEl.addEventListener('change', () => {
      const modeNow = (getUrlParam('invoiceMode') || modeInput.value || 'standard').toLowerCase();
      if (modeNow !== 'recurring') return;
      if (!startEl.value) startEl.value = invoiceDateEl.value || '';
    });
  }

  window.__setInvoiceModeUI__ = (m) => (String(m).toLowerCase() === 'recurring' ? showRecurring() : showStandard());
}

/* -------------------- 2. COMPANY INFO -------------------- */
async function loadCompanyInfo() {
  try {
    const res = await fetch('/api/company-info/');
    if (!res.ok) return;
    const company = await res.json();
    if (!company) return;

    safeSetValue('input[name="billTo"]', company.company_name || '');
    safeSetValue('input[name="address"]', company.company_address || '');
    safeSetValue('input[name="tin"]', company.vat_tin || '');
    safeSetText('#company-name', company.company_name || '');
    safeSetText('#company-address', company.company_address || '');
    safeSetText('#company-tel', company.tel_no || '');
    safeSetText('#company-tin', company.vat_tin || '');

    const logoEl = $('#invoice-logo');
    const previewLogoEl = $('#uploaded-logo');
    const removeBtn = $('#remove-logo-btn');

    if (company.logo_path) {
      if (logoEl) logoEl.src = company.logo_path;
      if (previewLogoEl) { previewLogoEl.src = company.logo_path; previewLogoEl.style.display = 'block'; }
      if (removeBtn) removeBtn.style.display = 'inline-block';
    } else {
      if (previewLogoEl) previewLogoEl.style.display = 'none';
      if (removeBtn) removeBtn.style.display = 'none';
    }
  } catch (err) {
    DBG.warn('Failed to load company info:', err);
  }
}

/* -------------------- 3. NEXT INVOICE NO -------------------- */
window.__NUMBERING_MODE__ = 'auto';

async function loadNextInvoiceNo() {
  try {
    const params = new URLSearchParams(window.location.search);
    const isEdit = params.get('edit') === 'true' || params.get('invoice_no');

    if (isEdit) return;

    const res = await fetch('/api/next-invoice-no', { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to fetch next invoice number');

    const data = await res.json();

    const invoiceInput =
      document.querySelector('input[name="invoiceNo"]') ||
      document.getElementById('invoice_no');

    if (!invoiceInput) return;

    const mode = String(data.mode || 'auto').toLowerCase();
    window.__NUMBERING_MODE__ = mode;

    if (mode === 'manual') {
      invoiceInput.value = '';
      invoiceInput.readOnly = false;
      invoiceInput.classList.remove('locked');
      invoiceInput.placeholder = 'Enter invoice number';
    } else {
      invoiceInput.value = data.invoiceNo || '';
      invoiceInput.readOnly = true;
      invoiceInput.classList.add('locked');
    }
  } catch (err) {
    console.error('Failed to fetch next invoice number', err);
  }
}

/* -------------------- 4. INVOICE TITLE -------------------- */
function setInvoiceTitleFromURL() {
  const params = new URLSearchParams(window.location.search);
  const type = params.get('type');
  const typeMap = {
    sales: 'SALES INVOICE',
    commercial: 'COMMERCIAL INVOICE',
    credit: 'CREDIT MEMO',
    debit: 'DEBIT MEMO'
  };
  const invoiceTitle = typeMap[type] || 'SERVICE INVOICE';

  safeSetText('.invoice-title', invoiceTitle);

  const invoiceTypeInput = document.getElementById('invoice_type');
  if (invoiceTypeInput) invoiceTypeInput.value = invoiceTitle;

  localStorage.setItem('selectedInvoiceType', invoiceTitle);
}

/* -------------------- 5. LOAD INVOICE FOR EDIT -------------------- */
async function loadInvoiceForEdit() {
  const params = new URLSearchParams(window.location.search);
  const invoiceNo = params.get('invoice_no');
  const isEdit = params.get('edit') === 'true';
  if (!invoiceNo || !isEdit) return;

  window.__NUMBERING_MODE__ = 'manual';

  try {
    const res = await fetch(`/api/invoices/${encodeURIComponent(invoiceNo)}`);
    if (!res.ok) throw new Error('Failed to fetch invoice');
    const data = await res.json();

    setInputValue('billTo', data.bill_to || '');
    setInputValue('address', data.address || '');
    setInputValue('tin', data.tin || '');
    setInputValue('terms', data.terms || '');
    setInputValue('invoiceNo', data.invoice_no || '');

    const invEl = document.querySelector('input[name="invoiceNo"]');
    if (invEl) {
      invEl.readOnly = true;
      invEl.classList.add('locked');
    }

    setInputValue('date', dateToYYYYMMDD(data.date));
    setInputValue('invoiceMode', data.invoice_mode || 'standard');
    setInputValue('invoiceCategory', data.invoice_category || 'service');
    safeSetText('.invoice-title', data.invoice_title || 'SERVICE INVOICE');
    setInputValue('vatType', data.vat_type || 'inclusive');

    // ✅ reflect recurring/standard header UI
    if (window.__setInvoiceModeUI__) window.__setInvoiceModeUI__(data.invoice_mode || 'standard');

    // ✅ if recurring, populate settings fields
    if ((data.invoice_mode || '').toLowerCase() === 'recurring') {
      const startEl = document.getElementById('recurrenceStart');
      const endEl = document.getElementById('recurrenceEnd');
      const statusEl = document.getElementById('recurrenceStatus');

      if (startEl) startEl.value = dateToYYYYMMDD(data.recurrence_start_date);
      if (endEl) endEl.value = dateToYYYYMMDD(data.recurrence_end_date);
      if (statusEl) statusEl.value = (data.recurrence_status || 'active').toLowerCase();
    }

    // Header
const theadRow = $("#items-table thead tr");
if (theadRow) {
  theadRow.innerHTML = `
    <th>DESCRIPTION</th>
    <th>ACCOUNT</th>
    <th>QTY</th>
    <th>RATE</th>
    <th>AMOUNT</th>
  `;

  // ✅ IMPORTANT: always store the real key in data-colkey
  (data.extra_columns || []).forEach(col => {
    const colKey = String(col || '')
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/g, "_");

    const th = document.createElement("th");
    th.textContent = colKey.replace(/_/g, " ").toUpperCase();
    th.setAttribute("data-colkey", colKey); // ✅ this makes remove work in edit mode
    theadRow.appendChild(th);
  });
}

    // Body
    const tbody = $("#items-body");
    if (tbody) {
      tbody.innerHTML = "";
      (data.items || []).forEach(item => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>
            <textarea class="input-full item-desc" name="desc[]" rows="2"
  style="overflow:hidden; resize:vertical; white-space:pre-wrap;"></textarea>
          </td>

          <td class="Acc-col" style="position:relative;">
            <input type="text"
                   name="account[]"
                   class="input-full account-input"
                   placeholder="+ Create New Account"
                   autocomplete="off">

            <div class="account-dropdown"
                 style="display:none; position:absolute; background:white; border:1px solid #ccc;
                        max-height:150px; overflow:auto; z-index:999;"></div>

            <div style="margin-top:6px;">
              ${buildEWTSelectHTML(item.ewt_id ? String(item.ewt_id) : '')}
            </div>
          </td>

          <td>
            <input type="number" class="input-short" name="qty[]"
                   value="${item.quantity || 0}" oninput="updateAmount(this)">
          </td>

          <td>
            <input type="number" class="input-short" name="rate[]"
                   value="${item.unit_price || 0}" oninput="updateAmount(this)">
          </td>

          <td>
            <input type="number" class="input-short" name="amt[]"
                   value="${item.amount || 0}" readonly>
          </td>
        `;
row.querySelector('.item-desc').value = item.description || '';
        (data.extra_columns || []).forEach(col => {
          const td = document.createElement("td");
          td.innerHTML = `<input type="text" name="${col}[]" value="${item[col] || ""}">`;
          row.appendChild(td);
        });

        tbody.appendChild(row);
      });
bindAutoResizeForAllItemDescs(tbody);

      const inputs = $$('input.account-input', tbody);

      inputs.forEach((input, idx) => {
        if (!input.dataset.initialized && window._coaAccounts) {
          setupAccountCombo(input, window._coaAccounts);
          input.dataset.initialized = 'true';
        }

        const item = (data.items || [])[idx];
        if (!item || !window._coaAccounts) return;

        const acc = window._coaAccounts.find(a => String(a.id) === String(item.account_id));
        if (!acc) return;

        input.value = `${acc.code || ''} - ${acc.title || ''}`.trim();
        input.dataset.accountId = String(acc.id);

        const row = input.closest('tr');
        const ewtSel = row?.querySelector('.ewt-select');
        if (ewtSel) {
          const override = item.ewt_id ? String(item.ewt_id) : '';
          const def = acc.ewt_id ? String(acc.ewt_id) : '';
          ewtSel.value = override || def || '';
        }
      });
    }

    if (data.tax_summary) {
      const ts = data.tax_summary || {};
      window.__DISCOUNT_AMOUNT__ = Number(ts.discount || 0);
      safeSetText('#discountAmountDisplay', Number(ts.discount || 0).toFixed(2));
      safeSetValue('#vatableSales', ts.vatable_sales || 0);
      safeSetValue('#vatAmount', ts.vat_amount || 0);
      safeSetValue('#totalPayable', ts.total_payable || 0);
    }

    adjustColumnWidths();
  } catch (err) {
    DBG.error('Error loading invoice for edit:', err);
  }
}

/* -------------------- EWT HELPERS -------------------- */
function buildEWTSelectHTML(selectedId = '') {
  const sel = selectedId ? String(selectedId) : '';
  const opts = (window._ewtList || [])
    .map(e => {
      const id = String(e.id);
      return `<option value="${id}" ${id === sel ? 'selected' : ''}>${e.code} (${e.tax_rate}%)</option>`;
    })
    .join('');

  return `
    <select class="input-short ewt-select" name="ewt_id[]">
      <option value="">Default</option>
      ${opts}
    </select>
  `;
}

function ensureEWTOnExistingRows() {
  const rows = document.querySelectorAll('#items-body tr');

  rows.forEach(row => {
    const accCell = row.querySelector('td.Acc-col');
    if (!accCell) return;
    if (row.querySelector('.ewt-select')) return;

    const holder = document.createElement('div');
    holder.style.marginTop = '6px';
    holder.innerHTML = buildEWTSelectHTML();
    accCell.appendChild(holder);
  });
}

function refreshAllEWTSelects() {
  document.querySelectorAll('.ewt-select').forEach(sel => {
    const current = sel.value;
    sel.innerHTML = `<option value="">Default</option>` + (window._ewtList || [])
      .map(e => `<option value="${e.id}">${e.code} (${e.tax_rate}%)</option>`)
      .join('');
    sel.value = current;
  });
}

/* -------------------- 6. CHART OF ACCOUNTS -------------------- */
async function loadAccounts() {
  try {
    const res = await fetch('/api/coa');
    if (!res.ok) throw new Error('Failed to fetch accounts');
    const accounts = await res.json();
    window._coaAccounts = accounts;

    $$('input.account-input').forEach(input => {
      if (!input.dataset.initialized) {
        setupAccountCombo(input, accounts);
        input.dataset.initialized = true;
      }
    });
  } catch (err) {
    DBG.error('loadAccounts error:', err);
  }
}

function setupAccountCombo(input, accounts) {
  const dropdown = input.nextElementSibling;
  if (!dropdown) return;

  dropdown.innerHTML = '';

  (accounts || []).forEach(acc => {
    if (!acc || !acc.title) return;

    const div = document.createElement('div');
    const ewtLabel = acc.ewt_id ? getEWTLabelById(acc.ewt_id) : '';

    div.textContent = `${acc.code || ''} - ${acc.title}${ewtLabel ? ` | EWT: ${ewtLabel}` : ''}`;
    div.dataset.value = String(acc.id);
    div.style.padding = '6px 10px';
    div.style.cursor = 'pointer';

    div.addEventListener('mousedown', (e) => {
      e.preventDefault();

      input.value = `${acc.code || ''} - ${acc.title}`.trim();
      input.dataset.accountId = String(acc.id);

      const row = input.closest('tr');
      const ewtSel = row?.querySelector('.ewt-select');
      if (ewtSel && !ewtSel.value) {
        ewtSel.value = acc.ewt_id ? String(acc.ewt_id) : '';
      }

      dropdown.style.display = 'none';
      calculateTotals?.();
    });

    dropdown.appendChild(div);
  });

  input.addEventListener('input', () => {
    const val = (input.value || '').toLowerCase().trim();
    const items = Array.from(dropdown.children);

    items.forEach(div => {
      div.style.display = div.textContent.toLowerCase().includes(val) ? 'block' : 'none';
    });

    dropdown.style.display = items.some(d => d.style.display !== 'none') ? 'block' : 'none';
  });

  input.addEventListener('focus', () => {
    Array.from(dropdown.children).forEach(div => div.style.display = 'block');
    dropdown.style.display = dropdown.children.length ? 'block' : 'none';
  });

  input.addEventListener('click', () => {
    Array.from(dropdown.children).forEach(div => div.style.display = 'block');
    dropdown.style.display = dropdown.children.length ? 'block' : 'none';
  });

  if (!input.dataset.outsideBound) {
    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = 'none';
      }
    });
    input.dataset.outsideBound = '1';
  }
}

/* -------------------- 7. ADD / REMOVE ROW -------------------- */
function addRow() {
  const tbody = $("#items-body");
  if (!tbody) return;
  const ths = $("#items-table thead tr").children;
  const row = document.createElement("tr");

  row.innerHTML = Array.from(ths).map((th, i) => {
    const colName = th.textContent.trim().toLowerCase().replace(/\s+/g, "_");
    switch (i) {
      case 0:
        return `<td><textarea class="input-full item-desc" name="desc[]" rows="1" style="overflow:hidden; resize:none;"></textarea></td>`;
      case 1:
        return `<td class="Acc-col" style="position:relative;">
          <input type="text" name="account[]" class="input-full account-input" placeholder="+ Create New Account" autocomplete="off">
          <div class="account-dropdown" style="display:none; position:absolute; background:white; border:1px solid #ccc; max-height:150px; overflow:auto; z-index:999;"></div>
          <div style="margin-top:6px;">
            ${buildEWTSelectHTML()}
          </div>
        </td>`;
      case 2:
        return `<td><input type="number" class="input-short" name="qty[]" value="0" oninput="updateAmount(this)"></td>`;
      case 3:
        return `<td><input type="number" class="input-short" name="rate[]" value="0" oninput="updateAmount(this)"></td>`;
      case 4:
        return `<td><input type="number" class="input-short" name="amt[]" value="0" readonly></td>`;
      default:
        return `<td><input type="text" name="${colName}[]"></td>`;
    }
  }).join('');

  tbody.appendChild(row);

  const selInput = row.querySelector('.account-input');
  if (selInput && window._coaAccounts && !selInput.dataset.initialized) {
    setupAccountCombo(selInput, window._coaAccounts);
    selInput.dataset.initialized = 'true';
  }

  const descTextarea = row.querySelector('.item-desc');
  if (descTextarea) {
    autoResize(descTextarea);
    descTextarea.addEventListener('input', () => autoResize(descTextarea));
  }

  adjustColumnWidths();
}

function removeRow() {
  const tbody = $("#items-body");
  if (!tbody || tbody.rows.length <= 1) return alert("At least one row must remain.");
  tbody.deleteRow(tbody.rows.length - 1);
  calculateTotals();
  adjustColumnWidths();
}

/* -------------------- 9. AMOUNT & TOTALS -------------------- */
function updateAmount(input) {
  const row = input.closest("tr");
  if (!row) return;
  const qty = parseFloat(row.querySelector('[name="qty[]"]')?.value) || 0;
  const rate = parseFloat(row.querySelector('[name="rate[]"]')?.value) || 0;
  const amtEl = row.querySelector('[name="amt[]"]');
  if (amtEl) amtEl.value = (qty * rate).toFixed(2);
  calculateTotals();
}

function calculateTotals() {
  const rows = document.querySelectorAll('#items-body tr');
  const exchangeRate = parseFloat(exchangeRateInput?.value) || 1;

  let subtotal = 0;
  let vatAmount = 0;
  let vatExemptAmount = 0;
  let zeroRatedAmount = 0;
  let vatExemptSales = 0;
  let zeroRatedSales = 0;
  let withholdingTotal = 0;

  rows.forEach(row => {
    const qty = parseFloat(row.querySelector('[name="qty[]"]')?.value) || 0;
    const rate = parseFloat(row.querySelector('[name="rate[]"]')?.value) || 0;

    const lineAmt = qty * rate * exchangeRate;

    const amtEl = row.querySelector('[name="amt[]"]');
    if (amtEl) amtEl.value = lineAmt.toFixed(2);

    subtotal += lineAmt;

    const accountId = row.querySelector('[name="account[]"]')?.dataset.accountId || '';
    const account = window._coaAccounts?.find(acc => String(acc.id) === String(accountId));
    const taxType = account?.tax_type || 'vatable';
    const taxRate = parseFloat(account?.tax_rate || 0) / 100;

    switch (taxType) {
      case 'exempt':
        vatExemptSales += lineAmt;
        vatExemptAmount += lineAmt * taxRate;
        break;
      case 'zero':
        zeroRatedSales += lineAmt;
        zeroRatedAmount += lineAmt * taxRate;
        break;
      case 'vatable':
      default:
        vatAmount += lineAmt * taxRate;
        break;
    }

    const rowEwtId =
      row.querySelector('.ewt-select')?.value ||
      (account?.ewt_id ? String(account.ewt_id) : '');

    if (rowEwtId) {
      const e = window._ewtList?.find(x => String(x.id) === String(rowEwtId));
      const ewtRate = e ? (Number(e.tax_rate) / 100) : 0;
      if (ewtRate > 0) withholdingTotal += lineAmt * ewtRate;
    }
  });

  let discountRate = parseFloat(document.querySelector('#discount')?.value) || 0;
  if (discountRate > 1) discountRate /= 100;

  const discountAmount = subtotal * discountRate;
  window.__DISCOUNT_AMOUNT__ = discountAmount;
  const subtotalAfterDiscount = subtotal - discountAmount;
  safeSetText('#discountAmountDisplay', discountAmount.toFixed(2));


  const vatType = document.querySelector('#vatType')?.value || 'inclusive';

  let vatable = 0;
  let finalTotal = 0;
  let displaySubtotal = 0;

  switch (vatType) {
    case 'inclusive':
      vatable = subtotal - vatExemptSales - zeroRatedSales - vatAmount;
      displaySubtotal = subtotalAfterDiscount;
      finalTotal = subtotalAfterDiscount;
      break;

    case 'exclusive':
      vatable = subtotal - vatExemptSales - zeroRatedSales;
      displaySubtotal = subtotalAfterDiscount + vatAmount;
      finalTotal = subtotalAfterDiscount + vatAmount;
      break;

    case 'exempt':
    case 'zero':
    default:
      vatable = subtotal - vatExemptSales - zeroRatedSales;
      displaySubtotal = subtotalAfterDiscount;
      finalTotal = subtotalAfterDiscount;
      break;
  }

  const totalDueAfterWithholding = finalTotal - withholdingTotal;

  safeSetValue('#subtotal', displaySubtotal.toFixed(2));
  safeSetValue('#vatableSales', vatable.toFixed(2));
  safeSetValue('#vatAmount', vatAmount.toFixed(2));
  safeSetValue('#vatExemptSales', vatExemptSales.toFixed(2));

  safeSetValue('#vatExemptAmount', vatExemptAmount.toFixed(2));
  safeSetValue('#vatZeroRatedSales', zeroRatedSales.toFixed(2));
  safeSetValue('#vatZeroRatedAmount', zeroRatedAmount.toFixed(2));

  safeSetValue('#withholdingTaxAmount', withholdingTotal.toFixed(2));
  safeSetValue('#totalPayable', totalDueAfterWithholding.toFixed(2));
}

document.getElementById('vatType')?.addEventListener('change', calculateTotals);
document.getElementById('discount')?.addEventListener('change', calculateTotals);

/* -------------------- 10. ADJUST COLUMN WIDTHS -------------------- */
function adjustColumnWidths() {
  const table = $("#items-table"); if (!table) return;
  const ths = table.querySelectorAll("thead th");
  const colWidth = (100 / ths.length).toFixed(2) + "%";
  ths.forEach(th => th.style.width = colWidth);
  $$("tbody tr", table).forEach(row => row.querySelectorAll("td").forEach(td => td.style.width = colWidth));
}

/* -------------------- 11. MODALS & EXTRA COLUMNS -------------------- */
function openModal(id) { const m = document.getElementById(id); if (m) m.style.display = 'flex'; }
function closeModal(id) { const m = document.getElementById(id); if (m) m.style.display = 'none'; }

function showAddColumnModal() {
  $('#newColumnName').value = 'Column Title';
  $('#addColumnMessage').textContent = '';
  openModal('addColumnModal');
}

function showRemoveColumnModal() {
  $('#removeColumnName').value = 'Column Title';
  $('#removeColumnMessage').textContent = '';
  openModal('removeColumnModal');
}

window.addEventListener('DOMContentLoaded', () => {
  $('#addColumnConfirm')?.addEventListener('click', () => {
    const name = $('#newColumnName').value.trim();
    const msg = $('#addColumnMessage'); msg.textContent = '';
    if (!name) { msg.textContent = "Column name cannot be empty!"; return; }

    const colKey = name.toLowerCase().replace(/\s+/g, "_");
    const th = document.createElement("th");
    th.textContent = name;
    th.setAttribute("data-colkey", colKey);
    $("#items-table thead tr").appendChild(th);

    const rows = $$("#items-body tr");
    if (rows.length === 0) addRow();
    rows.forEach(row => {
      const td = document.createElement("td");
      td.innerHTML = `<input type="text" name="${colKey}[]">`;
      row.appendChild(td);
    });

    adjustColumnWidths();
    closeModal('addColumnModal');
  });

 $('#removeColumnConfirm')?.addEventListener('click', () => {
  const nameRaw = ($('#removeColumnName')?.value || '').trim();
  const msg = $('#removeColumnMessage');
  if (msg) msg.textContent = '';

  // normalize helper: makes "Column Title", "COLUMN_TITLE", "column  title" match
  const normalizeKey = (s) =>
    String(s || '')
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/g, "_");

  if (!nameRaw) {
    if (msg) msg.textContent = "Column name cannot be empty!";
    return;
  }

  const nameKey = normalizeKey(nameRaw);

  const headRow = $("#items-table thead tr");
  if (!headRow) {
    if (msg) msg.textContent = "Table header not found.";
    return;
  }

  const ths = Array.from(headRow.querySelectorAll("th"));

  // ✅ Find by data-colkey first (reliable), fallback to header text
  const index = ths.findIndex(th => {
    const key = normalizeKey(th.getAttribute("data-colkey"));
    const text = normalizeKey(th.textContent);
    return (key && key === nameKey) || text === nameKey;
  });

  if (index === -1) {
    if (msg) msg.textContent = `Column "${nameRaw}" not found!`;
    return;
  }

  // protect default columns: DESCRIPTION, ACCOUNT, QTY, RATE, AMOUNT
  if (index <= 4) {
    if (msg) msg.textContent = "Default columns cannot be removed.";
    return;
  }

  // ✅ Remove header
  ths[index].remove();

  // ✅ Remove body cells at the same index safely
  $$("#items-body tr").forEach(row => {
    const tds = row.querySelectorAll("td");
    if (tds[index]) tds[index].remove();
  });

  adjustColumnWidths();
  closeModal('removeColumnModal');
});

  window.addEventListener('click', e => {
    ['addColumnModal','removeColumnModal'].forEach(id => {
      const m = document.getElementById(id);
      if (m && e.target === m) m.style.display = 'none';
    });
  });
});

/* -------------------- 12. LOGO -------------------- */
function previewLogo(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = $('#uploaded-logo'); const btn = $('#remove-logo-btn');
    if (img) { img.src = e.target.result; img.style.display = 'block'; }
    if (btn) btn.style.display = 'inline-block';
  };
  reader.readAsDataURL(file);
}

function removeLogo() {
  const img = $('#uploaded-logo'); const btn = $('#remove-logo-btn'); const input = $('#logo-upload');
  if (img) { img.src = ''; img.style.display = 'none'; }
  if (btn) btn.style.display = 'none';
  if (input) input.value = '';
}

function getFooterValue(name) {
  const el = document.querySelector(`[name="${name}"]`);
  return el ? el.value : null;
}

/* -------------------- 13. SAVE INVOICE -------------------- */
let __SAVE_LOCK__ = false;

async function saveToDatabase() {
  if (__SAVE_LOCK__) {
    DBG.warn('Save blocked: already saving');
    return false;
  }

  __SAVE_LOCK__ = true;

  try {
    const billTo = getInputValue('billTo');
    const invoiceNo = getInputValue('invoiceNo');
    const date = getInputValue('date');

    if (!billTo || !date) {
      alert("Fill Bill To and Date.");
      return false;
    }

    if (window.__NUMBERING_MODE__ === 'manual' && !invoiceNo) {
      alert("Invoice No is required in manual mode.");
      return false;
    }

    calculateTotals();

    const params = new URLSearchParams(window.location.search);
    const isEdit = params.get('edit') === 'true' || params.get('invoice_no') !== null;

    const ths = $("#items-table thead tr").children;
    const extraColumns = Array.from(ths)
      .slice(5)
      .map(th => th.textContent.trim().toLowerCase().replace(/\s+/g,"_"));

    const rows = $$('#items-body tr');

    const items = rows.map(row => {
      const item = {
        description: row.querySelector('[name="desc[]"]')?.value || "",
        quantity: parseFloat(row.querySelector('[name="qty[]"]')?.value) || 0,
        unit_price: parseFloat(row.querySelector('[name="rate[]"]')?.value) || 0,
        amount: parseFloat(row.querySelector('[name="amt[]"]')?.value) || 0,
        account_id: row.querySelector('[name="account[]"]')?.dataset.accountId || "",
        ewt_id: row.querySelector('.ewt-select')?.value
          ? Number(row.querySelector('.ewt-select').value)
          : null,
      };

      extraColumns.forEach(col => {
        item[col] = row.querySelector(`[name="${col}[]"]`)?.value || '';
      });

      return item;
    });

    const payload = {
      bill_to: billTo,
      address: getInputValue('address'),
      tin: getInputValue('tin'),
      date,
      terms: getInputValue('terms'),
      invoice_title: $('.invoice-title')?.textContent || 'SERVICE INVOICE',
      invoice_mode: getInputValue('invoiceMode'),

      invoice_category: getInputValue('invoiceCategory'),
      invoice_type: getInputValue('invoice_type'),
      currency: currencySelect?.value || 'PHP',
      exchange_rate: parseFloat(exchangeRateInput?.value) || 1,
      vat_type: document.getElementById('vatType')?.value || 'inclusive',
      items,
      extra_columns: extraColumns,
      tax_summary: {
        subtotal: parseFloat($('#subtotal')?.value) || 0,
        discount: Number(window.__DISCOUNT_AMOUNT__ || 0),
        vatable_sales: parseFloat($('#vatableSales')?.value) || 0,
        vat_exempt_sales: parseFloat($('#vatExemptSales')?.value) || 0,
        zero_rated_sales: parseFloat($('#vatZeroRatedSales')?.value) || 0,
        vat_amount: parseFloat($('#vatAmount')?.value) || 0,
        withholding: parseFloat($('#withholdingTaxAmount')?.value) || 0,
        total_payable: parseFloat($('#totalPayable')?.value) || 0
      },
      footer: {
        atp_no: getFooterValue('footerAtpNo'),
        atp_date: getFooterValue('footerAtpDate'),
        bir_permit_no: getFooterValue('footerBirPermitNo'),
        bir_date: getFooterValue('footerBirDate'),
        serial_nos: getFooterValue('footerSerialNos')
      }
    };

    // ✅ recurring fields
    if ((payload.invoice_mode || '').toLowerCase() === 'recurring') {
      const start = document.getElementById('recurrenceStart')?.value || '';
      if (!start) {
        alert('Recurring: Next Run Date is required.');
        return false;
      }

      payload.recurrence_type = 'monthly';
      payload.recurrence_start_date = start;
      payload.recurrence_end_date = document.getElementById('recurrenceEnd')?.value || null;
      payload.recurrence_status = document.getElementById('recurrenceStatus')?.value || 'active';
    } else {
      payload.recurrence_type = null;
      payload.recurrence_start_date = null;
      payload.recurrence_end_date = null;
      payload.recurrence_status = null;
    }

    if (window.__NUMBERING_MODE__ === 'manual') {
      payload.invoice_no = invoiceNo;
    }

    const endpoint = isEdit
      ? `/api/invoices/${encodeURIComponent(invoiceNo)}`
      : '/api/invoices';

    const method = isEdit ? 'PUT' : 'POST';

    DBG.log(`[SAVE] ${method} ${endpoint}`);

    const res = await fetch(endpoint, {
      method,
      credentials: 'include', 
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json().catch(()=>({}));
      throw new Error(err.error || err.message || 'Save failed');
    }

   // ------------------------------
// ✅ Return invoice number after save
// ------------------------------
let savedInvoiceNo = '';

// Try reading invoice number from backend response (recommended)
try {
  const out = await res.json().catch(() => null);

  // backend may return:
  // { invoice_no }, { invoiceNo }, or { invoice: { invoice_no } }
  savedInvoiceNo =
    (out && (out.invoice_no || out.invoiceNo || out?.invoice?.invoice_no)) || '';
} catch {
  // ignore JSON parse issues
}

// Fallback: read from input field after save
// (works for manual numbering; auto numbering depends on backend populating input)
if (!savedInvoiceNo) {
  savedInvoiceNo = String(getInputValue('invoiceNo') || '').trim();
}

DBG.log('Invoice saved successfully:', savedInvoiceNo || '(no invoice number returned)');

// IMPORTANT:
// - Return invoice number if we have it
// - Otherwise return true (keeps old behavior working)
return savedInvoiceNo || true;

  } catch (err) {
    DBG.error('saveToDatabase error:', err);
    alert('Failed to save invoice: ' + err.message);
    return false;
  } finally {
    __SAVE_LOCK__ = false;
  }
}

/* -------------------- APPLY TAX DEFAULTS FROM SETTINGS -------------------- */
async function applyTaxDefaultsFromSettings() {
  try {
    const params = new URLSearchParams(window.location.search);
    const isEdit = params.get('edit') === 'true' || params.get('invoice_no');

    if (isEdit) return;

    const res = await fetch('/api/invoice-settings', { credentials: 'include' });
    if (!res.ok) return;

    const s = await res.json();
    const defaultVatType = s.sales_tax_default || 'inclusive';

    const vatTypeEl = document.getElementById('vatType');
    if (vatTypeEl) vatTypeEl.value = defaultVatType;

    calculateTotals?.();
  } catch (err) {
    console.error('applyTaxDefaultsFromSettings error:', err);
  }
}

/* -------------------- 14. INIT -------------------- */
function autofillDates() {
  const today = new Date().toISOString().split('T')[0];

  const issueDate = document.getElementById('issueDate');
  if (issueDate && !issueDate.value) issueDate.value = today;

  const invoiceDate = document.getElementsByName('date')[0];
  if (invoiceDate && !invoiceDate.value) invoiceDate.value = today;

  const footerAtpDate = document.getElementsByName('footerAtpDate')[0];
  if (footerAtpDate && !footerAtpDate.value) footerAtpDate.value = today;
}

/* ===================== ✅ ALWAYS RECALC WHEN ACCOUNT/EWT CHANGES ===================== */
function bindItemsBodyRecalc() {
  const tbody = document.getElementById('items-body');
  if (!tbody || tbody.dataset.recalcBound === '1') return;

  let timer = null;
  const scheduleRecalc = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { calculateTotals?.(); } catch {}
    }, 0);
  };

  // 1) EWT dropdown changes (withholding changes)
  tbody.addEventListener('change', (e) => {
    if (e.target?.matches?.('.ewt-select')) {
      scheduleRecalc();
    }
  });

  // 2) Account input typed/edited manually (VAT base may change)
  // We recalc, but ALSO try to resolve the typed text into an account_id on blur
  tbody.addEventListener('blur', (e) => {
    if (!e.target?.matches?.('.account-input')) return;

    const input = e.target;
    const raw = String(input.value || '').trim().toLowerCase();

    // If user typed something, attempt to match to an account
    const accounts = window._coaAccounts || [];
    const matched = accounts.find(a => {
      const label = `${a.code || ''} - ${a.title || ''}`.trim().toLowerCase();
      const codeOnly = String(a.code || '').trim().toLowerCase();
      return raw === label || (codeOnly && raw === codeOnly);
    });

    if (matched) {
      input.dataset.accountId = String(matched.id);

      // If EWT still Default, apply account's default EWT
      const row = input.closest('tr');
      const ewtSel = row?.querySelector('.ewt-select');
      if (ewtSel && !ewtSel.value && matched.ewt_id) {
        ewtSel.value = String(matched.ewt_id);
      }
    } else {
      // If they typed something that doesn't match any account,
      // clear accountId so you don't use a stale one.
      delete input.dataset.accountId;
    }

    scheduleRecalc();
  }, true);

  // 3) Optional: if you want totals to react while typing account text (light debounce)
  tbody.addEventListener('input', (e) => {
    if (e.target?.matches?.('.account-input')) {
      scheduleRecalc();
    }
  });

  tbody.dataset.recalcBound = '1';
}


/* ✅ MAIN PAGE INIT */
window.addEventListener('DOMContentLoaded', async () => {
  await waitNavbar();

  const allowed = await requireAnyRole(['super', 'approver', 'submitter']);
  if (!allowed) return;

  autofillDates();
 
  // ✅ must be after DOM exists
  initRecurringHeaderUI();

  await loadEWTList();
  ensureEWTOnExistingRows();
  refreshAllEWTSelects();

  await loadAccounts();
  await applyTaxDefaultsFromSettings();

  await loadCompanyInfo();
  await loadNextInvoiceNo();
  setInvoiceTitleFromURL();
  await loadInvoiceForEdit();

  adjustColumnWidths();
  calculateTotals?.();
  bindItemsBodyRecalc();

});

/* ===================== CONTACTS AUTOCOMPLETE + MODAL ===================== */
const billToInput = document.getElementById("billTo");
const billToIdInput = document.getElementById("billToId");
const billToDropdown = document.getElementById("billToDropdown");
const tinInput = document.getElementById("tin");
const addressInput = document.getElementById("address");
const termsInput = document.getElementById("terms");
const contactCard = document.getElementById("contactCard");
const billToClearBtn = document.getElementById("billToClearBtn");
const modal = document.getElementById("contactModal");

let contacts = [];
let selectedContact = null;
let isEditing = false;

async function loadContacts() {
  try {
    const res = await fetch('/api/contacts');
    if (!res.ok) throw new Error('Failed to fetch contacts');
    contacts = await res.json();
  } catch (err) {
    console.error('Failed to load contacts:', err);
    contacts = [];
  }
}
loadContacts();

function renderDropdown(list, searchValue = '') {
  if (selectedContact) return;

  billToDropdown.innerHTML = '';
  list.forEach(c => {
    const item = document.createElement('div');
    item.style.cssText = 'padding:6px 10px; cursor:pointer; display:flex; justify-content:space-between; align-items:center';

    const left = document.createElement('div');
    const name = document.createElement('div');
    name.textContent = c.business;
    name.style.fontWeight = 'bold';
    left.appendChild(name);

    if (c.tin) {
      const tin = document.createElement('div');
      tin.textContent = c.tin;
      tin.style.cssText = 'font-size:10px; color:#666';
      left.appendChild(tin);
    }

    const right = document.createElement('div');
    (c.type || '').split(',').forEach(t => {
      if (!t.trim()) return;
      const tag = document.createElement('span');
      tag.textContent = t.trim();
      tag.style.cssText = 'font-size:10px; margin-left:4px; padding:2px 6px; border-radius:4px; background:#e9ecef; font-weight:bold';
      right.appendChild(tag);
    });

    item.appendChild(left);
    item.appendChild(right);
    item.addEventListener('click', () => selectContact(c));

    billToDropdown.appendChild(item);
  });

  if (searchValue && !list.length) {
    const createItem = document.createElement('div');
    createItem.textContent = `➕ Create "${searchValue}" as a new contact`;
    createItem.style.cssText = 'padding:6px 10px; cursor:pointer; font-weight:bold; color:#0d6efd';
    createItem.addEventListener('click', () => openContactModal(searchValue));
    billToDropdown.appendChild(createItem);
  }

  billToDropdown.style.display = billToDropdown.children.length ? 'block' : 'none';
}

function showContactCard(c) {
  if (!contactCard) return;

  document.getElementById('cardBusiness').textContent = c.business;
  document.getElementById('cardCode').textContent = `Account #: ${c.code || '—'}`;
  document.getElementById('cardAddress').textContent = c.address || '—';
  document.getElementById('cardBalance').textContent = (c.balance || 0).toFixed(2);

  const initials = String(c.business || '')
    .split(' ')
    .filter(Boolean)
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  document.getElementById('contactAvatar').textContent = initials || '--';

  // prevent multiple listener stacking
  const editBtn = document.getElementById('editContactBtn');
  if (editBtn && !editBtn.dataset.bound) {
    editBtn.addEventListener('click', e => {
      e.preventDefault();
      openContactModal(null, selectedContact);
    });
    editBtn.dataset.bound = '1';
  }

  contactCard.style.display = 'block';
}

function selectContact(c) {
  selectedContact = c;
  billToInput.value = c.business;
  billToInput.readOnly = true;
  billToInput.classList.add('locked');
  billToIdInput.value = c.id;
  tinInput.value = c.tin || '';
  addressInput.value = c.address || '';
  if (termsInput) termsInput.value = c.terms || '';
  billToDropdown.style.display = 'none';
  billToClearBtn.style.display = 'block';
  showContactCard(c);
}

function clearSelectedContact() {
  selectedContact = null;
  billToInput.value = '';
  billToInput.readOnly = false;
  billToInput.classList.remove('locked');
  billToIdInput.value = '';
  tinInput.value = '';
  addressInput.value = '';
  if (termsInput) termsInput.value = '';
  contactCard.style.display = 'none';
  billToClearBtn.style.display = 'none';
  billToInput.focus();
}

billToInput?.addEventListener('input', () => {
  if (selectedContact) return;
  const value = billToInput.value.trim().toLowerCase();
  if (!value) {
    billToIdInput.value = '';
    billToDropdown.style.display = 'none';
    return;
  }
  const filtered = contacts.filter(c => c.business && c.business.toLowerCase().includes(value));
  renderDropdown(filtered, billToInput.value);
});

billToInput?.addEventListener('click', () => {
  if (selectedContact) {
    contactCard.style.display = contactCard.style.display === 'block' ? 'none' : 'block';
  } else {
    renderDropdown(contacts);
  }
});

billToClearBtn?.addEventListener('click', clearSelectedContact);

document.addEventListener('click', e => {
  if (!e.target.closest('#billTo') &&
      !e.target.closest('#billToDropdown') &&
      !e.target.closest('#contactCard') &&
      !e.target.closest('#billToClearBtn') &&
      !e.target.closest('#contactModal')) {
    billToDropdown.style.display = 'none';
    contactCard.style.display = 'none';
  }
});

async function openContactModal(name = '', contact = null) {
  isEditing = !!contact;
  modal.style.display = 'flex';
  document.getElementById('modalTitle').textContent = isEditing ? 'Edit Contact' : 'Create New Contact';

  const modalContent = modal.querySelector('.modal-content');
  if (modalContent && !modalContent.dataset.bound) {
    modalContent.addEventListener('click', e => e.stopPropagation());
    modalContent.dataset.bound = '1';
  }

  const fields = [
    'modalType','modalCode','modalBusiness','modalName',
    'modalAddress','modalVatReg','modalTIN','modalPhone','modalEmail'
  ];
  fields.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });

  if (isEditing && contact) {
    selectedContact = contact;
    document.getElementById('modalType').value = contact.type || 'Customer';
    document.getElementById('modalCode').value = contact.code || '';
    document.getElementById('modalBusiness').value = contact.business || '';
    document.getElementById('modalName').value = contact.name || '';
    document.getElementById('modalAddress').value = contact.address || '';
    document.getElementById('modalVatReg').value = contact.vatReg || '';
    document.getElementById('modalTIN').value = contact.tin || '';
    document.getElementById('modalPhone').value = contact.phone || '';
    document.getElementById('modalEmail').value = contact.email || '';
  } else {
    selectedContact = null;
    if (name) document.getElementById('modalBusiness').value = name;
    await updateNextCode();
  }
}

const modalType = document.getElementById('modalType');
const modalCode = document.getElementById('modalCode');

async function updateNextCode() {
  const type = modalType.value || 'Customer';
  try {
    const res = await fetch(`/api/contacts/next-code?type=${type}`);
    if (!res.ok) throw new Error('Failed to get next code');
    const data = await res.json();
    modalCode.value = data.nextCode;
  } catch (err) {
    console.error(err);
    modalCode.value = '';
  }
}

modalType?.addEventListener('change', () => {
  if (!isEditing) updateNextCode();
});

document.getElementById('modalSave')?.addEventListener('click', async e => {
  e.preventDefault();

  const type = modalType.value;
  let payload = {
    type,
    code: modalCode.value.trim(),
    business: document.getElementById('modalBusiness').value.trim(),
    name: document.getElementById('modalName').value.trim(),
    address: document.getElementById('modalAddress').value.trim(),
    vat_registration: document.getElementById('modalVatReg').value.trim(),
    tin: document.getElementById('modalTIN').value.trim(),
    phone: document.getElementById('modalPhone').value.trim(),
    email: document.getElementById('modalEmail').value.trim()
  };

  if (!payload.code || !payload.business || !payload.name) {
    return alert('Required fields missing');
  }

  try {
    const resAll = await fetch('/api/contacts');
    const allContacts = await resAll.json();
    const duplicate = allContacts.find(c => c.code === payload.code && c.type === type && (!isEditing || c.id !== selectedContact?.id));

    if (duplicate) {
      const resCode = await fetch(`/api/contacts/next-code?type=${type}`);
      if (!resCode.ok) throw new Error('Failed to get next contact code');
      const data = await resCode.json();
      payload.code = data.nextCode;
      alert(`Duplicate ${type} code detected. Code changed to ${payload.code}`);
    }

    if (isEditing && selectedContact) {
      const res = await fetch(`/api/contacts/${selectedContact.id}`, {
        method: 'PUT',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Failed to update contact');

      const index = contacts.findIndex(c => c.id === selectedContact.id);
      if (index !== -1) contacts[index] = { ...contacts[index], ...payload };
      selectContact(contacts[index]);
    } else {
      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Failed to create contact');

      const savedContact = await res.json();
      contacts.push({ id: savedContact.id, ...payload });
      selectContact({ id: savedContact.id, ...payload });
    }

    closeContactModal();
  } catch (err) {
    console.error(err);
    alert(err.message);
  }
});

document.getElementById('modalCancel')?.addEventListener('click', e => {
  e.preventDefault();
  closeContactModal();
});

modal?.addEventListener('click', closeContactModal);

function closeContactModal() {
  modal.style.display = 'none';
}

/* -------------------- 15. SAVE & CLOSE (Split Button + Role-aware options) -------------------- */
document.addEventListener('DOMContentLoaded', async () => {
  await waitNavbar();

  const saveCloseBtn = document.getElementById('saveCloseBtn');
  if (!saveCloseBtn) {
    DBG?.warn?.('saveCloseBtn not found in DOM');
    return;
  }

  // ✅ Wrap for split button + anchored dropdown
  if (!saveCloseBtn.parentElement.classList.contains('saveclose-wrap')) {
    const wrap = document.createElement('div');
    wrap.className = 'saveclose-wrap';
    wrap.style.position = 'relative';
    wrap.style.display = 'inline-flex';
    wrap.style.alignItems = 'stretch';
    wrap.style.gap = '0';
    saveCloseBtn.parentElement.insertBefore(wrap, saveCloseBtn);
    wrap.appendChild(saveCloseBtn);
  }

  const wrap = saveCloseBtn.parentElement;

  // ✅ Create arrow button beside Save & close
  let arrowBtn = wrap.querySelector('#saveCloseArrowBtn');
  if (!arrowBtn) {
    arrowBtn = document.createElement('button');
    arrowBtn.type = 'button';
    arrowBtn.id = 'saveCloseArrowBtn';

    // keep same class/style as main button
    arrowBtn.className = saveCloseBtn.className;

    // compact caret
    arrowBtn.style.paddingLeft = '12px';
    arrowBtn.style.paddingRight = '12px';
    arrowBtn.style.minWidth = '44px';
    arrowBtn.innerHTML = '&#9662;'; // ▼

    wrap.appendChild(arrowBtn);
  }

  // ✅ Get user ONCE (used to decide menu items)
  let me = null;
  try {
    me = await fetch('/auth/me', { credentials: 'include' }).then(r => r.json());
  } catch (e) {
    console.warn('⚠️ /auth/me failed, menu will show minimal options', e);
  }

  const role = String(me?.user?.role || me?.user?.user?.role || '').toLowerCase();

const isSubmitter = role === 'submitter';
const isApprover  = role === 'approver';
const isSuper     = role === 'super';     // ✅ your admin

  // ✅ Ensure dropdown exists
  let dropdown = wrap.querySelector('.saveclose-menu');
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.className = 'saveclose-menu';
    dropdown.style.position = 'absolute';
    dropdown.style.top = 'calc(100% + 8px)';
    dropdown.style.left = '0';
    dropdown.style.minWidth = '220px';
    dropdown.style.background = '#fff';
    dropdown.style.border = '1px solid rgba(0,0,0,0.12)';
    dropdown.style.borderRadius = '12px';
    dropdown.style.boxShadow = '0 14px 35px rgba(0,0,0,0.18)';
    dropdown.style.padding = '6px 0';
    dropdown.style.display = 'none';
    dropdown.style.zIndex = '99999';
    wrap.appendChild(dropdown);
  }

  function isOpen() { return dropdown.style.display !== 'none'; }
  function open() {
    dropdown.style.left = '0';
    dropdown.style.right = 'auto';

    const r = dropdown.getBoundingClientRect();
    if (r.right > window.innerWidth) {
      dropdown.style.left = 'auto';
      dropdown.style.right = '0';
    }
    dropdown.style.display = 'block';
  }
  function close() { dropdown.style.display = 'none'; }

  // ✅ Build/Rebuild menu (IMPORTANT FIX)
  function buildMenu() {
    // clear old items so new options can appear
    dropdown.innerHTML = '';

    // ✅ Detect editing mode at build time (invoiceNo might be filled later)
    const qs = new URLSearchParams(window.location.search);
    const invoiceNoFromQS = (qs.get('invoiceNo') || qs.get('invoice_no') || qs.get('id') || '').trim();
    const invoiceNoFromInput = String(document.getElementById('invoiceNo')?.value || '').trim();
    const isEditingInvoice = Boolean(invoiceNoFromQS || invoiceNoFromInput);

        const options = [
      { text: 'Save & Add Another', action: 'addAnother' },

      // ✅ NEW: available to all roles
      { text: 'Save & Preview', action: 'savePreview' },

      // ✅ Submitter-only: submits to approver flow (pending)
      ...(isSubmitter ? [{ text: 'Submit for Approval', action: 'submitApproval' }] : []),

      // ✅ NEW: Approver/Super: Save & Submit (mark as pending or submit endpoint)
      ...((isApprover || isSuper) ? [{ text: 'Save & Submit', action: 'saveSubmit' }] : []),

      // ✅ Existing: only when editing + approver/super
      ...((isEditingInvoice && (isApprover || isSuper))
        ? [{ text: 'Save & Void', action: 'saveVoid', danger: true }]
        : [])
    ];

    options.forEach(opt => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = opt.text;
      btn.dataset.action = opt.action;
      btn.style.display = 'block';
      btn.style.width = '100%';
      btn.style.padding = '10px 14px';
      btn.style.border = 'none';
      btn.style.background = 'transparent';
      btn.style.textAlign = 'left';
      btn.style.cursor = 'pointer';
      btn.style.fontSize = '14px';

      if (opt.danger) btn.style.color = '#b91c1c';

      btn.addEventListener('mouseenter', () => btn.style.background = '#f3f4f6');
      btn.addEventListener('mouseleave', () => btn.style.background = 'transparent');

      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        close();
        await handleSaveCloseAction(opt.action);
      });

      dropdown.appendChild(btn);
    });
  }

  // build now + rebuild later (covers async invoice load)
  buildMenu();
  setTimeout(buildMenu, 400);
  setTimeout(buildMenu, 1200);
  setTimeout(buildMenu, 2500);

  // ✅ Main button = Save & close (no dropdown)
  saveCloseBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    close();
    await handleSaveCloseAction('close');
  });

  // ✅ Arrow toggles dropdown
  arrowBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // rebuild right before opening so it always reflects latest state
    buildMenu();

    if (!dropdown || dropdown.children.length === 0) return;
    if (isOpen()) close();
    else open();
  });

  // close on outside click / ESC
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
});

async function handleSaveCloseAction(action) {
  const invoiceNo = String(getInputValue('invoiceNo') || '').trim();

  const saved = await saveToDatabase();
  if (!saved) return;

// ✅ Use returned invoiceNo if saveToDatabase returned it, otherwise read from input
const savedInvoiceNo =
  typeof saved === 'string' ? saved : String(getInputValue('invoiceNo') || '').trim();

  if (action === 'close') {
    window.location.href = '/Dashboard.html';
    return;
  }

  if (action === 'addAnother') {
    window.location.href = '/invoice.html';
    return;
  }

  // ✅ Submitter-only action
  if (action === 'submitApproval') {
    const user = await fetch('/auth/me', { credentials: 'include' }).then(r => r.json());
    const role = String(user?.user?.role || user?.user?.user?.role || '').toLowerCase();

    if (!savedInvoiceNo) {
  alert('No invoice number found to submit.');
  return;
}
    if (role !== 'submitter') {
      alert('Only Submitter can submit for approval');
      return;
    }

    try {
      const res = await fetch(`/api/invoices/${encodeURIComponent(savedInvoiceNo)}/submit`, {
  method: 'POST',
  credentials: 'include'                
});
      if (!res.ok) {
  const data = await res.json().catch(() => ({}));
  throw new Error(data.error || data.message || `Submit failed (${res.status})`);
}

      alert('Invoice submitted for approval!');
      window.location.href = '/Dashboard.html';
    } catch (err) {
      console.error('Submit error:', err);
      alert('Failed to submit for approval');
    }
    return;
  } 

if (action === 'savePreview') {
  const no = savedInvoiceNo;
  if (!no) {
    alert('Saved, but invoice number is missing so preview cannot open.');
    return;
  }

  // Open your existing preview viewer page
  window.open(`/InvoicePreviewViewer.html?invoice_no=${encodeURIComponent(no)}`, '_blank');
  return;
}

if (action === 'saveSubmit') {
  const user = await fetch('/auth/me', { credentials: 'include' }).then(r => r.json());
  const role = String(user?.user?.role || user?.user?.user?.role || '').toLowerCase();

  if (role !== 'approver' && role !== 'super') {
    alert('Only Approver/Super can Save & Submit');
    return;
  }

  const no = savedInvoiceNo;
  if (!no) {
    alert('No invoice number found to submit.');
    return;
  }

  try {
    const res = await fetch(`/api/invoices/${encodeURIComponent(no)}/submit`, {
      method: 'POST',
      credentials: 'include'
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Submit failed');
    }

    alert('Invoice submitted!');
    window.location.href = `/invoice-list.html?focus=${encodeURIComponent(no)}`;
  } catch (err) {
    console.error('Save & Submit error:', err);
    alert('Failed to submit: ' + err.message);
  }
  return;
}

  // ✅ NEW: Approver/Admin only — Save & Void
  if (action === 'saveVoid') {
    const user = await fetch('/auth/me', { credentials: 'include' }).then(r => r.json());
    const role = String(user?.user?.role || user?.user?.user?.role || '').toLowerCase();

    if (role !== 'approver' && role !== 'super') {
  alert('Only Approver/Super can void invoices');
  return;
}
    if (!invoiceNo) {
      alert('No invoice number found to void.');
      return;
    }

    const ok = confirm('Void this invoice? This will mark it as VOID.');
    if (!ok) return;

    try {
      const res = await fetch(`/api/invoices/${encodeURIComponent(invoiceNo)}/void`, {
  method: 'POST',
  credentials: 'include'             
});
      if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || data.message || `Void failed (${res.status})`);
  }
      alert('Invoice voided.');
      window.location.href = '/Dashboard.html';
    } catch (err) {
      console.error('Void error:', err);
      alert('Failed to void invoice: ' + err.message);
    }
  }
}


/* -------------------- LIVE PREVIEW (Injected preview button) -------------------- */
const form = document.getElementById('invoiceForm');
const iframe = document.getElementById('invoicePreviewFrame');

async function loadPreviewHTML() {
  if (!iframe) throw new Error('Preview iframe not found');
  if (iframe.dataset.loaded === 'true') return;

  const res = await fetch('Replica.html');
  if (!res.ok) throw new Error('Failed to fetch Replica.html');

  const html = await res.text();
  const doc = iframe.contentDocument || iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();

  iframe.dataset.loaded = 'true';
}

function getInvoiceData() {
  if (!form) return {};

  const rows = Array.from(form.querySelectorAll('#items-body tr'));
  const items = rows.map(row => {
    const desc = row.querySelector('[name="desc[]"]')?.value || '';
    const qty = parseFloat(row.querySelector('[name="qty[]"]')?.value) || 0;
    const price = parseFloat(row.querySelector('[name="rate[]"]')?.value) || 0;
    const amount = parseFloat(row.querySelector('[name="amt[]"]')?.value) || 0;
    return { description: desc, qty, price, amount };
  });

  return {
    invoice_no: form.querySelector('#invoice_no')?.value || '',
    date: form.querySelector('[name="date"]')?.value || '',
    billTo: form.querySelector('#billTo')?.value || '',
    address: form.querySelector('#address')?.value || '',
    tin: form.querySelector('#tin')?.value || '',
    terms_table: form.querySelector('#terms')?.value || '',
    exchange_rate: form.querySelector('#exchangeRate')?.value || '',
    items,
    vatableSales: form.querySelector('#vatableSales')?.value || '0.00',
    vatAmount: form.querySelector('#vatAmount')?.value || '0.00',
    vatExemptSales: form.querySelector('#vatExemptSales')?.value || '0.00',
    zeroRatedSales: form.querySelector('#zeroRatedSales')?.value || '0.00',
    subtotal: form.querySelector('#subtotal')?.value || '0.00',
    discount: form.querySelector('#discount')?.value || '0.00',
    totalPayable: form.querySelector('#totalPayable')?.value || '0.00',
    footer_bir_permit: form.querySelector('[name="footerBirPermitNo"]')?.value || '',
    footer_bir_date: form.querySelector('[name="footerBirDate"]')?.value || '',
    footer_serial_nos: form.querySelector('[name="footerSerialNos"]')?.value || ''
  };
}

function formatCurrency(value) {
  const num = parseFloat(value);
  if (isNaN(num)) return '';
  return num.toLocaleString('en-PH', { style: 'currency', currency: 'PHP' });
}

function updatePreview() {
  if (!iframe || !iframe.contentDocument) return;

  const data = getInvoiceData();
  const doc = iframe.contentDocument;

  const headerFields = [
    'invoice_no',
    'invoice_date',
    'billTo',
    'address',
    'tin',
    'terms_table',
    'exchange_rate'
  ];

  headerFields.forEach(id => {
    const el = doc.getElementById(id);
    if (!el) return;

    if (id === 'exchange_rate') el.textContent = data.exchange_rate ?? '';
    else el.textContent = data[id] ?? '';
  });

  const tbody = doc.getElementById('itemRows');
  if (tbody) {
    tbody.innerHTML = '';
    data.items.forEach(item => {
      const tr = doc.createElement('tr');

      const descTd = doc.createElement('td');
      descTd.textContent = item.description || '';
      tr.appendChild(descTd);

      const qtyTd = doc.createElement('td');
      qtyTd.textContent = item.qty ?? 0;
      tr.appendChild(qtyTd);

      const priceTd = doc.createElement('td');
      priceTd.textContent = formatCurrency(item.price ?? 0);
      tr.appendChild(priceTd);

      const amountTd = doc.createElement('td');
      amountTd.textContent = formatCurrency(item.amount ?? 0);
      tr.appendChild(amountTd);

      tbody.appendChild(tr);
    });
  }

  const taxFields = [
    { id: 'vatableSales', value: data.vatableSales },
    { id: 'vatAmount', value: data.vatAmount },
    { id: 'vatExemptSales', value: data.vatExemptSales },
    { id: 'zeroRatedSales', value: data.zeroRatedSales },
    { id: 'subtotal', value: data.subtotal },
    { id: 'discount', value: data.discount },
    { id: 'totalPayable', value: data.totalPayable }
  ];

  taxFields.forEach(f => {
    const el = doc.getElementById(f.id);
    if (!el) return;

    if (f.id === 'discount') el.value = f.value ?? 0;
    else el.textContent = formatCurrency(f.value ?? 0);
  });

  const footerFields = [
    { id: 'footer-bir-permit', value: data.footer_bir_permit },
    { id: 'footer-bir-date', value: data.footer_bir_date },
    { id: 'footer-serial-nos', value: data.footer_serial_nos }
  ];

  footerFields.forEach(f => {
    const el = doc.getElementById(f.id);
    if (el) el.textContent = f.value ?? '';
  });
}

async function showPreviewToggle() {
  if (!iframe) return;

  const visible = iframe.style.display && iframe.style.display !== 'none';
  const previewBtn = document.getElementById('previewBtn'); // injected

  if (visible) {
    iframe.style.display = 'none';
    previewBtn?.setAttribute('aria-pressed', 'false');
    return;
  }

  try {
    await loadPreviewHTML();
    updatePreview();
    iframe.style.display = 'block';
    previewBtn?.setAttribute('aria-pressed', 'true');
  } catch (err) {
    console.error('Failed to load preview', err);
    alert('Failed to load preview: ' + err.message);
  }
}

// ✅ bind preview button after navbar injection
document.addEventListener('DOMContentLoaded', async () => {
  await waitNavbar();
  const previewBtn = document.getElementById('previewBtn');
  if (previewBtn) previewBtn.addEventListener('click', showPreviewToggle);
});

if (form) form.addEventListener('input', updatePreview);

/* -------------------- INVOICE DROPDOWN (Injected) -------------------- */
document.addEventListener('DOMContentLoaded', async () => {
  await waitNavbar();

  const invoiceDropdown = document.getElementById('invoiceDropdown');
  const invoiceTypeInput = document.getElementById('invoice_type');
  const createInvoiceBtn = document.getElementById('createInvoiceBtn');

  if (invoiceDropdown && invoiceTypeInput && createInvoiceBtn) {
    invoiceDropdown.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', function(e) {
        e.preventDefault();
        const type = this.getAttribute('href')?.split('type=')[1] || '';
        invoiceTypeInput.value = type.toUpperCase().replace(/_/g, ' ');
        createInvoiceBtn.textContent = this.textContent;
        invoiceDropdown.classList.remove('show');
      });
    });
  } 
});

/* -------------------- EXPOSE GLOBALS -------------------- */
window.addRow = addRow;
window.removeRow = removeRow;
window.showAddColumnModal = showAddColumnModal;
window.showRemoveColumnModal = showRemoveColumnModal;
window.closeModal = closeModal;
window.previewLogo = previewLogo;
window.removeLogo = removeLogo;
window.saveToDatabase = saveToDatabase;
window.updateAmount = updateAmount;
window.calculateTotals = calculateTotals;