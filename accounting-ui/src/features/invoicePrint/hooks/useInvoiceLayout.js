// The Accounting System already resolves the effective print-template
// configuration server-side (invoicePrintDataService -> printTemplateService
// .resolveEffectiveConfig: invoice-specific template -> company default ->
// built-in Standard fallback), so this hook does not fetch anything itself -
// it just exposes the already-resolved `layout` block from the print view
// model as typed, safe values for the React components to read.
//
// Only whitelisted, validated fields ever reach here (see
// printTemplateService.js's own CONFIG_SCHEMA/whitelists) - never raw HTML
// or script, matching the "safe adapter" requirement.
export default function useInvoiceLayout(layout) {
  const configuration = layout?.configuration || null;

  return {
    source: layout?.snapshot?.source || "built_in",
    templateId: layout?.snapshot?.templateId || null,
    templateName: layout?.snapshot?.templateName || null,
    header: configuration?.header || null,
    party: configuration?.party || null,
    meta: configuration?.meta || null,
    table: configuration?.table || null,
    summary: configuration?.summary || null,
    sectionOrder: configuration?.layout?.sectionOrder || null,
  };
}
