import "./FileSetupPages.css";

export default function Industry() {
  return (
    <div className="fs-page">
      <div className="fs-header">
        <div>
          <h1>Industry</h1>
          <p>Maintain industry classifications for customers and suppliers.</p>
        </div>
        <button className="fs-btn primary">+ Add Industry</button>
      </div>

      <div className="fs-card">
        <div className="fs-toolbar">
          <input placeholder="Search industry..." />
          <select>
            <option>All Status</option>
            <option>Active</option>
            <option>Inactive</option>
          </select>
        </div>

        <table className="fs-table">
          <thead>
            <tr>
              <th>Industry Code</th>
              <th>Industry Name</th>
              <th>Description</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan="5" className="fs-empty">No industry records yet.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="fs-card">
        <h2>Industry Details</h2>
        <div className="fs-grid">
          <div className="fs-field"><label>Industry Code</label><input placeholder="IND-001" /></div>
          <div className="fs-field"><label>Industry Name</label><input placeholder="Retail / Trading" /></div>
          <div className="fs-field"><label>Status</label><select><option>ACTIVE</option><option>INACTIVE</option></select></div>
          <div className="fs-field"><label>Description</label><input placeholder="Industry description" /></div>
        </div>
        <div className="fs-actions">
          <button className="fs-btn">Cancel</button>
          <button className="fs-btn primary">Save Industry</button>
        </div>
      </div>
    </div>
  );
}