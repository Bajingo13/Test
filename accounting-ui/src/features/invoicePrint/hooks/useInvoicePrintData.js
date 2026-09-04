import { useEffect, useRef, useState } from "react";
import { fetchInvoicePrintViewModel } from "../services/invoicePrintApi";

// Loads the Standard Invoice print view model for one identifier. Refetches
// only when the identifier, render token, or mode change - never on
// unrelated re-renders.
export default function useInvoicePrintData(identifier, { renderToken, mode } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!identifier) {
      setData(null);
      setLoading(false);
      setError("No invoice identifier was provided.");
      return;
    }

    const controller = new AbortController();
    const requestId = ++requestIdRef.current;

    setLoading(true);
    setError(null);

    fetchInvoicePrintViewModel(identifier, { signal: controller.signal, renderToken, mode })
      .then((viewModel) => {
        if (requestIdRef.current !== requestId) return; // stale response
        setData(viewModel);
        setLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (requestIdRef.current !== requestId) return;
        setData(null);
        setError(err?.message || "Failed to load invoice.");
        setLoading(false);
      });

    return () => controller.abort();
  }, [identifier, renderToken, mode]);

  return { data, loading, error };
}
