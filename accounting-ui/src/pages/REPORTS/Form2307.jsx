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

    const set = (addr, value, opts = {}) => {
      const cell = ws.getCell(addr);
      cell.value = value;
      cell.font = { name: "Arial", size: opts.size || 8, bold: !!opts.bold };
      cell.alignment = {
        horizontal: opts.align || "left",
        vertical: "middle",
        wrapText: !!opts.wrap,
      };
      if (opts.border) cell.border = box;
      return cell;
    };

    const merge = (range, value, opts = {}) => {
      ws.mergeCells(range);
      const topLeft = range.split(":")[0];
      return set(topLeft, value, opts);
    };

    // Header
    set("P2", "Republic of the Philippines");
    merge("P3:AD3", "Department of Finance");
    merge("P4:AD4", "Bureau of Internal Revenue", { bold: true });
    set("AF2", "BIR Form No. 2307", { bold: true, align: "right" });
    set("AF3", "Certificate of Creditable", { align: "right" });
    set("AF4", "Tax Withheld at Source", { align: "right" });

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
    set("A13", "Part I", { bold: true });
    merge("D13:AR13", "Payee   Information", { bold: true });

    set("A14", "2");
    set("B14", "Taxpayer");
    set("B15", "Identification Number");
    set("D14", report.payee.tin || "-", { border: true });

    set("A17", "3");
    set("B17", "Payee's Name");
    set("D17", report.payee.name || "-", { border: true });
    merge(
      "I18:AR18",
      "(Last Name, First Name, Middle Name for Individuals) (Registered Name for Non-Individuals)",
      { size: 6 }
    );

    set("A19", "4");
    set("B19", "Registered Address");
    set("D19", report.payee.address || "-", { border: true });
    set("AJ19", "4A");
    set("AK19", "Zip Code");

    set("A21", "5");
    set("B21", "Foreign Address");
    set("AJ21", "5A");
    set("AK21", "Zip Code");

    // Payor Information
    merge("D23:AR23", "Payor   Information", { bold: true });

    set("A24", "6");
    set("B24", "Taxpayer");
    set("B25", "Identification Number");
    set("D24", report.payor.payorTin || "-", { border: true });

    set("A27", "7");
    set("B27", "Payor's Name");
    set("D27", report.payor.payorName || "-", { border: true });
    merge(
      "I28:AR28",
      "(Last Name, First Name, Middle Name for Individuals) (Registered Name for Non-Individuals)",
      { size: 6 }
    );

    set("A29", "8");
    set("B29", "Registered Address");
    set("D29", report.payor.payorAddress || "-", { border: true });
    set("AJ29", "8A");
    set("AK29", "Zip Code");
    set("AL29", report.payor.payorZip || "-", { border: true });

    // PART II - EWT table
    set("A32", "PART II", { bold: true });
    merge(
      "D32:AR32",
      "Details of Monthly Income Payments and Tax Withheld for the Quarter",
      { bold: true }
    );

    merge("A33:L33", "Income Payments Subject to", { bold: true });
    merge("A34:L34", "Expanded Withholding Tax", { bold: true });
    merge("M33:P34", "ATC", { bold: true, align: "center" });
    merge("Q33:AJ33", "AMOUNT OF INCOME PAYMENTS", { bold: true, align: "center" });
    merge("Q34:U34", `1st Month of`, { bold: true, align: "center", size: 7 });
    merge("V34:Z34", `2nd Month of`, { bold: true, align: "center", size: 7 });
    merge("AA34:AE34", `3rd Month of`, { bold: true, align: "center", size: 7 });
    merge("AF34:AJ34", "Total", { bold: true, align: "center", size: 7 });
    merge("AK34:AR34", "Tax Withheld", { bold: true, align: "center", size: 7 });
    merge("Q35:U35", "the Quarter", { bold: true, align: "center", size: 7 });
    merge("V35:Z35", "the Quarter", { bold: true, align: "center", size: 7 });
    merge("AA35:AE35", "the Quarter", { bold: true, align: "center", size: 7 });
    merge("AK35:AR35", "For the Quarter", { bold: true, align: "center", size: 7 });

    const dataStartRow = 36;
    const lines = report.lines.length > 0 ? report.lines : [];
    const rowsAvailable = 13;
    const totalRow = dataStartRow + Math.max(lines.length, rowsAvailable);

    for (let i = 0; i < Math.max(lines.length, rowsAvailable); i++) {
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

    set(`A${totalRow}`, "Total", { bold: true, align: "center" });
    merge(`M${totalRow}:P${totalRow}`, "", { border: true });
    merge(`Q${totalRow}:U${totalRow}`, formatMoney(report.totals.month1Amount), {
      bold: true, align: "right", border: true,
    });
    merge(`V${totalRow}:Z${totalRow}`, formatMoney(report.totals.month2Amount), {
      bold: true, align: "right", border: true,
    });
    merge(`AA${totalRow}:AE${totalRow}`, formatMoney(report.totals.month3Amount), {
      bold: true, align: "right", border: true,
    });
    merge(`AF${totalRow}:AJ${totalRow}`, formatMoney(report.totals.totalAmount), {
      bold: true, align: "right", border: true,
    });
    merge(`AK${totalRow}:AR${totalRow}`, formatMoney(report.totals.totalTaxWithheld), {
      bold: true, align: "right", border: true,
    });

    // Declaration
    const declRow = totalRow + 3;
    merge(
      `A${declRow}:AR${declRow + 3}`,
      "We declare under the penalties of perjury that this certificate has been made in good faith, " +
        "verified by us, and to the best of our knowledge and belief, is true and correct, pursuant to " +
        "the provisions of the National Internal Revenue Code, as amended, and the regulations issued " +
        "under authority thereof.",
      { size: 8, wrap: true }
    );

    // Signature blocks
    const sigRow = declRow + 6;
    merge(`A${sigRow}:S${sigRow}`, "", { border: true });
    merge(`AF${sigRow}:AR${sigRow}`, "", { border: true });
    merge(
      `A${sigRow + 1}:S${sigRow + 1}`,
      "Signature over Printed Name of Payor/Payor's Authorized Representative/Tax Agent",
      { size: 7, align: "center" }
    );
    merge(`A${sigRow + 2}:S${sigRow + 2}`, "(Indicate Title/Designation and TIN)", {
      size: 7, align: "center",
    });
    merge(
      `AF${sigRow + 1}:AR${sigRow + 1}`,
      "Signature over Printed Name of Payee/Payee's Authorized Representative/Tax Agent",
      { size: 7, align: "center" }
    );
    merge(`AF${sigRow + 2}:AR${sigRow + 2}`, "(Indicate Title/Designation and TIN)", {
      size: 7, align: "center",
    });

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
