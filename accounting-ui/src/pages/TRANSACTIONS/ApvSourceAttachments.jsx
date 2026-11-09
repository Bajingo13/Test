import { apvAttachmentsPath } from "../../utils/rfpAttachments.mjs";
import { AttachmentsCard } from "./RfpAttachments";

// APV page: the supporting documents of the Request for Payment this APV was
// converted from. Read through the RFP -> APV link (the files stay with the
// RFP; nothing is copied) and authorized by APV VIEW in the APV's company.
// An APV that did not come from an RFP shows nothing.
export default function ApvSourceAttachments({ apvId }) {
  const path = apvAttachmentsPath(apvId);
  return (
    <AttachmentsCard
      key={path}
      listPath={path}
      basePath={path}
      hideWhenEmpty
      emptyText="The source Request for Payment has no supporting documents."
      render={(state) =>
        state.data?.sourceRfp ? <p className="rfp-att-sub">From Request for Payment {state.data.sourceRfp.rfpNo}</p> : null
      }
    />
  );
}
