import "./FileSetupPages.css";

export default function BookTemplate() {
  return (
    <div className="fs-page">
      <div className="fs-header">
        <div>
          <h1>Book Template</h1>
          <p>Maintain book templates used for accounting entries.</p>
        </div>
        <button className="fs-btn primary">+ Add Template</button>
      </div>

      <div className="fs-card">
        <table className="fs-table">
          <thead>
            <tr>
              <th>Book Code</th>
              <th>Book Name</th>
              <th>Transaction Type</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            <tr><td colSpan="5" className="fs-empty">No book templates yet.</td></tr>
          </tbody>
        </table>
      </div>

      <div className="fs-card">
        <h2>Book Template Details</h2>
        <div className="fs-grid">
          <div className="fs-field"><label>Book Code</label><input placeholder="GEN" /></div>
          <div className="fs-field"><label>Book Name</label><input placeholder="General Journal" /></div>
          <div className="fs-field"><label>Transaction Type</label><select><option>Journal Voucher</option><option>Check Voucher</option><option>Official Receipt</option></select></div>
          <div className="fs-field"><label>Status</label><select><option>ACTIVE</option><option>INACTIVE</option></select></div>
        </div>
        <div className="fs-actions">
          <button className="fs-btn">Cancel</button>
          <button className="fs-btn primary">Save Template</button>
        </div>
      </div>
    </div>
  );
}