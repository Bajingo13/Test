import "./FileSetupPages.css";

export default function TransactionSetup() {
  return (
    <div className="fs-page">
      <div className="fs-header">
        <div>
          <h1>Transaction Setup</h1>
          <p>Configure transaction numbering, prefixes, and default settings.</p>
        </div>
        <button className="fs-btn primary">Save Setup</button>
      </div>

      <div className="fs-card">
        <h2>Numbering Setup</h2>
        <div className="fs-grid">
          <div className="fs-field"><label>Transaction Type</label><select><option>APV</option><option>CV</option><option>JV</option><option>OR</option></select></div>
          <div className="fs-field"><label>Prefix</label><input placeholder="APV-" /></div>
          <div className="fs-field"><label>Starting Number</label><input type="number" placeholder="1" /></div>
          <div className="fs-field"><label>Number Length</label><input type="number" placeholder="6" /></div>
        </div>
      </div>

      <div className="fs-card">
        <h2>Default Settings</h2>
        <div className="fs-grid">
          <div className="fs-field"><label>Default Status</label><select><option>Draft</option><option>Posted</option></select></div>
          <div className="fs-field"><label>Allow Manual Number</label><select><option>Yes</option><option>No</option></select></div>
          <div className="fs-field"><label>Require Balanced Entry</label><select><option>Yes</option><option>No</option></select></div>
        </div>
      </div>
    </div>
  );
}