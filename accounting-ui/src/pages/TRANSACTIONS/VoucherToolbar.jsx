import React from "react";
import "./TransactionFormLayout.css";

// Phase 7B: single in-voucher action surface, replacing the old top-actions
// row + bottom action bar (which duplicated the same commands - see
// TransactionFormLayout's Phase 7B report). Two contextual variants:
// "view" (Edit/Delete/Print/Previous/Next/Back to List/Make Recurring) and
// "edit" (Save Draft/Post Transaction/Back to List) - never both at once,
// matching the "ONE action location" goal in the Phase 7B spec.
export default function VoucherToolbar({
  formMode, // "view" | "edit"
  isNew, // true only while creating a brand-new, never-saved transaction
  saving,
  deleting,
  showEdit,
  showDelete,
  showPrint,
  showRecurring,
  showPrevious,
  showNext,
  hasPrevious,
  hasNext,
  showPost,
  code,
  onEdit,
  onDelete,
  onPrint,
  onRecurring,
  onPrevious,
  onNext,
  onBackToList,
  onSaveDraft,
  onPost,
}) {
  return (
    <div className="voucher-toolbar no-print">
      <div className="voucher-toolbar-group">
        <button type="button" className="transaction-secondary-button" onClick={onBackToList}>
          ← Back to {code} List
        </button>

        {formMode === "view" && !isNew && showPrevious && (
          <button
            type="button"
            className="transaction-secondary-button"
            onClick={onPrevious}
            disabled={!hasPrevious}
          >
            ← Previous
          </button>
        )}

        {formMode === "view" && !isNew && showNext && (
          <button
            type="button"
            className="transaction-secondary-button"
            onClick={onNext}
            disabled={!hasNext}
          >
            Next →
          </button>
        )}
      </div>

      <div className="voucher-toolbar-group">
        {formMode === "view" && showEdit && (
          <button type="button" className="transaction-secondary-button" onClick={onEdit}>
            ✎ Edit
          </button>
        )}

        {formMode === "view" && showDelete && (
          <button
            type="button"
            className="transaction-danger-button"
            onClick={onDelete}
            disabled={deleting}
          >
            {deleting ? "Deleting..." : "🗑 Delete"}
          </button>
        )}

        {formMode === "view" && showPrint && (
          <button type="button" className="transaction-secondary-button" onClick={onPrint}>
            🖨 Print
          </button>
        )}

        {formMode === "view" && showRecurring && (
          <button type="button" className="transaction-secondary-button" onClick={onRecurring}>
            🔁 Make Recurring
          </button>
        )}

        {formMode === "edit" && (
          <button
            type="button"
            className="transaction-secondary-button"
            onClick={onSaveDraft}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save Draft"}
          </button>
        )}

        {formMode === "edit" && showPost && (
          <button
            type="button"
            className="transaction-primary-button"
            onClick={onPost}
            disabled={saving}
          >
            {saving ? "Saving..." : "Post Transaction"}
          </button>
        )}
      </div>
    </div>
  );
}
