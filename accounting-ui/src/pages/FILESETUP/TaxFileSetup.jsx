import "./FileSetupPages.css";

export default function TaxFileSetup() {
  return (
    <div className="fs-page">
      <div className="fs-header">
        <div>
          <h1>Tax File Setup</h1>
          <p>Maintain VAT, withholding tax, and other tax codes.</p>
        </div>
        <button className="fs-btn primary">+ Add Tax Code</button>
      </div>

      <div className="fs-card">
        <table className="fs-table">
          <thead>
            <tr>
              <th>Tax Code</th>
              <th>Tax Type</th>
              <th>Rate</th>
              <th>Account</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>VAT12</td><td>Output VAT</td><td>12%</td><td>Output VAT Payable</td><td>ACTIVE</td></tr>
          </tbody>
        </table>
      </div>

      <div className="fs-card">
        <h2>Tax Details</h2>
        <div className="fs-grid">
          <div className="fs-field"><label>Tax Code</label><input placeholder="VAT12" /></div>
          <div className="fs-field"><label>Tax Type</label><select><option>Output VAT</option><option>Input VAT</option><option>Expanded Withholding Tax</option></select></div>
          <div className="fs-field"><label>Rate (%)</label><input type="number" placeholder="12" /></div>
          <div className="fs-field"><label>Linked Account</label><select><option>Select COA account</option></select></div>
        </div>
        <div className="fs-actions">
          <button className="fs-btn">Cancel</button>
          <button className="fs-btn primary">Save Tax Code</button>
        </div>
      </div>
    </div>
  );
}