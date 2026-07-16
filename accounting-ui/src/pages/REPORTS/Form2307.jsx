import { useEffect, useMemo, useState } from "react";
import ExcelJS from "exceljs";
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

  async function downloadExcel() {
    if (!report) {
      alert("Please generate the certificate first.");
      return;
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2307", { pageSetup: { paperSize: 9, orientation: "portrait" } });

    // Reproduce the official template's fine 44-column grid (A..AR)
    ws.columns = Array.from({ length: 44 }, () => ({ width: 2.2 }));

    const thin = { style: "thin" };
    const box = { top: thin, left: thin, bottom: thin, right: thin };
    const grey = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };

    const set = (addr, value, opts = {}) => {
      const cell = ws.getCell(addr);
      cell.value = value;
      cell.font = { name: "Arial", size: opts.size || 8, bold: !!opts.bold, italic: !!opts.italic };
      cell.alignment = {
        horizontal: opts.align || "left",
        vertical: "middle",
        wrapText: !!opts.wrap,
      };
      if (opts.border) cell.border = box;
      if (opts.grey) cell.fill = grey;
      return cell;
    };

    const merge = (range, value, opts = {}) => {
      ws.mergeCells(range);
      const topLeft = range.split(":")[0];
      return set(topLeft, value, opts);
    };

    // TIN written as grouped digit boxes (matches the official form's boxed TIN fields).
    // Boxes start at column N, leaving B:M free so the label text can overflow without
    // being cut off by the merged box (Excel blocks overflow at the first non-empty/merged cell).
    const writeTinBoxes = (row, tin) => {
      const digits = String(tin || "").replace(/\D/g, "");
      const groups = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9), digits.slice(9, 12)];
      const ranges = [`N${row}:P${row}`, `R${row}:T${row}`, `V${row}:X${row}`, `Z${row}:AB${row}`];
      ranges.forEach((range, i) => {
        merge(range, groups[i] || "", { align: "center", border: true, grey: i === 3 });
      });
    };

    // Top corner boxes
    merge("A1:E2", "For BIR\nUse Only", { size: 6, align: "center", wrap: true, border: true });
    merge("A3:E4", "BCS/\nItem:", { size: 6, align: "center", wrap: true, border: true });

    // Header
    set("P2", "Republic of the Philippines");
    merge("P3:AD3", "Department of Finance");
    merge("P4:AD4", "Bureau of Internal Revenue", { bold: true });

    set("AF2", "BIR Form No.", { bold: true, align: "center" });
    merge("AF3:AJ5", "2307", { bold: true, align: "center", size: 26 });
    set("AF6", "January 2018 (ENCS)", { size: 6, align: "center" });
    merge(
      "AL2:AR6",
      "Certificate of Creditable Tax Withheld At Source",
      { bold: true, align: "center", size: 12, wrap: true }
    );

    // BIR seal + barcode graphics
    const loadImageBase64 = async (url) => {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    };

    try {
      const [sealBase64, barcodeBase64] = await Promise.all([
        loadImageBase64("/all_image/bir-seal.png"),
        loadImageBase64("/all_image/bir-barcode-2307.png"),
      ]);

      const sealId = wb.addImage({ base64: `data:image/png;base64,${sealBase64}`, extension: "png" });
      ws.addImage(sealId, { tl: { col: 6, row: 0.2 }, ext: { width: 66, height: 57 } });

      const barcodeId = wb.addImage({ base64: `data:image/png;base64,${barcodeBase64}`, extension: "png" });
      ws.addImage(barcodeId, { tl: { col: 44, row: 0.3 }, ext: { width: 150, height: 36 } });
      set("AT7", "2307 01/18ENCS", { size: 6, align: "center" });
    } catch (err) {
      console.warn("Could not embed BIR seal/barcode images:", err);
    }

    merge(
      "A9:AR9",
      'Fill in all applicable spaces. Mark all appropriate boxes with an "X".',
      { bold: true, size: 8 }
    );

    // For the Period
    set("A11", "1", { bold: true });
    set("B11", "For the Period", { bold: true });
    set("B12", "From");

    const y2 = String(report.period.year).slice(-2);
    const firstDayStr = `${String(report.period.firstMonth).padStart(2, "0")}/01/${y2}`;
    const lastDayNum = new Date(report.period.year, report.period.thirdMonth, 0).getDate();
    const lastDayStr = `${String(report.period.thirdMonth).padStart(2, "0")}/${lastDayNum}/${y2}`;

    set("H12", firstDayStr, { border: true });
    set("N12", "(MM/DD/YY)", { size: 6 });
    set("U12", "To");
    set("W12", lastDayStr, { border: true });
    set("AE12", "(MM/DD/YY)", { size: 6 });

    // PART I - Payee Information
    merge("D13:AR13", "Payee   Information", { bold: true, grey: true });
    merge("A13:C13", "Part I", { bold: true, grey: true });

    set("A14", "2");
    set("B14", "Taxpayer");
    set("B15", "Identification Number");
    writeTinBoxes(14, report.payee.tin);

    set("A17", "3");
    set("B17", "Payee's Name");
    merge("N17:AR17", report.payee.name || "-", { border: true });
    merge(
      "N18:AR18",
      "(Last Name, First Name, Middle Name for Individuals) (Registered Name for Non-Individuals)",
      { size: 6 }
    );

    set("A19", "4");
    set("B19", "Registered Address");
    merge("N19:AI19", report.payee.address || "-", { border: true });
    set("AJ19", "4A");
    set("AK19", "Zip Code");

    set("A21", "5");
    set("B21", "Foreign Address");
    merge("N21:AI21", "", { border: true });
    set("AJ21", "5A");
    set("AK21", "Zip Code");

    // Payor Information
    merge("D23:AR23", "Payor   Information", { bold: true, grey: true });
    merge("A23:C23", "", { grey: true });

    set("A24", "6");
    set("B24", "Taxpayer");
    set("B25", "Identification Number");
    writeTinBoxes(24, report.payor.payorTin);

    set("A27", "7");
    set("B27", "Payor's Name");
    merge("N27:AR27", report.payor.payorName || "-", { border: true });
    merge(
      "N28:AR28",
      "(Last Name, First Name, Middle Name for Individuals) (Registered Name for Non-Individuals)",
      { size: 6 }
    );

    set("A29", "8");
    set("B29", "Registered Address");
    merge("N29:AI29", report.payor.payorAddress || "-", { border: true });
    set("AJ29", "8A");
    set("AK29", "Zip Code");
    merge("AL29:AR29", report.payor.payorZip || "-", { border: true });

    // PART II - EWT table
    merge(
      "D32:AR32",
      "Details of Monthly Income Payments and Tax Withheld for the Quarter",
      { bold: true, grey: true }
    );
    merge("A32:C32", "PART II", { bold: true, grey: true, size: 7 });

    const tableHeader = (row1) => {
      merge(`A${row1}:L${row1}`, "Income Payments Subject to", { bold: true, size: 7 });
      merge(`A${row1 + 1}:L${row1 + 1}`, "Expanded Withholding Tax", { bold: true, size: 7 });
      merge(`M${row1}:P${row1 + 1}`, "ATC", { bold: true, align: "center" });
      merge(`Q${row1}:AJ${row1}`, "AMOUNT OF INCOME PAYMENTS", { bold: true, align: "center" });
      merge(`Q${row1 + 1}:U${row1 + 1}`, "1st Month of", { bold: true, align: "center", size: 7 });
      merge(`V${row1 + 1}:Z${row1 + 1}`, "2nd Month of", { bold: true, align: "center", size: 7 });
      merge(`AA${row1 + 1}:AE${row1 + 1}`, "3rd Month of", { bold: true, align: "center", size: 7 });
      merge(`AF${row1 + 1}:AJ${row1 + 1}`, "Total", { bold: true, align: "center", size: 7 });
      merge(`AK${row1 + 1}:AR${row1 + 1}`, "Tax Withheld", { bold: true, align: "center", size: 7 });
      merge(`Q${row1 + 2}:U${row1 + 2}`, "the Quarter", { bold: true, align: "center", size: 7 });
      merge(`V${row1 + 2}:Z${row1 + 2}`, "the Quarter", { bold: true, align: "center", size: 7 });
      merge(`AA${row1 + 2}:AE${row1 + 2}`, "the Quarter", { bold: true, align: "center", size: 7 });
      merge(`AK${row1 + 2}:AR${row1 + 2}`, "For the Quarter", { bold: true, align: "center", size: 7 });
    };

    tableHeader(33);

    const dataStartRow = 36;
    const lines = report.lines.length > 0 ? report.lines : [];
    const rowsAvailable = 13;
    const rowCount = Math.max(lines.length, rowsAvailable);
    const totalRow = dataStartRow + rowCount;

    for (let i = 0; i < rowCount; i++) {
      const r = dataStartRow + i;
      const line = lines[i];
      merge(`A${r}:L${r}`, "");
      merge(`M${r}:P${r}`, line ? line.atcCode : "", { align: "center", border: true });
      merge(`Q${r}:U${r}`, line ? formatMoney(line.month1Amount) : "", { align: "right", border: true });
      merge(`V${r}:Z${r}`, line ? formatMoney(line.month2Amount) : "", { align: "right", border: true });
      merge(`AA${r}:AE${r}`, line ? formatMoney(line.month3Amount) : "", { align: "right", border: true });
      merge(`AF${r}:AJ${r}`, line ? formatMoney(line.totalAmount) : "", { align: "right", border: true });
      merge(`AK${r}:AR${r}`, line ? formatMoney(line.totalTaxWithheld) : "", { align: "right", border: true });
    }

    const writeTotalRow = (r, values) => {
      set(`A${r}`, "Total", { bold: true, align: "center" });
      merge(`M${r}:P${r}`, "", { border: true });
      merge(`Q${r}:U${r}`, values ? formatMoney(values.month1Amount) : "-", { bold: true, align: "right", border: true });
      merge(`V${r}:Z${r}`, values ? formatMoney(values.month2Amount) : "-", { bold: true, align: "right", border: true });
      merge(`AA${r}:AE${r}`, values ? formatMoney(values.month3Amount) : "-", { bold: true, align: "right", border: true });
      merge(`AF${r}:AJ${r}`, values ? formatMoney(values.totalAmount) : "-", { bold: true, align: "right", border: true });
      merge(`AK${r}:AR${r}`, values ? formatMoney(values.totalTaxWithheld) : "-", { bold: true, align: "right", border: true });
    };

    writeTotalRow(totalRow, report.totals);

    // Second table (Money Payments Subject to Withholding of Business Tax) - part of the
    // official layout but not populated; this system only tracks Expanded Withholding Tax.
    const table2Row1 = totalRow + 1;
    merge(`A${table2Row1}:L${table2Row1}`, "Money Payments Subject to Withholding Tax", { bold: true, size: 7, grey: true });
    merge(`A${table2Row1 + 1}:L${table2Row1 + 1}`, "of Business Tax (Government & Private)", { bold: true, size: 7, grey: true });

    const table2DataStart = table2Row1 + 2;
    for (let i = 0; i < rowsAvailable; i++) {
      const r = table2DataStart + i;
      merge(`A${r}:L${r}`, "");
      merge(`M${r}:P${r}`, "", { border: true });
      merge(`Q${r}:U${r}`, "", { border: true });
      merge(`V${r}:Z${r}`, "", { border: true });
      merge(`AA${r}:AE${r}`, "", { border: true });
      merge(`AF${r}:AJ${r}`, "", { border: true });
      merge(`AK${r}:AR${r}`, "", { border: true });
    }
    const table2TotalRow = table2DataStart + rowsAvailable;
    writeTotalRow(table2TotalRow, null);

    // Declaration
    const declRow = table2TotalRow + 2;
    merge(
      `A${declRow}:AR${declRow + 3}`,
      "We declare under the penalties of perjury that this certificate has been made in good faith, " +
        "verified by us, and to the best of our knowledge and belief, is true and correct, pursuant to " +
        "the provisions of the National Internal Revenue Code, as amended, and the regulations issued " +
        'under authority thereof. Further, we give our consent to the processing of our information as ' +
        'contemplated under the "Data Privacy Act of 2012 (R.A. No. 10173)" for legitimate and lawful purposes.',
      { size: 8, wrap: true, grey: true }
    );

    // Payor signature block
    const sigBlock = (startRow, role) => {
      merge(`A${startRow}:AR${startRow}`, "", { border: true });
      merge(`A${startRow + 1}:AR${startRow + 1}`, `Signature over Printed Name of ${role}`, {
        size: 7, align: "center", grey: true,
      });
      merge(`A${startRow + 2}:AR${startRow + 2}`, "(Indicate Title/Designation and TIN)", {
        size: 7, align: "center",
      });
      merge(`A${startRow + 3}:S${startRow + 3}`, "Tax Agent Accreditation No./", { size: 6 });
      merge(`T${startRow + 3}:AE${startRow + 3}`, "Date of Issue", { size: 6, align: "center" });
      merge(`AF${startRow + 3}:AI${startRow + 3}`, "Date of Expiry", { size: 6, align: "center" });
      merge(`A${startRow + 4}:S${startRow + 4}`, "Attorney's Roll No. (if applicable)", { size: 6 });
      merge(`T${startRow + 4}:AE${startRow + 4}`, "(MM/DD/YYYY)", { size: 6, align: "center" });
      merge(`AF${startRow + 4}:AI${startRow + 4}`, "(MM/DD/YYYY)", { size: 6, align: "center" });
      return startRow + 5;
    };

    const payorSigStart = declRow + 5;
    const afterPayorSig = sigBlock(
      payorSigStart,
      "Payor/Payor's Authorized Representative/Tax Agent"
    );

    const conformeRow = afterPayorSig + 1;
    merge(`A${conformeRow}:AR${conformeRow}`, "CONFORME:", { bold: true, grey: true });

    const payeeSigStart = conformeRow + 3;
    const afterPayeeSig = sigBlock(
      payeeSigStart,
      "Payee/Payee's Authorized Representative/Tax Agent"
    );

    merge(
      `A${afterPayeeSig + 1}:AR${afterPayeeSig + 1}`,
      "*NOTE: The BIR Data Privacy is in the BIR website (www.bir.gov.ph)",
      { size: 6, italic: true }
    );

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    const fileNameSafe = (report.payee.name || "payee").replace(/[^a-z0-9]+/gi, "_");
    link.href = url;
    link.download = `BIR_2307_${fileNameSafe}_Q${report.period.quarter}_${report.period.year}.xlsx`;
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
            Print / Export PDF
          </button>

          <button className="dark" onClick={downloadExcel}>
            Export Excel
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
