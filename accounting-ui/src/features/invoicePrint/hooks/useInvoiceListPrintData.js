import { useEffect, useRef, useState } from "react";
import { fetchInvoiceListPrintViewModel } from "../services/invoicePrintApi";

// Loads one of the 3 "Print List by ..." summaries. Refetches only when
// the grouping/from/to/renderToken combination changes.
export default function useInvoiceListPrintData({ renderToken, grouping, from, to }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;

    setLoading(true);
    setError(null);

    fetchInvoiceListPrintViewModel({ signal: controller.signal, renderToken, grouping, from, to })
      .then((viewModel) => {
        if (requestIdRef.current !== requestId) return;
        setData(viewModel);
        setLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (requestIdRef.current !== requestId) return;
        setData(null);
        setError(err?.message || "Failed to load invoice list.");
        setLoading(false);
      });

    return () => controller.abort();
  }, [renderToken, grouping, from, to]);

  return { data, loading, error };
}
