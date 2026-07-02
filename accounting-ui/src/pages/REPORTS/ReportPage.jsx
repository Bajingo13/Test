import { useState } from "react";
import "./ReportPage.css";

export default function ReportPage({ title }) {
  const [filters, setFilters] = useState({
    dateFrom: "",
    dateTo: "",
    company: "",
    branch: "",
    status: "All",
  });

  const handleChange = (e) => {
    setFilters({
      ...filters,
      [e.target.name]: e.target.value,
    });
  };

  const handleGenerate = () => {
    alert(`${title} generated successfully!`);
    console.log("Report Filters:", filters);
  };

  const handleClear = () => {
    setFilters({
      dateFrom: "",
      dateTo: "",
      company: "",
      branch: "",
      status: "All",
    });
  };

  return (
    <div className="report-page">
      <div className="report-header">
        <div>
          <h1>{title}</h1>
          <p>Generate and preview accounting reports.</p>
        </div>
      </div>

      <div className="report-card">
        <h2>Report Filters</h2>

        <div className="report-form-grid">
          <div className="form-group">
            <label>Date From</label>
            <input
              type="date"
              name="dateFrom"
              value={filters.dateFrom}
              onChange={handleChange}
            />
          </div>

          <div className="form-group">
            <label>Date To</label>
            <input
              type="date"
              name="dateTo"
              value={filters.dateTo}
              onChange={handleChange}
            />
          </div>

          <div className="form-group">
            <label>Company</label>
            <select name="company" value={filters.company} onChange={handleChange}>
              <option value="">Select Company</option>
              <option value="AstreaBlue">AstreaBlue</option>
              <option value="Demo Company">Demo Company</option>
            </select>
          </div>

          <div className="form-group">
            <label>Branch / Department</label>
            <select name="branch" value={filters.branch} onChange={handleChange}>
              <option value="">All Branches</option>
              <option value="Main">Main</option>
              <option value="Branch 1">Branch 1</option>
              <option value="Branch 2">Branch 2</option>
            </select>
          </div>

          <div className="form-group">
            <label>Status</label>
            <select name="status" value={filters.status} onChange={handleChange}>
              <option value="All">All</option>
              <option value="Posted">Posted Only</option>
              <option value="Unposted">Unposted Only</option>
            </select>
          </div>
        </div>

        <div className="report-actions">
          <button className="btn-generate" onClick={handleGenerate}>
            Generate Report
          </button>

          <button className="btn-clear" onClick={handleClear}>
            Clear Filters
          </button>

          <button className="btn-export">
            Export PDF
          </button>

          <button className="btn-export">
            Export Excel
          </button>
        </div>
      </div>

      <div className="report-preview">
        <div className="preview-header">
          <h2>{title} Preview</h2>
          <span>No report generated yet</span>
        </div>

        <div className="preview-empty">
          Select filters above, then click <b>Generate Report</b>.
        </div>
      </div>
    </div>
  );
}