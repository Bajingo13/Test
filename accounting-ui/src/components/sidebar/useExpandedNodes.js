import { useCallback, useEffect, useState } from "react";

// Persists which nav-tree node IDs are expanded, namespaced so other menus
// (File Setup, Transactions) could adopt this later without key collisions.
// Plain useState would already survive in-session navigation (Sidebar never
// unmounts between route changes), localStorage additionally survives a
// refresh/reopened tab.
export default function useExpandedNodes(namespace) {
  const storageKey = `navtree.expanded.${namespace}`;

  const [expanded, setExpanded] = useState(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...expanded]));
    } catch {
      // Storage unavailable (private mode, quota) - expand state just
      // won't survive a refresh, nothing else depends on it.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const toggle = useCallback((id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const expandIds = useCallback((ids) => {
    if (!ids.length) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of ids) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  return { expanded, toggle, expandIds };
}
