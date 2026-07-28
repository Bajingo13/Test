// Shared "next code" logic for the general_libraries table - used by both
// the full General Libraries editor (GenLib.jsx) and the transaction-form
// quick-add modal (PartyQuickAddModal.jsx) so there is exactly one place
// that decides what a new record's code should be. Single global GL-####
// sequence across all party types (customers, suppliers, employees, etc.),
// matching the existing behavior - not a per-type counter.
export function generateNextCode(list) {
  const numbers = (list || [])
    .map((item) => Number(String(item.code).replace(/[^\d]/g, "")))
    .filter((num) => !Number.isNaN(num));

  const next = numbers.length ? Math.max(...numbers) + 1 : 1;
  return `GL-${String(next).padStart(4, "0")}`;
}
