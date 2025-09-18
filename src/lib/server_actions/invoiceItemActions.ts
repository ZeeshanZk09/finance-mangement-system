'use server';

import { Actor } from '@/types/userTypes';
import prisma from '@/lib/prisma';
import type { PrismaClient } from '@/app/generated/prisma/client';
import {
  createInvoiceItemSchema,
  updateInvoiceItemSchema,
} from '@/utils/validators/invoiceItemValidator';
import { prismaErrorHandler, requireTenantMatch } from '@/utils/helpers/userHelpers';
import { recalcInvoiceTotals } from '@/utils/helpers/invoiceItemHelper';
import { ApiError } from '@/utils/NextApiError';

/**
 * Actor type for permission/tenant scoping checks.
 * Example roles: 'USER' | 'Admin' | 'Super_Admin'
 */

/* ---------------- Validation Schemas ---------------- */

/* ---------------- Helpers & Guards ---------------- */

/* ---------------- Utility functions ---------------- */

/**
 * Recalculate invoice totals (sum of invoice items) and update invoice.total and status.
 * - Should be called inside a transaction where possible to maintain consistency.
 */

/* ---------------- Core CRUD with business logic ---------------- */

/**
 * Create an invoice item.
 * - Validates input.
 * - Ensures tenant/invoice/item exist and belong to tenant.
 * - Computes lineTotal if not provided.
 * - Adjusts item.quantity (decrement) as part of transaction (sales).
 * - Recalculates invoice totals after creation.
 */
export async function createInvoiceItem(
  data: {
    tenantId: number;
    invoiceId: number;
    itemId: number;
    quantity: number;
    unitPrice: number;
    lineTotal?: number;
    description?: string;
    syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
  },
  actor?: Actor
) {
  try {
    const parsed = createInvoiceItemSchema.parse(data);

    if (actor) requireTenantMatch(actor, parsed.tenantId);

    // Transaction: create invoiceItem, adjust item qty, recalc invoice total
    const created = await (prisma as unknown as PrismaClient).$transaction(async (tx) => {
      // verify invoice
      const invoice = await tx.invoice.findUnique({ where: { id: parsed.invoiceId } });
      if (!invoice) throw new Error('Invoice not found.');
      if (invoice.tenantId !== parsed.tenantId) throw new Error('Invoice tenant mismatch.');

      // verify item
      const item = await tx.item.findUnique({ where: { id: parsed.itemId } });
      if (!item) throw new Error('Item not found.');
      if (item.tenantId !== parsed.tenantId) throw new Error('Item tenant mismatch.');

      // compute lineTotal if missing
      const computedLineTotal = parsed.lineTotal ?? parsed.unitPrice * parsed.quantity;

      // adjust stock: reduce quantity for sale; disallow negative stock unless Admin
      const resultingQty = +(item.quantity ?? 0) - parsed.quantity;
      if (resultingQty < 0 && actor && actor.role !== 'Admin' && actor.role !== 'Super_Admin') {
        throw new Error('Insufficient stock for this operation. Admins can override.');
      }

      // create invoice item
      const invoiceItem = await tx.invoiceItem.create({
        data: {
          tenantId: parsed.tenantId,
          invoiceId: parsed.invoiceId,
          itemId: parsed.itemId,
          quantity: parsed.quantity,
          unitPrice: parsed.unitPrice,
          lineTotal: computedLineTotal,
          description: parsed.description ?? null,
          syncStatus: parsed.syncStatus ?? 'PENDING',
        },
      });

      // update item quantity (allow negative only for Admins)
      await tx.item.update({
        where: { id: parsed.itemId },
        data: { quantity: resultingQty, syncStatus: 'PENDING' },
      });

      // recalc invoice totals & status
      await recalcInvoiceTotals(tx as any, parsed.invoiceId, parsed.tenantId);

      return invoiceItem;
    });

    return created;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Get invoice item by id (tenant-scoped when actor present)
 */
export async function getInvoiceItemById(id: number, actor?: Actor) {
  try {
    const ii = await prisma.invoiceItem.findUnique({ where: { id } });
    if (!ii) return null;
    if (actor) requireTenantMatch(actor, ii.tenantId);
    return ii;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * List invoice items with filters, pagination.
 * - Default tenant scope to actor.tenantId when actor provided.
 */
export async function getInvoiceItems(options?: {
  tenantId?: number;
  invoiceId?: number;
  page?: number;
  pageSize?: number;
  search?: string; // search within description or item.name (requires join)
  actor?: Actor;
  includeCount?: boolean;
}) {
  try {
    const {
      tenantId,
      invoiceId,
      page = 1,
      pageSize = 50,
      search,
      actor,
      includeCount = false,
    } = options || {};

    const effectiveTenantId = actor ? actor.tenantId : tenantId;
    if (!effectiveTenantId && !invoiceId) throw new Error('tenantId or invoiceId is required.');

    const where: any = {};
    if (effectiveTenantId) where.tenantId = effectiveTenantId;
    if (invoiceId) where.invoiceId = invoiceId;
    if (search) {
      where.OR = [
        { description: { contains: search, mode: 'insensitive' } },
        // join to item name via relation filter
        { item: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const items = await prisma.invoiceItem.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      include: { item: true },
    });

    if (includeCount) {
      const total = await prisma.invoiceItem.count({ where });
      return { items, total, page, pageSize };
    }
    return items;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Update an invoice item.
 * - Validates input.
 * - Applies quantity delta to item.quantity defensively in a transaction.
 * - Recomputes invoice totals afterward.
 */
export async function updateInvoiceItem(
  id: number,
  data: {
    quantity?: number;
    unitPrice?: number;
    lineTotal?: number;
    description?: string;
    syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
  },
  actor?: Actor
) {
  try {
    const parsed = updateInvoiceItemSchema.parse(data);
    const existing = await prisma.invoiceItem.findUnique({ where: { id } });
    if (!existing) throw new Error('InvoiceItem not found.');

    if (actor) requireTenantMatch(actor, existing.tenantId);

    const updated = await (prisma as unknown as PrismaClient).$transaction(async (tx) => {
      // if quantity is changing, compute delta and apply to item
      if (parsed.quantity && existing.quantity) {
        if (+parsed.quantity !== +existing.quantity) {
          const item = await tx.item.findUnique({ where: { id: existing.itemId } });
          if (!item) throw new ApiError(404, 'Associated item not found.');

          const delta = parsed.quantity - +existing.quantity; // positive means increase in invoice quantity (reduce stock)
          const resultingQty = +(item.quantity ?? 0) - delta;
          if (resultingQty < 0 && actor && actor.role !== 'Admin' && actor.role !== 'Super_Admin') {
            throw new Error('Insufficient stock for this update. Admins can override.');
          }

          // update item quantity and mark pending
          await tx.item.update({
            where: { id: item.id },
            data: { quantity: resultingQty, syncStatus: 'PENDING' },
          });
        }
      }

      // apply invoiceItem update
      const newLineTotal =
        parsed.lineTotal !== undefined
          ? parsed.lineTotal
          : parsed.unitPrice !== undefined && parsed.quantity !== undefined
          ? parsed.unitPrice * parsed.quantity
          : parsed.unitPrice !== undefined
          ? +parsed.unitPrice * +existing.quantity
          : parsed.quantity !== undefined
          ? +existing.unitPrice * +parsed.quantity
          : existing.lineTotal;

      const u = await tx.invoiceItem.update({
        where: { id },
        data: {
          ...(parsed.quantity !== undefined ? { quantity: parsed.quantity } : {}),
          ...(parsed.unitPrice !== undefined ? { unitPrice: parsed.unitPrice } : {}),
          ...(newLineTotal !== undefined ? { lineTotal: newLineTotal } : {}),
          ...(parsed.description !== undefined ? { description: parsed.description } : {}),
          ...(parsed.syncStatus ? { syncStatus: parsed.syncStatus } : {}),
        },
      });

      // recalc invoice totals
      await recalcInvoiceTotals(tx as any, existing.invoiceId, existing.tenantId);

      return u;
    });

    return updated;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Delete an invoice item.
 * - Restores item.quantity (adds back sold qty) in transaction.
 * - Recomputes invoice totals after deletion.
 * - If force=true and actor is Super_Admin allows deletion even if invoice paid (use with caution).
 */
export async function deleteInvoiceItem(id: number, options?: { force?: boolean; actor?: Actor }) {
  try {
    const { force = false, actor } = options || {};
    const existing = await prisma.invoiceItem.findUnique({ where: { id } });
    if (!existing) throw new Error('InvoiceItem not found.');

    if (actor) requireTenantMatch(actor, existing.tenantId);

    // prevent deleting from a PAID invoice unless force with Super_Admin
    const invoice = await prisma.invoice.findUnique({ where: { id: existing.invoiceId } });
    if (!invoice) throw new Error('Associated invoice not found.');
    if (invoice.status === 'PAID' && !force) {
      throw new Error('Cannot delete invoice item from a PAID invoice without force=true.');
    }
    if (force && actor && actor.role !== 'Super_Admin') {
      throw new Error('Only Super_Admin can force-delete invoice items from PAID invoices.');
    }

    const deleted = await (prisma as unknown as PrismaClient).$transaction(async (tx) => {
      // restore item quantity
      const item = await tx.item.findUnique({ where: { id: existing.itemId } });
      if (!item) throw new Error('Associated item not found during delete.');

      await tx.item.update({
        where: { id: item.id },
        data: { quantity: +(item.quantity ?? 0) + +existing.quantity, syncStatus: 'PENDING' },
      });

      // delete the invoice item
      const d = await tx.invoiceItem.delete({ where: { id } });

      // recalc invoice totals
      await recalcInvoiceTotals(tx as any, existing.invoiceId, existing.tenantId);

      return d;
    });

    return deleted;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/* ---------------- Offline-first / Sync helpers ---------------- */

/**
 * Get unsynced invoice items for a tenant (client sync engine).
 */
export async function getUnsyncedInvoiceItems(tenantId: string, limit = 200, actor?: Actor) {
  try {
    if (actor) requireTenantMatch(actor, tenantId);

    const rows = await prisma.invoiceItem.findMany({
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
 * Mark invoice items as synced (bulk).
 */
export async function markInvoiceItemsAsSynced(ids: number[], actor?: Actor) {
  try {
    if (!ids || ids.length === 0) return { count: 0 };
    if (actor) {
      const countDifferentTenant = await prisma.invoiceItem.count({
        where: { id: { in: ids }, tenantId: { not: actor.tenantId } },
      });
      if (countDifferentTenant > 0)
        throw new Error('Attempt to mark invoice items outside your tenant.');
    }

    const res = await prisma.invoiceItem.updateMany({
      where: { id: { in: ids } },
      data: { syncStatus: 'SYNCED' },
    });

    return { count: res.count };
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Apply remote invoice items (device -> server).
 * - Basic conflict strategy: if id exists compare updatedAt, otherwise create.
 * - Adjusts item.quantity when creating new invoice items (assumes remote represents sales that haven't been applied).
 * - Be careful: this is a simple approach — in complex scenarios use operation logs or CRDTs.
 */
export async function applyRemoteInvoiceItems(
  remoteItems: Array<
    Partial<{
      id: number;
      tenantId: string;
      invoiceId: number;
      itemId: number;
      quantity: number;
      unitPrice: number;
      lineTotal?: number;
      description?: string;
      updatedAt?: string | Date;
      syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
    }>
  >,
  actor?: Actor
) {
  if (!remoteItems || remoteItems.length === 0) return { applied: 0 };
  const chunkSize = 25;
  let applied = 0;

  try {
    for (let i = 0; i < remoteItems.length; i += chunkSize) {
      const chunk = remoteItems.slice(i, i + chunkSize);

      if (actor) {
        const mismatch = chunk.some(
          (r) => typeof r.tenantId === 'number' && r.tenantId !== actor.tenantId
        );
        if (mismatch) throw new Error('Tenant mismatch in remote payload.');
      }

      for (const ri of chunk) {
        if (!ri.tenantId) {
          if (actor) ri.tenantId = actor.tenantId;
          else throw new Error('tenantId missing from remote invoiceItem payload.');
        }
        // Basic validation
        if (!ri.invoiceId || !ri.itemId || !ri.quantity || !ri.unitPrice) continue;

        // If id provided, try to update if remote newer
        if (typeof ri.id === 'number') {
          const local = await prisma.invoiceItem.findUnique({ where: { id: ri.id } });
          if (!local) {
            // create new (and adjust stock)
            await (prisma as unknown as PrismaClient).$transaction(async (tx) => {
              await tx.invoiceItem.create({
                data: {
                  tenantId: ri.tenantId!,
                  invoiceId: ri.invoiceId!,
                  itemId: ri.itemId!,
                  quantity: ri.quantity!,
                  unitPrice: ri.unitPrice!,
                  lineTotal: ri.lineTotal ?? ri.unitPrice! * ri.quantity!,
                  description: ri.description ?? null,
                  syncStatus: ri.syncStatus ?? 'SYNCED',
                },
              });
              // decrement item quantity defensively
              await tx.item.update({
                where: { id: ri.itemId },
                data: { quantity: { decrement: ri.quantity }, syncStatus: 'PENDING' } as any,
              });
              // recalc invoice totals
              await recalcInvoiceTotals(tx as any, ri.invoiceId!, ri.tenantId!);
            });
            applied++;
            continue;
          } else {
            const remoteUpdated = ri.updatedAt ? new Date(ri.updatedAt).getTime() : 0;
            const localUpdated = (local.updatedAt ?? local.createdAt).getTime();
            if (remoteUpdated > localUpdated) {
              // Update fields and adjust item qty by delta
              await (prisma as unknown as PrismaClient).$transaction(async (tx) => {
                const delta = +ri.quantity! - +local.quantity; // positive => reduce stock
                if (delta !== 0) {
                  // adjust item quantity (decrement for positive delta)
                  await tx.item.update({
                    where: { id: local.itemId },
                    data: { quantity: { decrement: delta } as any, syncStatus: 'PENDING' } as any,
                  });
                }
                await tx.invoiceItem.update({
                  where: { id: local.id },
                  data: {
                    quantity: ri.quantity,
                    unitPrice: ri.unitPrice,
                    lineTotal: ri.lineTotal ?? ri.unitPrice! * ri.quantity!,
                    description: ri.description ?? local.description,
                    syncStatus: ri.syncStatus ?? 'SYNCED',
                  },
                });
                await recalcInvoiceTotals(tx as any, local.invoiceId, ri.tenantId!);
              });
              applied++;
            }
            continue;
          }
        }

        // No id: try dedupe by invoiceId+itemId (line uniqueness) or create new
        const existsLine = await prisma.invoiceItem.findFirst({
          where: { tenantId: ri.tenantId, invoiceId: ri.invoiceId, itemId: ri.itemId },
        });
        if (existsLine) {
          const remoteUpdated = ri.updatedAt ? new Date(ri.updatedAt).getTime() : 0;
          const localUpdated = (existsLine.updatedAt ?? existsLine.createdAt).getTime();
          if (remoteUpdated > localUpdated) {
            await (prisma as unknown as PrismaClient).$transaction(async (tx) => {
              const delta = +ri.quantity! - +existsLine.quantity;
              if (delta !== 0) {
                await tx.item.update({
                  where: { id: existsLine.itemId },
                  data: { quantity: { decrement: delta } as any, syncStatus: 'PENDING' } as any,
                });
              }
              await tx.invoiceItem.update({
                where: { id: existsLine.id },
                data: {
                  quantity: ri.quantity,
                  unitPrice: ri.unitPrice,
                  lineTotal: ri.lineTotal ?? ri.unitPrice! * ri.quantity!,
                  description: ri.description ?? existsLine.description,
                  syncStatus: ri.syncStatus ?? 'SYNCED',
                },
              });
              await recalcInvoiceTotals(tx as any, ri.invoiceId!, ri.tenantId!);
            });
            applied++;
            continue;
          } else {
            continue;
          }
        }

        // Create new invoice item (and adjust item qty)
        await (prisma as unknown as PrismaClient).$transaction(async (tx) => {
          await tx.invoiceItem.create({
            data: {
              tenantId: ri.tenantId!,
              invoiceId: ri.invoiceId!,
              itemId: ri.itemId!,
              quantity: ri.quantity!,
              unitPrice: ri.unitPrice!,
              lineTotal: ri.lineTotal ?? ri.unitPrice! * ri.quantity!,
              description: ri.description ?? null,
              syncStatus: ri.syncStatus ?? 'SYNCED',
            },
          });
          await tx.item.update({
            where: { id: ri.itemId },
            data: { quantity: { decrement: ri.quantity } as any, syncStatus: 'PENDING' } as any,
          });
          await recalcInvoiceTotals(tx as any, ri.invoiceId!, ri.tenantId!);
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
 * Get invoice items updated since a timestamp (server -> client sync).
 */
export async function getInvoiceItemsUpdatedSince(
  since: Date,
  options?: { tenantId?: number; actor?: Actor }
) {
  try {
    const { tenantId, actor } = options || {};
    const where: any = { updatedAt: { gt: since } };
    if (actor && actor.role !== 'Super_Admin') where.tenantId = actor.tenantId;
    else if (tenantId) where.tenantId = tenantId;

    const rows = await prisma.invoiceItem.findMany({ where, orderBy: { updatedAt: 'asc' } });
    return rows;
  } catch (err) {
    prismaErrorHandler(err);
  }
}
