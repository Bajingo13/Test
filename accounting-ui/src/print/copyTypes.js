// Shared across every module - "support configurable copy labels" from the
// spec, applied universally rather than restricted per module (any label
// can reasonably apply to any transaction document; restricting the list
// per module would add config surface without much real benefit).
export const COPY_TYPES = [
  "Original",
  "Duplicate",
  "Triplicate",
  "Accounting Copy",
  "Customer Copy",
  "Supplier Copy",
  "File Copy",
];

export const DEFAULT_COPY_TYPE = "Original";
export const MAX_COPIES = 5;
