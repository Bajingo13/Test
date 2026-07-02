import "./FileSetupPages.css";

export default function AdditionalFileSetup() {
  return (
    <div className="fs-page">
      <div className="fs-header">
        <div>
          <h1>Additional File Setup</h1>
          <p>Maintain additional system reference files and custom setup values.</p>
        </div>
        <button className="fs-btn primary">+ Add Setup</button>
      </div>

      <div className="fs-card">
        <table className="fs-table">
          <thead>
            <tr>
              <th>Setup Code</th>
              <th>Setup Name</th>
              <th>Value</th>
              <th>Description</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr><td colSpan="5" className="fs-empty">No additional setup records yet.</td></tr>
          </tbody>
        </table>
      </div>

      <div className="fs-card">
        <h2>Setup Details</h2>
        <div className="fs-grid">
          <div className="fs-field"><label>Setup Code</label><input placeholder="SET-001" /></div>
          <div className="fs-field"><label>Setup Name</label><input placeholder="Custom setup name" /></div>
          <div className="fs-field"><label>Value</label><input placeholder="Value" /></div>
          <div className="fs-field"><label>Status</label><select><option>ACTIVE</option><option>INACTIVE</option></select></div>
        </div>
        <div className="fs-actions">
          <button className="fs-btn">Cancel</button>
          <button className="fs-btn primary">Save Setup</button>
        </div>
      </div>
    </div>
  );
}