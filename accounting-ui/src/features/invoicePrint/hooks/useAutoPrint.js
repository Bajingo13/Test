import { useEffect, useRef } from "react";

// ?autoprint=1 triggers window.print() exactly once, and only after the
// page has genuinely reported ready (window.__REPLICA_READY). Guarded with
// a ref (not state) so React Strict Mode's double-invoke, an unrelated
// re-render, or a data refetch can never fire it twice.
export default function useAutoPrint({ identifier, ready, autoPrintRequested }) {
  const hasAutoPrintedRef = useRef(false);

  // A different invoice identifier is a genuinely new document - allow one
  // more auto-print for it.
  useEffect(() => {
    hasAutoPrintedRef.current = false;
  }, [identifier]);

  useEffect(() => {
    if (!autoPrintRequested || !ready || hasAutoPrintedRef.current) return;
    hasAutoPrintedRef.current = true;
    window.print();
  }, [autoPrintRequested, ready]);
}
