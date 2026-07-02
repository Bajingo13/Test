import "./FileSetupPages.css";

export default function BankCodes() {
  return (
    <div className="fs-page">
      <div className="fs-header">
        <div>
          <h1>Bank Codes</h1>
          <p>Maintain company bank accounts and bank code references.</p>
        </div>
        <button className="fs-btn primary">+ Add Bank</button>
      </div>

      <div className="fs-card">
        <table className="fs-table">
          <thead>
            <tr>
              <th>Bank Code</th>
              <th>Bank Name</th>
              <th>Account No.</th>
              <th>Account Name</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr><td colSpan="5" className="fs-empty">No bank codes yet.</td></tr>
          </tbody>
        </table>
      </div>

      <div className="fs-card">
        <h2>Bank Details</h2>
        <div className="fs-grid">
          <div className="fs-field"><label>Bank Code</label><input placeholder="BPI" /></div>
          <div className="fs-field"><label>Bank Name</label><input placeholder="Bank name" /></div>
          <div className="fs-field"><label>Account No.</label><input placeholder="0000-0000-0000" /></div>
          <div className="fs-field"><label>Account Name</label><input placeholder="Company name" /></div>
        </div>
        <div className="fs-actions">
          <button className="fs-btn">Cancel</button>
          <button className="fs-btn primary">Save Bank</button>
        </div>
      </div>
    </div>
  );
}