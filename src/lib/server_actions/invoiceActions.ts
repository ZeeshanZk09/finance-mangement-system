'use server';

import { Actor } from '@/types/userTypes';
import prisma from '../prisma';
import { z } from 'zod';
import { createInvoiceSchema, updateInvoiceSchema } from '@/utils/invoiceValidator';
import { prismaErrorHandler, requireAdmin, requireTenantMatch } from '@/utils/userHelper';
import { recalcInvoiceTotals } from '@/utils/invoiceItemHelper';

/**
 * Actor type for permission/tenant scoping checks.
 * Example roles: 'USER' | 'Admin' | 'Super_Admin'
 */

/* ---------------- Validation Schemas ---------------- */

/* ---------------- Helpers ---------------- */

/* ---------------- Utility: recalc invoice totals ---------------- */

/**
 * Recalculates the invoice total from invoiceItems and updates status if payments cover it.
 * Should be run inside a transaction when called from create/update/delete flows.
 */

/* ---------------- Core Invoice operations ---------------- */

/**
 * Create invoice (with optional inline items).
 * - Validates inputs.
 * - Ensures tenant and customer exist and belong to tenant.
 * - Enforces invoiceNumber uniqueness per tenant.
 * - If items provided, creates invoiceItems and updates item.quantity (decrement) inside the same transaction.
 * - Computes invoice.total from items if not provided.
 */
export async function createInvoice(
  payload: {
    tenantId: number;
    customerId: number;
    invoiceNumber: string;
    date?: Date | string;
    dueDate?: Date | string;
    currency: string;
    total?: number;
    status?: 'DRAFT' | 'SENT' | 'PAID';
    items?: Array<{ itemId: number; quantity: number; unitPrice: number; description?: string }>;
    syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
  },
  actor?: Actor
) {
  try {
    const parsed = createInvoiceSchema.parse(payload);

    if (actor) requireTenantMatch(actor, parsed.tenantId);

    // validate tenant & customer
    const tenant = await prisma.tenant.findUnique({ where: { id: parsed.tenantId } });
    if (!tenant) throw new Error('Tenant not found.');

    const customer = await prisma.customer.findUnique({ where: { id: parsed.customerId } });
    if (!customer) throw new Error('Customer not found.');
    if (customer.tenantId !== parsed.tenantId)
      throw new Error('Customer does not belong to tenant.');

    // ensure unique invoiceNumber per tenant
    const existingInvoiceNumber = await prisma.invoice.findFirst({
      where: { tenantId: parsed.tenantId, invoiceNumber: parsed.invoiceNumber },
    });
    if (existingInvoiceNumber) throw new Error('Invoice number already used for this tenant.');

    // Transactional creation: invoice, invoiceItems (if any), inventory adjustments, recalc totals
    const created = await prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          tenantId: parsed.tenantId,
          invoiceNumber: parsed.invoiceNumber,
          date: parsed.date ? new Date(parsed.date) : new Date(),
          dueDate: parsed.dueDate ? new Date(parsed.dueDate) : null,
          currency: parsed.currency,
          total: parsed.total ?? 0, // may be recalculated below
          customerId: parsed.customerId,
          status: parsed.status ?? 'DRAFT',
          syncStatus: parsed.syncStatus ?? 'PENDING',
        },
      });

      // If items present, create invoiceItems and adjust stock
      if (parsed.items && parsed.items.length > 0) {
        for (const it of parsed.items) {
          // verify item belongs to tenant
          const item = await tx.item.findUnique({ where: { id: it.itemId } });
          if (!item) throw new Error(`Item ${it.itemId} not found.`);
          if (item.tenantId !== parsed.tenantId) throw new Error('Item tenant mismatch.');

          const lineTotal = it.unitPrice * it.quantity;

          await tx.invoiceItem.create({
            data: {
              tenantId: parsed.tenantId,
              invoiceId: invoice.id,
              itemId: it.itemId,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              lineTotal,
              description: it.description ?? null,
              syncStatus: 'PENDING',
            },
          });

          // decrement item quantity (allow negative only for Admin/Super_Admin)
          const newQty = (item.quantity ?? 0) - it.quantity;
          if (newQty < 0 && actor && actor.role !== 'Admin' && actor.role !== 'Super_Admin') {
            throw new Error(`Insufficient stock for item ${item.name} (${item.id}).`);
          }

          await tx.item.update({
            where: { id: item.id },
            data: { quantity: newQty, syncStatus: 'PENDING' },
          });
        }

        // recalc totals from items
        await recalcInvoiceTotals(tx, invoice.id, parsed.tenantId);
      } else if (parsed.total !== undefined) {
        // if no items but total provided, ensure status logic
        if (parsed.total > 0 && (parsed.status === undefined || parsed.status === 'DRAFT')) {
          await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'SENT' } });
        }
      }

      return invoice;
    });

    return created;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Get invoice by id with relations (items, payments, customer).
 * - Enforces tenant scoping when actor provided.
 */
export async function getInvoiceById(id: number, actor?: Actor) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: { items: { include: { item: true } }, payments: true, customer: true },
    });
    if (!invoice) return null;
    if (actor) requireTenantMatch(actor, invoice.tenantId);
    return invoice;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * List / search invoices with pagination & filters.
 * - Filters: tenantId (recommended), invoiceNumber, date range, status, unpaidOnly, customerId.
 * - When actor provided, tenant defaults to actor.tenantId.
 */
export async function getInvoices(options?: {
  tenantId?: number;
  invoiceNumber?: string;
  customerId?: number;
  status?: 'DRAFT' | 'SENT' | 'PAID';
  dateFrom?: Date | string;
  dateTo?: Date | string;
  unpaidOnly?: boolean;
  page?: number;
  pageSize?: number;
  actor?: Actor;
  includeCount?: boolean;
}) {
  try {
    const {
      tenantId,
      invoiceNumber,
      customerId,
      status,
      dateFrom,
      dateTo,
      unpaidOnly = false,
      page = 1,
      pageSize = 25,
      actor,
      includeCount = false,
    } = options || {};

    const effectiveTenantId = actor ? actor.tenantId : tenantId;
    if (!effectiveTenantId) throw new Error('tenantId required.');

    if (actor && typeof tenantId === 'number' && tenantId !== actor.tenantId)
      requireTenantMatch(actor, tenantId);

    const where: any = { tenantId: effectiveTenantId };
    if (invoiceNumber) where.invoiceNumber = invoiceNumber;
    if (customerId) where.customerId = customerId;
    if (status) where.status = status;
    if (dateFrom || dateTo) where.date = {};
    if (dateFrom) where.date.gte = typeof dateFrom === 'string' ? new Date(dateFrom) : dateFrom;
    if (dateTo) where.date.lte = typeof dateTo === 'string' ? new Date(dateTo) : dateTo;

    if (unpaidOnly) {
      where.AND = [
        { total: { gt: 0 } },
        {
          // invoices where sum(payments) < total
          // Prisma can't easily express subqueries in where; do a two-step approach:
        },
      ];
    }

    // Basic listing
    const invoices = await prisma.invoice.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { date: 'desc' },
      include: { customer: true },
    });

    if (includeCount) {
      const total = await prisma.invoice.count({ where });
      return { invoices, total, page, pageSize };
    }

    // If unpaidOnly requested, filter client-side (less efficient but safe)
    if (unpaidOnly && invoices.length > 0) {
      // fetch payments sums for returned invoices
      const invoiceIds = invoices.map((inv) => inv.id);
      const payments = await prisma.payment.groupBy({
        by: ['invoiceId'],
        where: { invoiceId: { in: invoiceIds } },
        _sum: { amount: true },
      });
      const paidMap: Record<number, number> = {};
      payments.forEach((p: any) => (paidMap[p.invoiceId] = p._sum.amount ?? 0));
      const filtered = invoices.filter((inv: any) => (paidMap[inv.id] ?? 0) < (inv.total ?? 0));
      return filtered;
    }

    return invoices;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Update an invoice.
 * - Validates input.
 * - Enforces tenant scoping and Admin check for critical fields (invoiceNumber).
 * - Recalculates totals when needed (if items change outside this function, call recalcInvoiceTotals separately).
 */
export async function updateInvoice(
  id: number,
  data: {
    invoiceNumber?: string;
    date?: Date | string;
    dueDate?: Date | string;
    currency?: string;
    total?: number;
    status?: 'DRAFT' | 'SENT' | 'PAID';
    syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
  },
  actor?: Actor
) {
  try {
    const parsed = updateInvoiceSchema.parse(data);
    const existing = await prisma.invoice.findUnique({ where: { id } });
    if (!existing) throw new Error('Invoice not found.');

    if (actor) requireTenantMatch(actor, existing.tenantId);

    // If invoiceNumber changing, ensure uniqueness per tenant and only Admin can change
    if (parsed.invoiceNumber && parsed.invoiceNumber !== existing.invoiceNumber) {
      if (actor) requireAdmin(actor);
      const conflict = await prisma.invoice.findFirst({
        where: {
          tenantId: existing.tenantId,
          invoiceNumber: parsed.invoiceNumber,
          id: { not: id },
        },
      });
      if (conflict) throw new Error('Another invoice with this number exists for the tenant.');
    }

    const updated = await prisma.invoice.update({
      where: { id },
      data: {
        ...(parsed.invoiceNumber ? { invoiceNumber: parsed.invoiceNumber } : {}),
        ...(parsed.date ? { date: new Date(parsed.date) } : {}),
        ...(parsed.dueDate ? { dueDate: new Date(parsed.dueDate) } : {}),
        ...(parsed.currency ? { currency: parsed.currency } : {}),
        ...(parsed.total !== undefined ? { total: parsed.total } : {}),
        ...(parsed.status ? { status: parsed.status } : {}),
        ...(parsed.syncStatus ? { syncStatus: parsed.syncStatus } : {}),
      },
    });

    // If total changed manually, you might want to re-evaluate status/payments relationship (optional).
    // For now, return updated. Recalc totals from invoiceItems if needed via recalcInvoiceTotals.

    return updated;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Delete invoice.
 * - Prevent deletion if payments exist unless force=true and caller is Super_Admin.
 * - Prefer soft-delete in production (add deletedAt/isActive to schema).
 */
export async function deleteInvoice(id: number, options?: { force?: boolean; actor?: Actor }) {
  try {
    const { force = false, actor } = options || {};
    const existing = await prisma.invoice.findUnique({ where: { id } });
    if (!existing) throw new Error('Invoice not found.');

    if (actor) requireTenantMatch(actor, existing.tenantId);

    const paymentCount = await prisma.payment.count({ where: { invoiceId: id } });
    if (paymentCount > 0 && !force) {
      throw new Error('Invoice has payments and cannot be deleted without force=true.');
    }

    if (force && actor && actor.role !== 'Super_Admin') {
      throw new Error('Only Super_Admin can force-delete invoices with payments.');
    }

    // When deleting, restore item quantities for invoice items (transactional)
    const deleted = await prisma.$transaction(async (tx) => {
      const items = await tx.invoiceItem.findMany({ where: { invoiceId: id } });
      for (const ii of items) {
        // restore stock
        await tx.item.update({
          where: { id: ii.itemId },
          data: { quantity: { increment: ii.quantity } as any, syncStatus: 'PENDING' } as any,
        });
      }
      await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
      if (paymentCount > 0) {
        await tx.payment.deleteMany({ where: { invoiceId: id } });
      }
      const d = await tx.invoice.delete({ where: { id } });
      return d;
    });

    return deleted;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/* ---------------- Offline-first / Sync helpers ---------------- */

/**
 * Get unsynced invoices for client sync engine.
 */
export async function getUnsyncedInvoices(tenantId: number, limit = 200, actor?: Actor) {
  try {
    if (actor) requireTenantMatch(actor, tenantId);
    const rows = await prisma.invoice.findMany({
      where: { tenantId, syncStatus: 'PENDING' },
      take: limit,
      orderBy: { updatedAt: 'asc' },
    });
    return rows;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Mark invoices as synced (bulk).
 */
export async function markInvoicesAsSynced(ids: number[], actor?: Actor) {
  try {
    if (!ids || ids.length === 0) return { count: 0 };
    if (actor) {
      const countDifferentTenant = await prisma.invoice.count({
        where: { id: { in: ids }, tenantId: { not: actor.tenantId } },
      });
      if (countDifferentTenant > 0)
        throw new Error('Attempt to mark invoices outside your tenant.');
    }
    const res = await prisma.invoice.updateMany({
      where: { id: { in: ids } },
      data: { syncStatus: 'SYNCED' },
    });
    return { count: res.count };
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Apply remote invoices (device -> server).
 * - Basic conflict strategy using updatedAt timestamps.
 * - If invoice contains nested items in payload, these are applied as well (attempt safe upserts).
 * - Careful: this is a simple approach; for complex conflicts consider operation logs or CRDTs.
 */
export async function applyRemoteInvoices(
  remoteInvoices: Array<
    Partial<{
      id: number;
      tenantId: number;
      customerId: number;
      invoiceNumber: string;
      date: string | Date;
      dueDate?: string | Date;
      currency?: string;
      total?: number;
      status?: 'DRAFT' | 'SENT' | 'PAID';
      items?: Array<{ itemId: number; quantity: number; unitPrice: number; description?: string }>;
      updatedAt?: string | Date;
      syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
    }>
  >,
  actor?: Actor
) {
  if (!remoteInvoices || remoteInvoices.length === 0) return { applied: 0 };

  const chunkSize = 20;
  let applied = 0;

  try {
    for (let i = 0; i < remoteInvoices.length; i += chunkSize) {
      const chunk = remoteInvoices.slice(i, i + chunkSize);

      if (actor) {
        const mismatch = chunk.some(
          (r) => typeof r.tenantId === 'number' && r.tenantId !== actor.tenantId
        );
        if (mismatch) throw new Error('Tenant mismatch in remote payload.');
      }

      for (const ri of chunk) {
        if (!ri.tenantId) {
          if (actor) ri.tenantId = actor.tenantId;
          else throw new Error('tenantId missing from remote invoice payload.');
        }
        // basic validation
        if (!ri.customerId || !ri.invoiceNumber) continue;

        // If id provided try to upsert-like behavior
        if (typeof ri.id === 'number') {
          const local = await prisma.invoice.findUnique({ where: { id: ri.id } });
          if (!local) {
            // create invoice (and optionally items)
            await prisma.$transaction(async (tx) => {
              const inv = await tx.invoice.create({
                data: {
                  tenantId: ri.tenantId!,
                  customerId: ri.customerId!,
                  invoiceNumber: ri.invoiceNumber!,
                  date: ri.date ? new Date(ri.date) : new Date(),
                  dueDate: ri.dueDate ? new Date(ri.dueDate) : null,
                  currency: ri.currency ?? 'USD',
                  total: ri.total ?? 0,
                  status: ri.status ?? 'DRAFT',
                  syncStatus: ri.syncStatus ?? 'SYNCED',
                },
              });

              if (ri.items && ri.items.length > 0) {
                for (const it of ri.items) {
                  // create invoiceItem and adjust stock
                  await tx.invoiceItem
                    .create({
                      data: {
                        tenantId: ri.tenantId!,
                        invoiceId: inv.id,
                        itemId: it.itemId,
                        quantity: it.quantity,
                        unitPrice: it.unitPrice,
                        lineTotal: it.unitPrice * it.quantity,
                        description: it.description ?? null,
                        syncStatus: 'SYNCED',
                      },
                    })
                    .catch(() => {
                      // continue on item create failure to avoid full abort (or handle specially)
                    });
                  // decrement item
                  await tx.item
                    .update({
                      where: { id: it.itemId },
                      data: {
                        quantity: { decrement: it.quantity } as any,
                        syncStatus: 'PENDING',
                      } as any,
                    })
                    .catch(() => {});
                }
                await recalcInvoiceTotals(tx, inv.id, ri.tenantId!);
              }
            });
            applied++;
            continue;
          } else {
            // conflict resolution by updatedAt timestamp
            const remoteUpdated = ri.updatedAt ? new Date(ri.updatedAt).getTime() : 0;
            const localUpdated = (local.updatedAt ?? local.createdAt).getTime();
            if (remoteUpdated > localUpdated) {
              await prisma.$transaction(async (tx) => {
                await tx.invoice.update({
                  where: { id: local.id },
                  data: {
                    customerId: ri.customerId ?? local.customerId,
                    invoiceNumber: ri.invoiceNumber ?? local.invoiceNumber,
                    date: ri.date ? new Date(ri.date) : local.date,
                    dueDate: ri.dueDate ? new Date(ri.dueDate) : local.dueDate,
                    currency: ri.currency ?? local.currency,
                    total: ri.total ?? local.total,
                    status: ri.status ?? local.status,
                    syncStatus: ri.syncStatus ?? local.syncStatus,
                  },
                });

                // If items provided, we attempt to merge/update similarly to invoiceItem.apply logic
                if (ri.items && ri.items.length > 0) {
                  for (const it of ri.items) {
                    // try find existing line by invoiceId + itemId
                    const existingLine = await tx.invoiceItem.findFirst({
                      where: { invoiceId: local.id, itemId: it.itemId },
                    });
                    if (existingLine) {
                      // update if remote newer logic could be applied; here we just update values
                      await tx.invoiceItem
                        .update({
                          where: { id: existingLine.id },
                          data: {
                            quantity: it.quantity,
                            unitPrice: it.unitPrice,
                            lineTotal: it.unitPrice * it.quantity,
                            description: it.description ?? existingLine.description,
                            syncStatus: 'SYNCED',
                          },
                        })
                        .catch(() => {});
                    } else {
                      await tx.invoiceItem
                        .create({
                          data: {
                            tenantId: ri.tenantId!,
                            invoiceId: local.id,
                            itemId: it.itemId,
                            quantity: it.quantity,
                            unitPrice: it.unitPrice,
                            lineTotal: it.unitPrice * it.quantity,
                            description: it.description ?? null,
                            syncStatus: 'SYNCED',
                          },
                        })
                        .catch(() => {});
                      // decrement item
                      await tx.item
                        .update({
                          where: { id: it.itemId },
                          data: {
                            quantity: { decrement: it.quantity } as any,
                            syncStatus: 'PENDING',
                          } as any,
                        })
                        .catch(() => {});
                    }
                  }
                }

                // recalc totals
                await recalcInvoiceTotals(tx, local.id, ri.tenantId!);
              });
              applied++;
            }
            continue;
          }
        }

        // No id: attempt find by invoiceNumber within tenant
        const byNumber = await prisma.invoice.findFirst({
          where: { tenantId: ri.tenantId, invoiceNumber: ri.invoiceNumber },
        });
        if (byNumber) {
          // treat as update if remote newer
          const remoteUpdated = ri.updatedAt ? new Date(ri.updatedAt).getTime() : 0;
          const localUpdated = (byNumber.updatedAt ?? byNumber.createdAt).getTime();
          if (remoteUpdated > localUpdated) {
            await prisma.invoice.update({
              where: { id: byNumber.id },
              data: {
                customerId: ri.customerId ?? byNumber.customerId,
                date: ri.date ? new Date(ri.date) : byNumber.date,
                dueDate: ri.dueDate ? new Date(ri.dueDate) : byNumber.dueDate,
                currency: ri.currency ?? byNumber.currency,
                total: ri.total ?? byNumber.total,
                status: ri.status ?? byNumber.status,
                syncStatus: ri.syncStatus ?? byNumber.syncStatus,
              },
            });
            applied++;
          }
          continue;
        }

        // fallback: create minimal invoice (no items)
        await prisma.invoice.create({
          data: {
            tenantId: ri.tenantId!,
            customerId: ri.customerId,
            invoiceNumber: ri.invoiceNumber,
            date: ri.date ? new Date(ri.date) : new Date(),
            dueDate: ri.dueDate ? new Date(ri.dueDate) : null,
            currency: ri.currency ?? 'USD',
            total: ri.total ?? 0,
            status: ri.status ?? 'DRAFT',
            syncStatus: ri.syncStatus ?? 'SYNCED',
          },
        });
        applied++;
      }
    }

    return { applied };
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Get invoices updated since a timestamp (server -> client sync).
 */
export async function getInvoicesUpdatedSince(
  since: Date,
  options?: { tenantId?: number; actor?: Actor }
) {
  try {
    const { tenantId, actor } = options || {};
    const where: any = { updatedAt: { gt: since } };
    if (actor && actor.role !== 'Super_Admin') where.tenantId = actor.tenantId;
    else if (tenantId) where.tenantId = tenantId;

    const invoices = await prisma.invoice.findMany({
      where,
      orderBy: { updatedAt: 'asc' },
      include: { items: true, payments: true },
    });
    return invoices;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/* ---------------- Reporting & Export helpers ---------------- */

/**
 * Export a single invoice (invoice + items + payments + customer) for backup or sharing.
 */
export async function exportInvoiceById(invoiceId: number, actor?: Actor) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { items: { include: { item: true } }, payments: true, customer: true },
    });
    if (!invoice) throw new Error('Invoice not found.');
    if (actor) requireTenantMatch(actor, invoice.tenantId);

    return { invoice, exportedAt: new Date().toISOString() };
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Get outstanding invoices (for reminders / reconciliations)
 */
export async function getOutstandingInvoices(
  tenantId: number,
  options?: { daysOverdue?: number; actor?: Actor }
) {
  try {
    const { daysOverdue = 0, actor } = options || {};
    if (actor) requireTenantMatch(actor, tenantId);

    // fetch invoices with total > sum(payments)
    const invoices = await prisma.invoice.findMany({
      where: { tenantId, total: { gt: 0 }, status: { not: 'PAID' } },
      include: { payments: true, customer: true },
    });

    const now = Date.now();
    const results = invoices
      .map((inv: any) => {
        const paid = (inv.payments ?? []).reduce((s: number, p: any) => s + (p.amount ?? 0), 0);
        const outstanding = (inv.total ?? 0) - paid;
        const dueDate = inv.dueDate ? new Date(inv.dueDate).getTime() : null;
        const overdueDays = dueDate ? Math.floor((now - dueDate) / (1000 * 60 * 60 * 24)) : null;
        return { ...inv, paid, outstanding, overdueDays };
      })
      .filter(
        (r: any) =>
          r.outstanding > 0 &&
          (daysOverdue <= 0 || (r.overdueDays !== null && r.overdueDays >= daysOverdue))
      );

    return results;
  } catch (err) {
    prismaErrorHandler(err);
  }
}
