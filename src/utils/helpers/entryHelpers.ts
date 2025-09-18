import { Actor } from '@/types/userTypes';
import { requireActor } from './userHelpers';
import prisma from '@/lib/prisma';
import { requireTenantMatch } from './tenantHelpers';
import { ApiError } from '../NextApiError';
/**
 * Ensure an upload belongs to actor’s tenant.
 */
export async function ensureUploadAccess(actor: Actor, uploadId: number) {
  requireActor(actor);
  const upload = await prisma.upload.findUnique({
    where: { id: uploadId },
    select: { id: true, tenantId: true, userId: true, status: true },
  });
  if (!upload) throw new ApiError(404, 'Upload not found.');
  requireTenantMatch(actor, upload.tenantId);
  return upload;
}

/**
 * Ensure an invoice belongs to actor’s tenant.
 */
export async function ensureInvoiceAccess(actor: Actor, invoiceId: number) {
  requireActor(actor);
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, tenantId: true, status: true },
  });
  if (!invoice) throw new ApiError(404, 'Invoice not found.');
  requireTenantMatch(actor, invoice.tenantId);
  return invoice;
}

/**
 * Ensure a customer belongs to actor’s tenant.
 */
export async function ensureCustomerAccess(actor: Actor, customerId: number) {
  requireActor(actor);
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, tenantId: true },
  });
  if (!customer) throw new ApiError(404, 'Customer not found.');
  requireTenantMatch(actor, customer.tenantId);
  return customer;
}
