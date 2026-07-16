import { useEffect, useMemo, useState } from "react";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import "./AccountAnalysis.css";
import "./Form2307.css";

const API_URL = import.meta.env.VITE_API_URL || "";

const QUARTERS = [
  { value: 1, label: "Q1 (Jan - Mar)" },
  { value: 2, label: "Q2 (Apr - Jun)" },
  { value: 3, label: "Q3 (Jul - Sep)" },
  { value: 4, label: "Q4 (Oct - Dec)" },
];

const MONTH_NAMES = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export default function Form2307() {
  const [suppliers, setSuppliers] = useState([]);
  const [supplierId, setSupplierId] = useState("");
  const [year, setYear] = useState(new Date().getFullYear());
  const [quarter, setQuarter] = useState(Math.floor(new Date().getMonth() / 3) + 1);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState(false);

  useEffect(() => {
    loadSuppliers();
  }, []);

  async function loadSuppliers() {
    try {
      const res = await fetch(`${API_URL}/api/genlib`, { credentials: "include" });
      const data = await res.json();
      setSuppliers(Array.isArray(data) ? data.filter((p) => p.type === "SUPPLIER") : []);
    } catch (err) {
      console.error("Failed to load suppliers:", err);
    }
  }

  const formatMoney = (amount) =>
    Number(amount || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const periodLabel = useMemo(() => {
    if (!report) return "";
    const { firstMonth, thirdMonth, year } = report.period;
    const lastDay = new Date(year, thirdMonth, 0).getDate();
    return `${MONTH_NAMES[firstMonth]} 1, ${year} to ${MONTH_NAMES[thirdMonth]} ${lastDay}, ${year}`;
  }, [report]);

  async function downloadPdf() {
    if (!report) {
      alert("Please generate the certificate first.");
      return;
    }

    const res = await fetch("/all_image/2307-template.pdf");
    const templateBytes = await res.arrayBuffer();
    const pdf = await PDFDocument.load(templateBytes);
    const page = pdf.getPages()[0];
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);
    const H = page.getHeight();

    // The template's fields were located by overlaying a coordinate grid on a real
    // Excel-rendered copy of 2307.XLT and reading off exact positions - these are not
    // guesses, they were calibrated against the actual official form.
    const y = (topDist) => H - topDist;
    const draw = (text, x, topDist, opts = {}) => {
      if (!text) return;
      page.drawText(String(text), {
        x,
        y: y(topDist),
        size: opts.size || 8,
        font: opts.bold ? boldFont : font,
        color: rgb(0, 0, 0),
      });
    };
    const drawRight = (text, xRight, topDist, opts = {}) => {
      const size = opts.size || 7;
      const useFont = opts.bold ? boldFont : font;
      const str = String(text);
      const w = useFont.widthOfTextAtSize(str, size);
      page.drawText(str, { x: xRight - w, y: y(topDist), size, font: useFont, color: rgb(0, 0, 0) });
    };
    // Covers a pre-existing "-" placeholder baked into the template's Total row before
    // drawing a new value on top of it, so the placeholder doesn't show through.
    const eraseRect = (xLeft, xRight, topDist, height = 9) => {
      page.drawRectangle({
        x: xLeft,
        y: y(topDist) - 2,
        width: xRight - xLeft,
        height,
        color: rgb(1, 1, 1),
      });
    };

    const y2 = String(report.period.year).slice(-2);
    const firstDayStr = `${String(report.period.firstMonth).padStart(2, "0")}/01/${y2}`;
    const lastDayNum = new Date(report.period.year, report.period.thirdMonth, 0).getDate();
    const lastDayStr = `${String(report.period.thirdMonth).padStart(2, "0")}/${lastDayNum}/${y2}`;
    draw(firstDayStr, 150, 129);
    draw(lastDayStr, 335, 129);

    draw(report.payee.tin || "-", 178, 152);
    draw(report.payee.name || "-", 178, 169);
    draw(report.payee.address || "-", 178, 189);

    draw(report.payor.payorTin || "-", 178, 228);
    draw(report.payor.payorName || "-", 178, 248);
    draw(report.payor.payorAddress || "-", 178, 276);
    draw(report.payor.payorZip || "", 522, 276);

    const cols = { atc: 341, m1: 392, m2: 443, m3: 494, total: 545, tw: 595 };
    const rowHeight = 10.2;
    const maxRows = 13;
    const lines = report.lines.slice(0, maxRows);

    let rowY = 342;
    lines.forEach((line) => {
      drawRight(line.atcCode, cols.atc - 3, rowY, { size: 7 });
      drawRight(formatMoney(line.month1Amount), cols.m1 - 5, rowY, { size: 7 });
      drawRight(formatMoney(line.month2Amount), cols.m2 - 5, rowY, { size: 7 });
      drawRight(formatMoney(line.month3Amount), cols.m3 - 5, rowY, { size: 7 });
      drawRight(formatMoney(line.totalAmount), cols.total - 5, rowY, { size: 7 });
      drawRight(formatMoney(line.totalTaxWithheld), cols.tw - 8, rowY, { size: 7 });
      rowY += rowHeight;
    });

    const totalRowY = 475;
    [
      [cols.m1, report.totals.month1Amount],
      [cols.m2, report.totals.month2Amount],
      [cols.m3, report.totals.month3Amount],
      [cols.total, report.totals.totalAmount],
    ].forEach(([xRight]) => eraseRect(xRight - 55, xRight, totalRowY));
    eraseRect(cols.tw - 60, cols.tw, totalRowY);

    drawRight(formatMoney(report.totals.month1Amount), cols.m1 - 5, totalRowY, { size: 7, bold: true });
    drawRight(formatMoney(report.totals.month2Amount), cols.m2 - 5, totalRowY, { size: 7, bold: true });
    drawRight(formatMoney(report.totals.month3Amount), cols.m3 - 5, totalRowY, { size: 7, bold: true });
    drawRight(formatMoney(report.totals.totalAmount), cols.total - 5, totalRowY, { size: 7, bold: true });
    drawRight(formatMoney(report.totals.totalTaxWithheld), cols.tw - 8, totalRowY, { size: 7, bold: true });

    const bytes = await pdf.save();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    const fileNameSafe = (report.payee.name || "payee").replace(/[^a-z0-9]+/gi, "_");
    link.href = url;
    link.download = `BIR_2307_${fileNameSafe}_Q${report.period.quarter}_${report.period.year}.pdf`;
    link.click();

    URL.revokeObjectURL(url);
  }

  function downloadCSV() {
    if (!report) {
      alert("Please generate the certificate first.");
      return;
    }

    const m1 = MONTH_NAMES[report.period.firstMonth];
    const m2 = MONTH_NAMES[report.period.secondMonth];
    const m3 = MONTH_NAMES[report.period.thirdMonth];

    const csvRows = [
      ["BIR FORM 2307 - CERTIFICATE OF CREDITABLE TAX WITHHELD AT SOURCE"],
      [`For the Period: ${periodLabel}`],
      [],
      ["PAYEE INFORMATION"],
      ["TIN", report.payee.tin || "-"],
      ["Name", report.payee.name || "-"],
      ["Registered Address", report.payee.address || "-"],
      [],
      ["PAYOR INFORMATION"],
      ["TIN", report.payor.payorTin || "-"],
      ["Name", report.payor.payorName || "-"],
      ["Registered Address", report.payor.payorAddress || "-"],
      ["Zip Code", report.payor.payorZip || "-"],
      [],
      ["ATC", m1, m2, m3, "Total", "Tax Withheld For the Quarter"],
      ...report.lines.map((line) => [
        line.atcCode,
        Number(line.month1Amount || 0).toFixed(2),
        Number(line.month2Amount || 0).toFixed(2),
        Number(line.month3Amount || 0).toFixed(2),
        Number(line.totalAmount || 0).toFixed(2),
        Number(line.totalTaxWithheld || 0).toFixed(2),
      ]),
      [
        "Total",
        Number(report.totals.month1Amount || 0).toFixed(2),
        Number(report.totals.month2Amount || 0).toFixed(2),
        Number(report.totals.month3Amount || 0).toFixed(2),
        Number(report.totals.totalAmount || 0).toFixed(2),
        Number(report.totals.totalTaxWithheld || 0).toFixed(2),
      ],
    ];

    const csvContent = csvRows
      .map((row) =>
        row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")
      )
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    const fileNameSafe = (report.payee.name || "payee").replace(/[^a-z0-9]+/gi, "_");
    link.href = url;
    link.download = `BIR_2307_${fileNameSafe}_Q${report.period.quarter}_${report.period.year}.csv`;
    link.click();

    URL.revokeObjectURL(url);
  }

  async function generateReport() {
    if (!supplierId) {
      alert("Please select a payee (supplier) first.");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch(
        `${API_URL}/api/reports/2307?supplierId=${supplierId}&year=${year}&quarter=${quarter}`
      );

      if (!res.ok) throw new Error("Failed to generate 2307 report");

      const data = await res.json();
      setReport(data);
      setGenerated(true);
    } catch (err) {
      console.error(err);
      alert("Failed to generate BIR Form 2307. Please check backend/server.");
      setReport(null);
      setGenerated(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="aa-page">
      <div className="aa-header">
        <h1>BIR Form 2307 - Certificate of Creditable Tax Withheld</h1>
      </div>

      <div className="aa-filters">
        <h2>Report Filters</h2>

        <div className="aa-filter-grid">
          <div>
            <label>Payee (Supplier)</label>
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Select supplier</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.code} - {s.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label>Year</label>
            <input
              type="number"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              min="2000"
              max="2100"
            />
          </div>

          <div>
            <label>Quarter</label>
            <select value={quarter} onChange={(e) => setQuarter(Number(e.target.value))}>
              {QUARTERS.map((q) => (
                <option key={q.value} value={q.value}>{q.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="aa-actions">
          <button className="primary" onClick={generateReport} disabled={loading}>
            {loading ? "Generating..." : "Generate Certificate"}
          </button>

          <button
            className="secondary"
            onClick={() => {
              setReport(null);
              setGenerated(false);
            }}
          >
            Clear
          </button>

          <button className="dark" onClick={() => window.print()}>
            Print (Browser View)
          </button>

          <button className="dark" onClick={downloadPdf}>
            Export PDF (Official Template)
          </button>

          <button className="dark" onClick={downloadCSV}>
            Export CSV
          </button>
        </div>
      </div>

      {generated && report && (
        <div className="aa-report-card form2307">
          <div className="f2307-header">
            <div className="f2307-header-left">
              <p>Republic of the Philippines</p>
              <p>Department of Finance</p>
              <p><strong>Bureau of Internal Revenue</strong></p>
            </div>
            <div className="f2307-header-right">
              <p><strong>BIR Form No. 2307</strong></p>
              <p>Certificate of Creditable Tax Withheld at Source</p>
            </div>
          </div>

          <div className="f2307-period">
            <strong>For the Period:</strong> {periodLabel}
          </div>

          <div className="f2307-part-title">PART I &mdash; Payee Information</div>

          <table className="f2307-info-table">
            <tbody>
              <tr>
                <td className="f2307-label">Taxpayer Identification Number (TIN)</td>
                <td>{report.payee.tin || "-"}</td>
              </tr>
              <tr>
                <td className="f2307-label">Payee's Name</td>
                <td>{report.payee.name}</td>
              </tr>
              <tr>
                <td className="f2307-label">Registered Address</td>
                <td>{report.payee.address || "-"}</td>
              </tr>
            </tbody>
          </table>

          <div className="f2307-part-title">Payor Information</div>

          <table className="f2307-info-table">
            <tbody>
              <tr>
                <td className="f2307-label">Taxpayer Identification Number (TIN)</td>
                <td>{report.payor.payorTin || "-"}</td>
              </tr>
              <tr>
                <td className="f2307-label">Payor's Name</td>
                <td>{report.payor.payorName || "-"}</td>
              </tr>
              <tr>
                <td className="f2307-label">Registered Address</td>
                <td>
                  {report.payor.payorAddress || "-"}
                  {report.payor.payorZip ? `, ${report.payor.payorZip}` : ""}
                </td>
              </tr>
            </tbody>
          </table>

          <div className="f2307-part-title">
            PART II &mdash; Details of Monthly Income Payments and Tax Withheld for the Quarter
          </div>

          <table className="f2307-ewt-table">
            <thead>
              <tr>
                <th rowSpan="2">ATC</th>
                <th colSpan="4">Amount of Income Payments</th>
                <th rowSpan="2">Tax Withheld<br />For the Quarter</th>
              </tr>
              <tr>
                <th>{MONTH_NAMES[report.period.firstMonth]}</th>
                <th>{MONTH_NAMES[report.period.secondMonth]}</th>
                <th>{MONTH_NAMES[report.period.thirdMonth]}</th>
                <th>Total</th>
              </tr>
            </thead>

            <tbody>
              {report.lines.length === 0 ? (
                <tr>
                  <td colSpan="6" className="empty">
                    No withholding tax transactions found for this payee this quarter.
                  </td>
                </tr>
              ) : (
                report.lines.map((line, index) => (
                  <tr key={index}>
                    <td>{line.atcCode}</td>
                    <td className="amount">{formatMoney(line.month1Amount)}</td>
                    <td className="amount">{formatMoney(line.month2Amount)}</td>
                    <td className="amount">{formatMoney(line.month3Amount)}</td>
                    <td className="amount">{formatMoney(line.totalAmount)}</td>
                    <td className="amount">{formatMoney(line.totalTaxWithheld)}</td>
                  </tr>
                ))
              )}
            </tbody>

            <tfoot>
              <tr>
                <td style={{ textAlign: "center" }}>Total</td>
                <td className="amount">{formatMoney(report.totals.month1Amount)}</td>
                <td className="amount">{formatMoney(report.totals.month2Amount)}</td>
                <td className="amount">{formatMoney(report.totals.month3Amount)}</td>
                <td className="amount">{formatMoney(report.totals.totalAmount)}</td>
                <td className="amount">{formatMoney(report.totals.totalTaxWithheld)}</td>
              </tr>
            </tfoot>
          </table>

          <p className="f2307-declaration">
            We declare under the penalties of perjury that this certificate has been made in
            good faith, verified by us, and to the best of our knowledge and belief, is true
            and correct, pursuant to the provisions of the National Internal Revenue Code, as
            amended, and the regulations issued under authority thereof.
          </p>

          <div className="f2307-signatures">
            <div className="f2307-sig-block">
              <div className="f2307-sig-line"></div>
              <p>Signature over Printed Name of Payor / Payor's Authorized Representative / Tax Agent</p>
              <p className="f2307-sig-sub">(Indicate Title/Designation and TIN)</p>
            </div>

            <div className="f2307-sig-block">
              <div className="f2307-sig-line"></div>
              <p>Signature over Printed Name of Payee / Payee's Authorized Representative / Tax Agent</p>
              <p className="f2307-sig-sub">(Indicate Title/Designation and TIN)</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
