import { useEffect, useRef } from "react";

// Exposes the same window.__REPLICA_READY / window.__REPLICA_ERROR contract
// the E-Invoicing Replica used, so the (future) Puppeteer PDF route can wait
// on it identically. Set true only after: data loaded, React has painted,
// fonts are ready, and every <img> in the page has settled (loaded or
// failed - a failed logo must never hang the PDF).
export default function usePrintReadiness({ identifier, loading, error, containerRef }) {
  const resetForIdentifierRef = useRef(identifier);

  // Reset readiness whenever the invoice identifier changes.
  useEffect(() => {
    if (resetForIdentifierRef.current !== identifier) {
      resetForIdentifierRef.current = identifier;
    }
    window.__REPLICA_READY = false;
    window.__REPLICA_ERROR = null;
  }, [identifier]);

  useEffect(() => {
    if (loading) return undefined;

    if (error) {
      // Safe message only - never a stack trace, SQL, or token.
      window.__REPLICA_ERROR = { message: "Unable to load this invoice for printing." };
      window.__REPLICA_READY = false;
      return undefined;
    }

    let cancelled = false;

    async function waitForReady() {
      // 1. Let React finish committing/painting the just-loaded data.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (cancelled) return;

      // 2. Fonts.
      try {
        if (document.fonts?.ready) await document.fonts.ready;
      } catch {
        // font loading is best-effort; never block readiness on it failing
      }
      if (cancelled) return;

      // 3. Images - resolved (loaded or errored) rather than pending.
      const images = containerRef.current ? Array.from(containerRef.current.querySelectorAll("img")) : [];
      await Promise.all(
        images.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise((resolve) => {
                img.addEventListener("load", resolve, { once: true });
                img.addEventListener("error", resolve, { once: true });
              })
        )
      );
      if (cancelled) return;

      window.__REPLICA_ERROR = null;
      window.__REPLICA_READY = true;
    }

    waitForReady();

    return () => {
      cancelled = true;
    };
  }, [loading, error, containerRef]);

  // Reset on unmount so a stale READY/ERROR never leaks into whatever loads next.
  useEffect(() => {
    return () => {
      window.__REPLICA_READY = false;
      window.__REPLICA_ERROR = null;
    };
  }, []);
}
