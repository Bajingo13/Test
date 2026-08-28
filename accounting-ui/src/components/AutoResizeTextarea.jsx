import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import "./AutoResizeTextarea.css";

/**
 * A drop-in replacement for a single-line <input type="text"> on fields that
 * hold description-style free text (names, particulars, remarks, addresses,
 * notes, "Nature of Income Payment", ...).
 *
 * It starts at the normal compact input height and grows vertically as the
 * text wraps - resetting height to `auto` first, then to `scrollHeight` - so
 * the full value is always visible without an internal scrollbar. A generous
 * `maxRows` cap keeps a pathologically long value from taking over the page;
 * only past that cap does it fall back to scrolling.
 *
 * The public contract is identical to a controlled textarea/input: pass the
 * same `value`, `onChange`, `name`, `placeholder`, `disabled`, etc. It does
 * not add a `maxLength` unless the caller passes one - length limits stay
 * exactly where they were (client + server validation on Save).
 */
export default function AutoResizeTextarea({
  value,
  minRows = 1,
  maxRows = 10,
  className = "",
  onChange,
  ...props
}) {
  const ref = useRef(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    // Reset first so shrinking works, then measure the wrapped content.
    el.style.height = "auto";

    const cs = window.getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || 20;
    const verticalPadding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const verticalBorder = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const isBorderBox = cs.boxSizing === "border-box";

    // scrollHeight is (content + padding). Translate it into whichever box the
    // `height` property actually sets: border-box needs the borders added on,
    // content-box needs the padding taken back off. Getting this wrong clips
    // the last line by exactly the border width.
    const toStyleHeight = (scrollH) =>
      isBorderBox ? scrollH + verticalBorder : scrollH - verticalPadding;

    const contentRows = lineHeight * maxRows + verticalPadding;
    const maxStyleHeight = toStyleHeight(contentRows);

    const fullStyleHeight = toStyleHeight(el.scrollHeight);
    el.style.height = `${Math.min(fullStyleHeight, maxStyleHeight)}px`;
    el.style.overflowY = fullStyleHeight > maxStyleHeight ? "auto" : "hidden";
  }, [maxRows]);

  // Runs on initial render and whenever the value changes (typing, or an
  // existing long value being loaded for edit) - before the browser paints,
  // so the field never flashes at the wrong height.
  useLayoutEffect(() => {
    resize();
  }, [value, resize]);

  // Re-measure when the column width changes (responsive layout / window
  // resize can change how the text wraps).
  useEffect(() => {
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [resize]);

  function handleChange(event) {
    resize();
    if (onChange) onChange(event);
  }

  return (
    <textarea
      {...props}
      ref={ref}
      value={value}
      rows={minRows}
      onChange={handleChange}
      className={`auto-resize-textarea ${className}`.trim()}
    />
  );
}
