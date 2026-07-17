import React, { useEffect, useState } from "react";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import "./TransactionFormLayout.css";
import "./Quotation.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

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

function createItemLine() {
  return {
    id: crypto.randomUUID(),
    lineType: "item",
    description: "",
    notes: "",
    quantity: 1,
    unitLabel: "Units",
    unitPrice: "",
    taxRate: 12,
  };
}

function createSectionLine() {
  return {
    id: crypto.randomUUID(),
    lineType: "section",
    description: "",
  };
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function lineAmount(line) {
  return (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0);
}

function lineTax(line) {
  return lineAmount(line) * ((Number(line.taxRate) || 0) / 100);
}

// Section rows show the sum of every item row beneath them, up to the next section.
function computeSectionTotals(lines) {
  const totals = {};
  let currentSectionId = null;

  lines.forEach((line) => {
    if (line.lineType === "section") {
      currentSectionId = line.id;
      totals[currentSectionId] = 0;
    } else if (currentSectionId) {
      totals[currentSectionId] += lineAmount(line);
    }
  });

  return totals;
}

const emptyForm = {
  customerId: null,
  customerName: "",
  customerAddress: "",
  contactName: "",
  quotationDate: new Date().toISOString().split("T")[0],
  expirationDate: "",
  notes: "",
};

export default function Quotation() {
  const [mode, setMode] = useState("list");
  const [quotations, setQuotations] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [selected, setSelected] = useState(null);

  const [form, setForm] = useState(emptyForm);
  const [lines, setLines] = useState([createItemLine()]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadQuotations();
    loadCustomers();
  }, []);

  async function loadQuotations() {
    try {
      const res = await fetch(`${API_BASE}/api/quotations`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const data = await res.json();

      if (!res.ok) {
        handleAuthError(res.status);
        return;
      }

      setQuotations(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("LOAD QUOTATIONS ERROR:", err);
    }
  }

  async function loadCustomers() {
    try {
      const res = await fetch(`${API_BASE}/api/genlib`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const data = await res.json();

      if (!res.ok) {
        handleAuthError(res.status);
        return;
      }

      setCustomers(
        Array.isArray(data)
          ? data.filter((p) => p.type === "CUSTOMER" && p.status === "ACTIVE")
          : []
      );
    } catch (err) {
      console.error("LOAD CUSTOMERS ERROR:", err);
    }
  }

  function handleAddNew() {
    setSelected(null);
    setForm(emptyForm);
    setLines([createItemLine()]);
    setMode("form");
  }

  async function handleView(quotation) {
    try {
      const res = await fetch(`${API_BASE}/api/quotations/${quotation.id}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to load Quotation details");
        return;
      }

      setSelected(data);
      setForm({
        customerId: data.customerId,
        customerName: data.customerName || "",
        customerAddress: data.customerAddress || "",
        contactName: data.contactName || "",
        quotationDate: data.quotationDate || emptyForm.quotationDate,
        expirationDate: data.expirationDate || "",
        notes: data.notes || "",
      });
      setLines(
        (data.lines || []).length > 0
          ? data.lines.map((line) => ({
              id: crypto.randomUUID(),
              lineType: line.lineType,
              description: line.description || "",
              notes: line.notes || "",
              quantity: line.quantity,
              unitLabel: line.unitLabel,
              unitPrice: line.unitPrice,
              taxRate: line.taxRate,
            }))
          : [createItemLine()]
      );
      setMode("form");
    } catch (err) {
      console.error("LOAD QUOTATION DETAILS ERROR:", err);
      alert("Unable to connect to server.");
    }
  }

  function handlePartyChange(customerIdStr) {
    const customer = customers.find((c) => String(c.id) === customerIdStr);

    setForm((prev) => ({
      ...prev,
      customerId: customer ? customer.id : null,
      customerName: customer ? customer.name : prev.customerName,
      customerAddress: customer
        ? [customer.address1, customer.address2, customer.address3].filter(Boolean).join(", ")
        : prev.customerAddress,
      contactName: customer?.attention || prev.contactName,
    }));
  }

  function updateLine(id, field, value) {
    setLines((prev) =>
      prev.map((line) => (line.id === id ? { ...line, [field]: value } : line))
    );
  }

  function removeLine(id) {
    setLines((prev) => (prev.length > 1 ? prev.filter((line) => line.id !== id) : prev));
  }

  const sectionTotals = computeSectionTotals(lines);
  const itemLines = lines.filter((l) => l.lineType === "item");
  const subtotal = itemLines.reduce((sum, l) => sum + lineAmount(l), 0);
  const taxTotal = itemLines.reduce((sum, l) => sum + lineTax(l), 0);
  const grandTotal = subtotal + taxTotal;

  function validate() {
    if (!form.customerName.trim()) return "Please select or enter a customer.";
    if (!form.quotationDate) return "Quotation date is required.";
    if (itemLines.length === 0) return "Add at least one item line.";
    for (const line of itemLines) {
      if (!line.description.trim()) return "Every item line needs a description.";
      if (!(Number(line.quantity) > 0)) return "Every item line needs a quantity greater than zero.";
    }
    return "";
  }

  async function handleSave(status) {
    const error = validate();
    if (error) {
      alert(error);
      return;
    }

    setSaving(true);

    try {
      const payload = {
        customerId: form.customerId,
        customerName: form.customerName,
        customerAddress: form.customerAddress,
        contactName: form.contactName,
        quotationDate: form.quotationDate,
        expirationDate: form.expirationDate || null,
        status,
        notes: form.notes,
        totalAmount: grandTotal,
        lines: lines.map((line) => ({
          lineType: line.lineType,
          description: line.description,
          notes: line.lineType === "item" ? line.notes : "",
          quantity: line.lineType === "item" ? line.quantity : 0,
          unitLabel: line.unitLabel,
          unitPrice: line.lineType === "item" ? line.unitPrice : 0,
          taxRate: line.lineType === "item" ? line.taxRate : 0,
          amount:
            line.lineType === "item" ? lineAmount(line) : sectionTotals[line.id] || 0,
        })),
      };

      const isExisting = selected?.id;
      const res = await fetch(
        isExisting ? `${API_BASE}/api/quotations/${selected.id}` : `${API_BASE}/api/quotations`,
        {
          method: isExisting ? "PUT" : "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          credentials: "include",
          body: JSON.stringify(payload),
        }
      );

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to save Quotation.");
        return;
      }

      alert(`Quotation ${status === "Sent" ? "sent" : "saved"} successfully.`);
      await loadQuotations();
      setMode("list");
    } catch (err) {
      console.error("SAVE QUOTATION ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setSaving(false);
    }
  }

  async function handleConvertToInvoice(quotation) {
    if (
      !window.confirm(
        `Convert ${quotation.quotationNo} to an Invoice for ₱ ${formatMoney(
          quotation.totalAmount
        )}?`
      )
    ) {
      return;
    }

    try {
      const res = await fetch(
        `${API_BASE}/api/quotations/${quotation.id}/convert-to-invoice`,
        {
          method: "POST",
          credentials: "include",
          headers: authHeaders(),
        }
      );

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to convert Quotation to Invoice.");
        return;
      }

      alert(`Converted to Invoice ${data.voucherNo}.`);
      await loadQuotations();
    } catch (err) {
      console.error("CONVERT TO INVOICE ERROR:", err);
      alert("Unable to connect to server.");
    }
  }

  async function handleDelete(quotation) {
    if (!window.confirm(`Delete Quotation ${quotation.quotationNo}?`)) return;

    try {
      const res = await fetch(`${API_BASE}/api/quotations/${quotation.id}`, {
        method: "DELETE",
        credentials: "include",
        headers: authHeaders(),
      });
      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to delete Quotation.");
        return;
      }

      await loadQuotations();
    } catch (err) {
      console.error("DELETE QUOTATION ERROR:", err);
      alert("Unable to connect to server.");
    }
  }

  function displayStatus(quotation) {
    if (quotation.status === "Converted") return "Converted";
    if (
      quotation.expirationDate &&
      new Date(quotation.expirationDate) < new Date(new Date().toDateString())
    ) {
      return "Expired";
    }
    return quotation.status;
  }

  function downloadCSV() {
    if (!selected && mode !== "form") {
      alert("Please open or create a Quotation first.");
      return;
    }

    const csvRows = [
      ["QUOTATION", selected?.quotationNo || "(unsaved)"],
      ["Customer", form.customerName],
      ["Address", form.customerAddress],
      ["Contact", form.contactName],
      ["Quotation Date", form.quotationDate],
      ["Expiration", form.expirationDate],
      [],
      ["Description", "Qty", "Unit", "Unit Price", "Tax %", "Amount"],
      ...lines.map((line) =>
        line.lineType === "section"
          ? [line.description, "", "", "", "", (sectionTotals[line.id] || 0).toFixed(2)]
          : [
              line.description + (line.notes ? ` (${line.notes.replace(/\n/g, "; ")})` : ""),
              line.quantity,
              line.unitLabel,
              Number(line.unitPrice || 0).toFixed(2),
              `${line.taxRate}%`,
              lineAmount(line).toFixed(2),
            ]
      ),
      [],
      ["", "", "", "", "Subtotal", subtotal.toFixed(2)],
      ["", "", "", "", "Tax", taxTotal.toFixed(2)],
      ["", "", "", "", "Total", grandTotal.toFixed(2)],
    ];

    const csv = csvRows
      .map((row) => row.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Quotation_${selected?.quotationNo || "draft"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function downloadPDF() {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]); // US Letter, matches the reference template
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);
    const italicFont = await pdf.embedFont(StandardFonts.HelveticaOblique);
    const orange = rgb(0.976, 0.647, 0.145);
    const darkText = rgb(0.13, 0.15, 0.19);
    const grey = rgb(0.42, 0.45, 0.5);
    const lightGrey = rgb(0.95, 0.95, 0.96);

    let y = 792;
    const marginX = 40;
    const pageWidth = 612;

    const drawText = (text, x, yPos, opts = {}) => {
      page.drawText(String(text ?? ""), {
        x,
        y: yPos,
        size: opts.size || 10,
        font: opts.bold ? boldFont : opts.italic ? italicFont : font,
        color: opts.color || darkText,
      });
    };

    const drawRight = (text, xRight, yPos, opts = {}) => {
      const size = opts.size || 10;
      const useFont = opts.bold ? boldFont : opts.italic ? italicFont : font;
      const str = String(text ?? "");
      const w = useFont.widthOfTextAtSize(str, size);
      drawText(str, xRight - w, yPos, opts);
    };

    // Header band
    page.drawRectangle({ x: 0, y: y - 90, width: pageWidth, height: 90, color: lightGrey });
    drawRight(
      `Quotation # ${selected?.quotationNo || "(unsaved)"}`,
      pageWidth - marginX,
      y - 45,
      { size: 22, bold: true, color: orange }
    );

    y -= 105;
    drawText("Business Set Up & Compliance Inc. (BSU)", marginX, y, { bold: true, size: 11 });
    y -= 15;
    drawText(form.customerName || "Customer", marginX, y, { size: 10 });
    y -= 14;
    (form.customerAddress || "").split(",").forEach((part) => {
      if (!part.trim()) return;
      drawText(part.trim(), marginX, y, { size: 10, color: grey });
      y -= 13;
    });

    y -= 10;
    page.drawRectangle({ x: marginX, y: y - 45, width: pageWidth - marginX * 2, height: 45, color: lightGrey });
    drawText("Quotation Date", marginX + 10, y - 18, { bold: true, size: 9 });
    drawText(form.quotationDate || "-", marginX + 10, y - 33, { size: 10 });
    drawText("Expiration", marginX + 200, y - 18, { bold: true, size: 9 });
    drawText(form.expirationDate || "-", marginX + 200, y - 33, { size: 10 });
    drawText("Contact", marginX + 380, y - 18, { bold: true, size: 9 });
    drawText(form.contactName || "-", marginX + 380, y - 33, { size: 10 });
    y -= 65;

    // Table header
    const col = { desc: marginX, qty: 330, price: 390, tax: 450, amt: pageWidth - marginX };
    page.drawRectangle({ x: marginX, y: y - 22, width: pageWidth - marginX * 2, height: 22, color: orange });
    drawText("Description", col.desc + 6, y - 15, { bold: true, size: 9, color: rgb(1, 1, 1) });
    drawText("Qty", col.qty, y - 15, { bold: true, size: 9, color: rgb(1, 1, 1) });
    drawText("Unit Price", col.price, y - 15, { bold: true, size: 9, color: rgb(1, 1, 1) });
    drawText("Tax", col.tax, y - 15, { bold: true, size: 9, color: rgb(1, 1, 1) });
    drawRight("Amount", col.amt, y - 15, { bold: true, size: 9, color: rgb(1, 1, 1) });
    y -= 22;

    const ensureRoom = (needed) => {
      if (y - needed < 60) {
        y = 792;
        const newPage = pdf.addPage([612, 792]);
        return newPage;
      }
      return null;
    };

    let activePage = page;
    const redrawOn = (p) => {
      activePage = p;
    };

    for (const line of lines) {
      if (line.lineType === "section") {
        const np = ensureRoom(26);
        if (np) redrawOn(np);
        activePage.drawRectangle({
          x: marginX,
          y: y - 22,
          width: pageWidth - marginX * 2,
          height: 22,
          color: lightGrey,
        });
        activePage.drawText(line.description || "", {
          x: col.desc + 6,
          y: y - 15,
          size: 10,
          font: boldFont,
          color: darkText,
        });
        const secTotal = sectionTotals[line.id] || 0;
        const secStr = `P ${formatMoney(secTotal)}`;
        const w = boldFont.widthOfTextAtSize(secStr, 10);
        activePage.drawText(secStr, { x: col.amt - w, y: y - 15, size: 10, font: boldFont, color: darkText });
        y -= 22;
        continue;
      }

      const noteLines = (line.notes || "").split("\n").filter(Boolean);
      const rowHeight = 24 + noteLines.length * 12;
      const np = ensureRoom(rowHeight);
      if (np) redrawOn(np);

      activePage.drawText(line.description || "", {
        x: col.desc + 6,
        y: y - 15,
        size: 9.5,
        font,
        color: darkText,
      });
      activePage.drawText(`${formatMoney(line.quantity)} ${line.unitLabel || ""}`, {
        x: col.qty,
        y: y - 15,
        size: 9,
        font,
        color: darkText,
      });
      activePage.drawText(formatMoney(line.unitPrice), { x: col.price, y: y - 15, size: 9, font, color: darkText });
      activePage.drawText(`${line.taxRate}%`, { x: col.tax, y: y - 15, size: 9, font, color: darkText });
      const amtStr = `P ${formatMoney(lineAmount(line))}`;
      const amtW = font.widthOfTextAtSize(amtStr, 9.5);
      activePage.drawText(amtStr, { x: col.amt - amtW, y: y - 15, size: 9.5, font, color: darkText });

      y -= 20;
      noteLines.forEach((note) => {
        activePage.drawText(note, { x: col.desc + 10, y: y - 8, size: 8, font: italicFont, color: grey });
        y -= 12;
      });
      y -= 4;

      activePage.drawLine({
        start: { x: marginX, y },
        end: { x: pageWidth - marginX, y },
        thickness: 0.5,
        color: rgb(0.9, 0.9, 0.9),
      });
    }

    y -= 15;
    const np = ensureRoom(70);
    if (np) redrawOn(np);

    drawRight("Subtotal", col.tax - 10, y, { size: 9.5, color: grey });
    drawRight(`P ${formatMoney(subtotal)}`, col.amt, y, { size: 9.5 });
    y -= 16;
    drawRight("Tax", col.tax - 10, y, { size: 9.5, color: grey });
    drawRight(`P ${formatMoney(taxTotal)}`, col.amt, y, { size: 9.5 });
    y -= 18;
    activePage.drawLine({
      start: { x: col.tax - 10, y: y + 10 },
      end: { x: pageWidth - marginX, y: y + 10 },
      thickness: 1,
      color: darkText,
    });
    drawRight("Total", col.tax - 10, y - 5, { size: 11, bold: true });
    drawRight(`P ${formatMoney(grandTotal)}`, col.amt, y - 5, { size: 11, bold: true });

    if (form.notes) {
      y -= 40;
      drawText("Notes", marginX, y, { bold: true, size: 9 });
      y -= 13;
      form.notes.split("\n").forEach((n) => {
        drawText(n, marginX, y, { size: 9, color: grey });
        y -= 12;
      });
    }

    const bytes = await pdf.save();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Quotation_${selected?.quotationNo || "draft"}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="transaction-page">
      <div className="transaction-wrapper">
        {mode === "list" && (
          <>
            <div className="transaction-topbar">
              <div>
                <h1 className="transaction-title">Quotation</h1>
                <p className="transaction-subtitle">
                  Create and manage sales quotations, then convert them to Invoices.
                </p>
              </div>

              <button className="transaction-primary-button" onClick={handleAddNew}>
                + Add Quotation
              </button>
            </div>

            <div className="transaction-card">
              <div className="transaction-table-container">
                <table className="transaction-table">
                  <thead>
                    <tr>
                      <th>Quotation No.</th>
                      <th>Date</th>
                      <th>Expiration</th>
                      <th>Customer</th>
                      <th className="text-right">Amount</th>
                      <th>Status</th>
                      <th className="text-center">Action</th>
                    </tr>
                  </thead>

                  <tbody>
                    {quotations.length === 0 ? (
                      <tr>
                        <td colSpan="7" className="transaction-empty">
                          No quotations yet. Click Add Quotation to create one.
                        </td>
                      </tr>
                    ) : (
                      quotations.map((q) => (
                        <tr key={q.id}>
                          <td>{q.quotationNo}</td>
                          <td>{q.quotationDate}</td>
                          <td>{q.expirationDate || "-"}</td>
                          <td>{q.customerName}</td>
                          <td className="text-right">₱ {formatMoney(q.totalAmount)}</td>
                          <td>
                            <span
                              className={`transaction-status-badge quo-status-${displayStatus(
                                q
                              ).toLowerCase()}`}
                            >
                              {displayStatus(q)}
                            </span>
                          </td>
                          <td className="text-center">
                            <div className="quo-action-group">
                              <button className="transaction-view-button" onClick={() => handleView(q)}>
                                View / Edit
                              </button>
                              {q.status !== "Converted" && (
                                <button
                                  className="quo-convert-button"
                                  onClick={() => handleConvertToInvoice(q)}
                                >
                                  Convert to Invoice
                                </button>
                              )}
                              <button className="quo-delete-button" onClick={() => handleDelete(q)}>
                                Delete
                              </button>
                            </div>
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
                  {selected ? selected.quotationNo : "New Quotation"}
                </h1>
                <p className="transaction-subtitle">
                  {selected
                    ? `Status: ${displayStatus(selected)}`
                    : "Quotation number is assigned when you save."}
                </p>
              </div>

              <div className="transaction-form-top-actions">
                <button className="transaction-secondary-button" onClick={() => setMode("list")}>
                  Back to List
                </button>
                <button className="transaction-secondary-button" onClick={downloadCSV}>
                  Export CSV
                </button>
                <button className="transaction-secondary-button" onClick={downloadPDF}>
                  Export PDF
                </button>
              </div>
            </div>

            {selected?.status === "Converted" && (
              <div className="transaction-error-box" style={{ background: "#eff6ff", borderColor: "#bfdbfe", color: "#1e3a8a" }}>
                This quotation has already been converted to an Invoice and is now read-only.
              </div>
            )}

            <div className="transaction-card">
              <div className="transaction-grid">
                <div className="transaction-field">
                  <label className="transaction-label">Customer</label>
                  <select
                    className="transaction-input"
                    value={form.customerId || ""}
                    onChange={(e) => handlePartyChange(e.target.value)}
                    disabled={selected?.status === "Converted"}
                  >
                    <option value="">Select customer</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code} - {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="transaction-field">
                  <label className="transaction-label">Customer Name</label>
                  <input
                    className="transaction-input"
                    value={form.customerName}
                    onChange={(e) => setForm((p) => ({ ...p, customerName: e.target.value }))}
                    disabled={selected?.status === "Converted"}
                  />
                </div>

                <div className="transaction-field">
                  <label className="transaction-label">Contact</label>
                  <input
                    className="transaction-input"
                    value={form.contactName}
                    onChange={(e) => setForm((p) => ({ ...p, contactName: e.target.value }))}
                    disabled={selected?.status === "Converted"}
                  />
                </div>

                <div className="transaction-field">
                  <label className="transaction-label">Quotation Date</label>
                  <input
                    type="date"
                    className="transaction-input"
                    value={form.quotationDate}
                    onChange={(e) => setForm((p) => ({ ...p, quotationDate: e.target.value }))}
                    disabled={selected?.status === "Converted"}
                  />
                </div>

                <div className="transaction-field">
                  <label className="transaction-label">Expiration Date</label>
                  <input
                    type="date"
                    className="transaction-input"
                    value={form.expirationDate}
                    onChange={(e) => setForm((p) => ({ ...p, expirationDate: e.target.value }))}
                    disabled={selected?.status === "Converted"}
                  />
                </div>
              </div>

              <div className="transaction-field transaction-memo-wrap">
                <label className="transaction-label">Customer Address</label>
                <textarea
                  className="transaction-textarea"
                  rows={2}
                  value={form.customerAddress}
                  onChange={(e) => setForm((p) => ({ ...p, customerAddress: e.target.value }))}
                  disabled={selected?.status === "Converted"}
                />
              </div>
            </div>

            <div className="transaction-card">
              <div className="transaction-section-header">
                <div>
                  <h2 className="transaction-section-title">Line Items</h2>
                  <p className="transaction-section-subtext">
                    Add a section header to group related items, or add items directly.
                  </p>
                </div>

                {selected?.status !== "Converted" && (
                  <div className="quo-section-actions">
                    <button
                      className="transaction-add-button"
                      onClick={() => setLines((prev) => [...prev, createItemLine()])}
                    >
                      + Add Item
                    </button>
                    <button
                      className="transaction-add-button"
                      onClick={() => setLines((prev) => [...prev, createSectionLine()])}
                    >
                      + Add Section
                    </button>
                  </div>
                )}
              </div>

              <div className="quo-lines">
                {lines.map((line) =>
                  line.lineType === "section" ? (
                    <div className="quo-section-row" key={line.id}>
                      <input
                        className="quo-section-input"
                        placeholder="Section title (e.g. Smartboard Units)"
                        value={line.description}
                        onChange={(e) => updateLine(line.id, "description", e.target.value)}
                        disabled={selected?.status === "Converted"}
                      />
                      <span className="quo-section-total">
                        ₱ {formatMoney(sectionTotals[line.id] || 0)}
                      </span>
                      {selected?.status !== "Converted" && (
                        <button className="transaction-remove-button" onClick={() => removeLine(line.id)}>
                          Remove
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="quo-item-row" key={line.id}>
                      <div className="quo-item-main">
                        <input
                          className="transaction-table-input quo-desc-input"
                          placeholder="Item description"
                          value={line.description}
                          onChange={(e) => updateLine(line.id, "description", e.target.value)}
                          disabled={selected?.status === "Converted"}
                        />
                        <input
                          type="number"
                          className="transaction-table-input transaction-table-input-right quo-qty-input"
                          value={line.quantity}
                          onChange={(e) => updateLine(line.id, "quantity", e.target.value)}
                          disabled={selected?.status === "Converted"}
                        />
                        <input
                          className="transaction-table-input quo-unit-input"
                          value={line.unitLabel}
                          onChange={(e) => updateLine(line.id, "unitLabel", e.target.value)}
                          disabled={selected?.status === "Converted"}
                        />
                        <input
                          type="number"
                          className="transaction-table-input transaction-table-input-right quo-price-input"
                          value={line.unitPrice}
                          onChange={(e) => updateLine(line.id, "unitPrice", e.target.value)}
                          disabled={selected?.status === "Converted"}
                        />
                        <input
                          type="number"
                          className="transaction-table-input transaction-table-input-right quo-tax-input"
                          value={line.taxRate}
                          onChange={(e) => updateLine(line.id, "taxRate", e.target.value)}
                          disabled={selected?.status === "Converted"}
                        />
                        <span className="quo-amount-display">₱ {formatMoney(lineAmount(line))}</span>
                        {selected?.status !== "Converted" && (
                          <button className="transaction-remove-button" onClick={() => removeLine(line.id)}>
                            ✕
                          </button>
                        )}
                      </div>
                      <textarea
                        className="quo-notes-input"
                        placeholder="Optional spec notes (e.g. CPU, RAM, Storage - one per line)"
                        rows={2}
                        value={line.notes}
                        onChange={(e) => updateLine(line.id, "notes", e.target.value)}
                        disabled={selected?.status === "Converted"}
                      />
                    </div>
                  )
                )}
              </div>

              <div className="quo-totals">
                <div className="quo-totals-row">
                  <span>Subtotal</span>
                  <span>₱ {formatMoney(subtotal)}</span>
                </div>
                <div className="quo-totals-row">
                  <span>Tax</span>
                  <span>₱ {formatMoney(taxTotal)}</span>
                </div>
                <div className="quo-totals-row quo-totals-grand">
                  <span>Total</span>
                  <span>₱ {formatMoney(grandTotal)}</span>
                </div>
              </div>

              <div className="transaction-field transaction-memo-wrap">
                <label className="transaction-label">Notes / Terms</label>
                <textarea
                  className="transaction-textarea"
                  rows={2}
                  value={form.notes}
                  onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
                  disabled={selected?.status === "Converted"}
                />
              </div>
            </div>

            {selected?.status !== "Converted" && (
              <div className="transaction-bottom-bar">
                <button
                  className="transaction-secondary-button"
                  onClick={() => handleSave("Draft")}
                  disabled={saving}
                >
                  {saving ? "Saving..." : "Save as Draft"}
                </button>
                <button
                  className="transaction-primary-button"
                  onClick={() => handleSave("Sent")}
                  disabled={saving}
                >
                  {saving ? "Saving..." : "Save & Mark Sent"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
