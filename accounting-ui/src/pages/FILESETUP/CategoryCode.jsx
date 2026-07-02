import "./FileSetupPages.css";

export default function CategoryCode() {
  return (
    <div className="fs-page">
      <div className="fs-header">
        <div>
          <h1>Category Code</h1>
          <p>Maintain category codes for grouping records.</p>
        </div>
        <button className="fs-btn primary">+ Add Category</button>
      </div>

      <div className="fs-card">
        <div className="fs-toolbar">
          <input placeholder="Search category..." />
          <select>
            <option>All Types</option>
            <option>Customer</option>
            <option>Supplier</option>
            <option>Account</option>
          </select>
        </div>

        <table className="fs-table">
          <thead>
            <tr>
              <th>Category Code</th>
              <th>Category Name</th>
              <th>Type</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            <tr><td colSpan="5" className="fs-empty">No category records yet.</td></tr>
          </tbody>
        </table>
      </div>

      <div className="fs-card">
        <h2>Category Details</h2>
        <div className="fs-grid">
          <div className="fs-field"><label>Category Code</label><input placeholder="CAT-001" /></div>
          <div className="fs-field"><label>Category Name</label><input placeholder="Regular Customer" /></div>
          <div className="fs-field"><label>Type</label><select><option>CUSTOMER</option><option>SUPPLIER</option><option>ACCOUNT</option></select></div>
          <div className="fs-field"><label>Status</label><select><option>ACTIVE</option><option>INACTIVE</option></select></div>
        </div>
        <div className="fs-actions">
          <button className="fs-btn">Cancel</button>
          <button className="fs-btn primary">Save Category</button>
        </div>
      </div>
    </div>
  );
}