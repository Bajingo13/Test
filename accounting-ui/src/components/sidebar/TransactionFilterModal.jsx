import "./TransactionFilterModal.css";

const MONTHS = [
  "JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE",
  "JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER",
];

const BOOKS = ["CARGOHAUS", "MAIN"];

export default function TransactionFilterModal({
  open,
  title = "Transaction Entry",
  filter,
  setFilter,
  onLoad,
  onClose,
}) {
  if (!open) return null;

  const years = [];
  const currentYear = new Date().getFullYear();
  for (let y = currentYear + 1; y >= currentYear - 10; y--) years.push(String(y));

  function handleChange(field, value) {
    setFilter((prev) => ({ ...prev, [field]: value }));
  }

  function handleOverlayClick(e) {
    // closes only when clicking the overlay, not the modal contents
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div className="tfm-overlay" onClick={handleOverlayClick}>
      <div className="tfm-modal">
        <div className="tfm-header">
          <h2>{title}</h2>
        </div>

        <div className="tfm-body">
          <div className="tfm-field">
            <label>Book</label>
            <select
              value={filter.book ?? ""}
              onChange={(e) => handleChange("book", e.target.value)}
            >
              <option value="" disabled>Select a book…</option>
              {BOOKS.map((book) => (
                <option key={book} value={book}>{book}</option>
              ))}
            </select>
          </div>

          <div className="tfm-field">
            <label>Month</label>
            <select
              value={filter.month ?? ""}
              onChange={(e) => handleChange("month", e.target.value)}
            >
              <option value="" disabled>Select a month…</option>
              {MONTHS.map((month) => (
                <option key={month} value={month}>{month}</option>
              ))}
            </select>
          </div>

          <div className="tfm-field">
            <label>Year</label>
            <select
              value={filter.year ?? ""}
              onChange={(e) => handleChange("year", e.target.value)}
            >
              <option value="" disabled>Select a year…</option>
              {years.map((year) => (
                <option key={year} value={year}>{year}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="tfm-actions">
          <button type="button" className="tfm-btn tfm-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="tfm-btn tfm-btn-primary" onClick={onLoad}>
            Open
          </button>
        </div>
      </div>
    </div>
  );
}