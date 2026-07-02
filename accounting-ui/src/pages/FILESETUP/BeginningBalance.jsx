import "./FileSetupPages.css";

export default function BeginningBalance() {
  return (
    <div className="fs-page">
      <div className="fs-header">
        <div>
          <h1>Beginning Balances</h1>
          <p>Encode opening balances before starting live transactions.</p>
        </div>
        <button className="fs-btn primary">+ Add Balance</button>
      </div>

      <div className="fs-card">
        <div className="fs-toolbar">
          <input placeholder="Search account..." />
          <select>
            <option>All Accounts</option>
            <option>Asset</option>
            <option>Liability</option>
            <option>Equity</option>
          </select>
        </div>

        <table className="fs-table">
          <thead>
            <tr>
              <th>Account Code</th>
              <th>Account Title</th>
              <th>Debit</th>
              <th>Credit</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            <tr><td colSpan="5" className="fs-empty">No beginning balances yet.</td></tr>
          </tbody>
        </table>
      </div>

      <div className="fs-card">
        <h2>Balance Entry</h2>
        <div className="fs-grid">
          <div className="fs-field"><label>Account</label><select><option>Select COA account</option></select></div>
          <div className="fs-field"><label>Beginning Date</label><input type="date" /></div>
          <div className="fs-field"><label>Debit</label><input type="number" placeholder="0.00" /></div>
          <div className="fs-field"><label>Credit</label><input type="number" placeholder="0.00" /></div>
        </div>
        <div className="fs-actions">
          <button className="fs-btn">Cancel</button>
          <button className="fs-btn primary">Save Balance</button>
        </div>
      </div>
    </div>
  );
}