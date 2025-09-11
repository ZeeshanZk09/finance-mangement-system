async function recalcInvoiceTotals(tx: any, invoiceId: number, tenantId: number) {
  const itemsAgg = await tx.invoiceItem.aggregate({
    where: { invoiceId, tenantId },
    _sum: { lineTotal: true },
  });
  const total = itemsAgg._sum.lineTotal ?? 0;

  // compute payments sum
  const paymentsAgg = await tx.payment.aggregate({
    where: { invoiceId, tenantId },
    _sum: { amount: true },
  });
  const totalPaid = paymentsAgg._sum.amount ?? 0;

  // decide status: PAID if totalPaid >= total and total > 0; if total === 0 keep DRAFT
  const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error('Invoice not found for totals recalculation.');

  let newStatus = invoice.status;
  if (total > 0) {
    newStatus = totalPaid >= total ? 'PAID' : invoice.status === 'DRAFT' ? 'SENT' : invoice.status;
  }

  await tx.invoice.update({
    where: { id: invoiceId },
    data: { total, ...(newStatus !== invoice.status ? { status: newStatus } : {}) },
  });

  return { total, totalPaid, newStatus };
}

export { recalcInvoiceTotals };
