// Ported from the Replica's #customerInfoBlock (SOLD TO / ADDRESS / VAT
// Reg. TIN rows).
export default function InvoiceCustomerSection({ customer }) {
  return (
    <div className="invoice-customer-block">
      <div>
        <strong>SOLD TO:</strong> <span>{customer.name}</span>
      </div>
      <div>
        <strong>ADDRESS:</strong> <span>{customer.address}</span>
      </div>
      <div>
        <strong>VAT Reg. TIN:</strong> <span>{customer.tin}</span>
      </div>
    </div>
  );
}
