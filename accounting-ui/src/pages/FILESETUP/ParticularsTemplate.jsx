import "./FileSetupPages.css";

export default function ParticularsTemplate() {
  return (
    <div className="fs-page">
      <div className="fs-header">
        <div>
          <h1>Particulars Template</h1>
          <p>Maintain reusable particulars or narration templates.</p>
        </div>
        <button className="fs-btn primary">+ Add Particulars</button>
      </div>

      <div className="fs-card">
        <table className="fs-table">
          <thead>
            <tr>
              <th>Template Code</th>
              <th>Title</th>
              <th>Particulars</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            <tr><td colSpan="5" className="fs-empty">No particulars templates yet.</td></tr>
          </tbody>
        </table>
      </div>

      <div className="fs-card">
        <h2>Particulars Details</h2>
        <div className="fs-grid">
          <div className="fs-field"><label>Template Code</label><input placeholder="PAR-001" /></div>
          <div className="fs-field"><label>Title</label><input placeholder="Payment for invoice" /></div>
          <div className="fs-field"><label>Status</label><select><option>ACTIVE</option><option>INACTIVE</option></select></div>
          <div className="fs-field"><label>Particulars</label><textarea rows="3" placeholder="Enter template text" /></div>
        </div>
        <div className="fs-actions">
          <button className="fs-btn">Cancel</button>
          <button className="fs-btn primary">Save Particulars</button>
        </div>
      </div>
    </div>
  );
}