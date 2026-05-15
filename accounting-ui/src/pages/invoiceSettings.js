document.addEventListener('DOMContentLoaded', () => {
  const invoicePrefixInput = document.getElementById('invoicePrefix');
  const savePrefixBtn = document.getElementById('savePrefix');

  const currentInvoiceNoInput = document.getElementById('currentInvoiceNo');

  // NEW: numbering mode UI
  const modeAutoBtn = document.getElementById('modeAutoBtn');
  const modeManualBtn = document.getElementById('modeManualBtn');
  const saveNumberingModeBtn = document.getElementById('saveNumberingMode');
  const modeMsg = document.getElementById('modeMsg');
  const modeHelp = document.getElementById('modeHelp');

  // NEW: start number for AUTO (uses /numbering)
  const nextNumberRow = document.getElementById('nextNumberRow');
  const startNumberInput = document.getElementById('startNumber');
  const saveStartNumberBtn = document.getElementById('saveStartNumber');
  const startNumberHelp = document.getElementById('startNumberHelp');
  const nextNumberMsg = document.getElementById('nextNumberMsg');

  const invoiceLayoutSelect = document.getElementById('invoiceLayout');
  const saveLayoutBtn = document.getElementById('saveLayout');
  const layoutMsg = document.getElementById('layoutMsg');

  // TAX DEFAULTS
  const salesTaxDefaultSelect = document.getElementById('salesTaxDefault');
  const purchaseTaxDefaultSelect = document.getElementById('purchaseTaxDefault');
  const saveTaxDefaultsBtn = document.getElementById('saveTaxDefaults');
  const taxDefaultsMsg = document.getElementById('taxDefaultsMsg');

  const prefixMsg = document.getElementById('prefixMsg');

  const BASE_URL = '';

  let currentMode = 'auto'; // cached UI state

  function setMsg(el, text, color = 'green') {
    if (!el) return;
    el.textContent = text || '';
    el.style.color = color;
  }

  function setActiveMode(mode) {
    currentMode = mode === 'manual' ? 'manual' : 'auto';

    // Toggle active styles
    modeAutoBtn?.classList.toggle('active', currentMode === 'auto');
    modeManualBtn?.classList.toggle('active', currentMode === 'manual');

    // Helper text
    if (modeHelp) {
      modeHelp.innerHTML =
        currentMode === 'auto'
          ? 'In <b>AUTO</b> mode, the system generates invoice numbers.'
          : 'In <b>MANUAL</b> mode, users must type invoice numbers (system will not generate).';
    }

    // Hide/disable NEXT NUMBER section when manual
    const isManual = currentMode === 'manual';
    if (nextNumberRow) nextNumberRow.classList.toggle('disabled-row', isManual);
    if (startNumberHelp) startNumberHelp.classList.toggle('muted', isManual);

    if (startNumberInput) {
      startNumberInput.disabled = isManual;
      startNumberInput.placeholder = isManual ? 'Disabled in manual mode' : 'e.g. 100001';
    }
    if (saveStartNumberBtn) saveStartNumberBtn.disabled = isManual;
  }

  async function loadInvoiceSettings() {
    try {
      const res = await fetch(`${BASE_URL}/api/invoice-settings`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load settings');
      const data = await res.json();

      // Prefix
      if (invoicePrefixInput) invoicePrefixInput.value = data.prefix || 'INV-';

      // Last number (display)
      const lastNum = Number(data.last_number || 0);
      if (currentInvoiceNoInput) currentInvoiceNoInput.value = String(lastNum);

      // Layout
      if (invoiceLayoutSelect) invoiceLayoutSelect.value = data.layout || 'standard';

      // Tax Defaults
      if (salesTaxDefaultSelect) salesTaxDefaultSelect.value = data.sales_tax_default || 'inclusive';
      if (purchaseTaxDefaultSelect) purchaseTaxDefaultSelect.value = data.purchase_tax_default || 'inclusive';

      // Mode
      setActiveMode(String(data.numbering_mode || 'auto').toLowerCase());

      // Prefill "start number" input with the next number (last+1) only if auto
      if (startNumberInput) {
        const next = Math.max(1, lastNum + 1);
        startNumberInput.value = currentMode === 'auto' ? String(next) : '';
      }

      // Clear messages
      setMsg(prefixMsg, '');
      setMsg(layoutMsg, '');
      setMsg(nextNumberMsg, '');
      setMsg(taxDefaultsMsg, '');
      setMsg(modeMsg, '');

    } catch (err) {
      console.error(err);
      setMsg(prefixMsg, 'Error loading settings', 'red');
      setMsg(layoutMsg, 'Error loading settings', 'red');
      setMsg(nextNumberMsg, 'Error loading numbering', 'red');
      setMsg(taxDefaultsMsg, 'Error loading tax defaults', 'red');
      setMsg(modeMsg, 'Error loading mode', 'red');
    }
  }

  // Initial load
  loadInvoiceSettings();

  // ---------------- MODE BUTTONS ----------------
  modeAutoBtn?.addEventListener('click', () => setActiveMode('auto'));
  modeManualBtn?.addEventListener('click', () => setActiveMode('manual'));

  // ---------------- SAVE MODE (no start number here) ----------------
  saveNumberingModeBtn?.addEventListener('click', async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/invoice-settings/numbering`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numbering_mode: currentMode })
      });

      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || 'Failed to save numbering mode');

      setMsg(modeMsg, `Mode saved: ${out.numbering_mode}`, 'green');
      await loadInvoiceSettings();
    } catch (err) {
      console.error(err);
      setMsg(modeMsg, err.message || 'Error saving mode', 'red');
    }
  });

  // ---------------- SAVE NEXT NUMBER (AUTO) ----------------
  // Uses /numbering with start_number so it’s consistent with your backend behavior
  saveStartNumberBtn?.addEventListener('click', async () => {
    if (currentMode === 'manual') return;

    const start_number = Number(startNumberInput?.value);

    if (!Number.isFinite(start_number) || start_number < 1) {
      setMsg(nextNumberMsg, 'Start number must be >= 1', 'red');
      return;
    }

    try {
      const res = await fetch(`${BASE_URL}/api/invoice-settings/numbering`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          numbering_mode: 'auto',
          start_number
        })
      });

      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || 'Failed to save next invoice number');

      setMsg(nextNumberMsg, `Next invoice number set. (counter updated)`, 'green');
      await loadInvoiceSettings();

    } catch (err) {
      console.error(err);
      setMsg(nextNumberMsg, err.message || 'Error saving next number', 'red');
    }
  });

  // ---------------- SAVE PREFIX ----------------
  savePrefixBtn?.addEventListener('click', async () => {
    const prefix = (invoicePrefixInput?.value || '').trim();

    if (prefix.length < 2) {
      setMsg(prefixMsg, 'Prefix must be at least 2 characters', 'red');
      return;
    }

    try {
      const res = await fetch(`${BASE_URL}/api/invoice-settings/prefix`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix })
      });

      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || 'Failed to save prefix');

      setMsg(prefixMsg, 'Prefix saved!', 'green');
      await loadInvoiceSettings();
    } catch (err) {
      console.error(err);
      setMsg(prefixMsg, err.message || 'Error saving prefix', 'red');
    }
  });

  // ---------------- SAVE LAYOUT ----------------
  saveLayoutBtn?.addEventListener('click', async () => {
    const layout = invoiceLayoutSelect?.value;

    if (!layout) {
      setMsg(layoutMsg, 'Layout is required', 'red');
      return;
    }

    try {
      const res = await fetch(`${BASE_URL}/api/invoice-settings/layout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout })
      });

      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || 'Failed to save layout');

      setMsg(layoutMsg, 'Layout saved!', 'green');
    } catch (err) {
      console.error(err);
      setMsg(layoutMsg, err.message || 'Error saving layout', 'red');
    }
  });

  // ---------------- SAVE TAX DEFAULTS ----------------
  saveTaxDefaultsBtn?.addEventListener('click', async () => {
    const sales_tax_default = salesTaxDefaultSelect?.value || 'inclusive';
    const purchase_tax_default = purchaseTaxDefaultSelect?.value || 'inclusive';

    try {
      const res = await fetch(`${BASE_URL}/api/invoice-settings/tax-defaults`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sales_tax_default, purchase_tax_default })
      });

      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || 'Failed to save tax defaults');

      setMsg(taxDefaultsMsg, 'Tax defaults saved!', 'green');
      await loadInvoiceSettings();
    } catch (err) {
      console.error(err);
      setMsg(taxDefaultsMsg, err.message || 'Error saving tax defaults', 'red');
    }
  });
});
