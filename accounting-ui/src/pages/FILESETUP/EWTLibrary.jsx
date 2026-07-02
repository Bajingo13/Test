import "./FileSetupPages.css";

export default function EWTLibrary() {
  return (
    <div className="fs-page">
      <div className="fs-header">
        <div>
          <h1>EWT / ATC Library</h1>
          <p>
            Maintain Expanded Withholding Tax (EWT) rates and ATC codes for BIR compliance.
          </p>
        </div>

        <button className="fs-btn primary">
          + Add EWT Code
        </button>
      </div>

      <div className="fs-card">
        <div className="fs-toolbar">
          <input placeholder="Search ATC or EWT code..." />

          <select>
            <option>All Tax Types</option>
            <option>Expanded Withholding Tax</option>
            <option>Final Tax</option>
          </select>
        </div>

        <table className="fs-table">
          <thead>
            <tr>
              <th>ATC Code</th>
              <th>EWT Name</th>
              <th>Tax Rate (%)</th>
              <th>BIR Form</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>

          <tbody>
            <tr>
              <td>WI158</td>
              <td>Professional Fees</td>
              <td>10%</td>
              <td>1601-EQ</td>
              <td>ACTIVE</td>
              <td>
                <button className="fs-btn">Edit</button>
              </td>
            </tr>

            <tr>
              <td>WC158</td>
              <td>Contractors</td>
              <td>2%</td>
              <td>1601-EQ</td>
              <td>ACTIVE</td>
              <td>
                <button className="fs-btn">Edit</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="fs-card">
        <h2>EWT / ATC Details</h2>

        <div className="fs-grid">
          <div className="fs-field">
            <label>ATC Code</label>
            <input placeholder="WI158" />
          </div>

          <div className="fs-field">
            <label>EWT Name</label>
            <input placeholder="Professional Fees" />
          </div>

          <div className="fs-field">
            <label>Tax Rate (%)</label>
            <input type="number" placeholder="10" />
          </div>

          <div className="fs-field">
            <label>BIR Form</label>
            <select>
              <option>1601-EQ</option>
              <option>0619-E</option>
              <option>2307</option>
            </select>
          </div>

          <div className="fs-field">
            <label>Tax Type</label>
            <select>
              <option>Expanded Withholding Tax</option>
              <option>Final Tax</option>
            </select>
          </div>

          <div className="fs-field">
            <label>Status</label>
            <select>
              <option>ACTIVE</option>
              <option>INACTIVE</option>
            </select>
          </div>
        </div>

        <div className="fs-actions">
          <button className="fs-btn">
            Cancel
          </button>

          <button className="fs-btn primary">
            Save EWT Code
          </button>
        </div>
      </div>
    </div>
  );
}