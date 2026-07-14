import { useEffect, useMemo, useState } from "react";
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
