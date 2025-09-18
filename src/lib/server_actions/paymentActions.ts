'use server';

import { createPaymentSchema, updatePaymentSchema } from '@/utils/validators/paymentValidator';
import prisma from '@/lib/prisma';
import { prismaErrorHandler, requireAdmin, requireTenantMatch } from '@/utils/helpers/userHelpers';
import { Actor } from '@/types/userTypes';
import { PaymentMethod } from '@/app/generated/prisma';
import type { PrismaClient } from '@/app/generated/prisma/client';
import { ApiError } from '@/utils/NextApiError';
/**
 * Actor type for permission/tenant scoping checks.
 * role examples: 'USER', 'Admin', 'Super_Admin'
 */

/* ---------------- Validation Schemas ---------------- */

/* ---------------- Helper utilities ---------------- */
// function prismaErrorHandler(err: any) {
//   // Replace with structured logging in production; do not leak DB internals to clients.
//   throw new Error(err?.message ?? 'Database operation failed');
// }

// function requireActor(actor?: Actor) {
//   if (!actor) throw new Error('Authentication required for this operation.');
// }

// function requireTenantMatch(actor: Actor, tenantId: number) {
//   if (actor.tenantId !== tenantId && actor.role !== 'Super_Admin') {
//     throw new Error('Access denied: tenant mismatch.');
//   }
// }

// function requireAdmin(actor: Actor) {
//   if (!actor || (actor.role !== 'Admin' && actor.role !== 'Super_Admin')) {
//     throw new Error('Admin privileges required.');
//   }
// }

/* ---------------- Core Payment operations ---------------- */

/**
 * Create a new payment.
 * - Validates input.
 * - Prevents duplicate payment with same reference for the same tenant (idempotency helper).
 * - Ensures invoice exists and belongs to the tenant.
 * - Updates invoice status to PAID when fully paid, or to SENT when partially paid (if it was DRAFT).
 * - Returns the created payment (without mutations to unrelated fields).
 */
export async function createPayment(
  data: {
    invoiceId: number;
    reference: string;
    paidDate: Date | string;
    tenantId: string;
    date: Date | string;
    amount: number;
    method: string;
    syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
  },
  actor?: Actor
) {
  try {
    const parsed = createPaymentSchema.parse(data);

    if (actor) requireTenantMatch(actor, parsed.tenantId);

    // Ensure invoice exists and belongs to tenant
    const invoice = await prisma.invoice.findUnique({ where: { id: parsed.invoiceId } });
    if (!invoice) throw new Error('Invoice not found.');
    if (invoice.tenantId !== parsed.tenantId) {
      throw new Error('Invoice does not belong to the provided tenant.');
    }

    // Idempotency: avoid creating a payment with same reference for the tenant
    const existingRef = await prisma.payment.findFirst({
      where: { reference: parsed.reference, tenantId: parsed.tenantId },
    });
    if (existingRef) {
      // Return existing payment rather than creating duplicate
      return existingRef;
    }

    // Create payment inside transaction and update invoice status/metadata accordingly
    const result = await (prisma as unknown as PrismaClient).$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          invoiceId: parsed.invoiceId,
          reference: parsed.reference,
          date: parsed.date,
          paidDate: parsed.paidDate,
          tenantId: parsed.tenantId,
          amount: parsed.amount,
          method: parsed.method as PaymentMethod,
          syncStatus: (parsed.syncStatus ?? 'PENDING') as 'PENDING' | 'SYNCED' | 'FAILED',
        },
      });

      // Recompute total paid for invoice
      const paymentsAgg = await tx.payment.aggregate({
        where: { invoiceId: parsed.invoiceId, tenantId: parsed.tenantId },
        _sum: { amount: true },
      });
      const totalPaid = paymentsAgg._sum.amount ?? 0;
      const invoiceTotal = invoice.total ?? 0;

      // Update invoice status if needed
      const newStatus =
        +totalPaid >= +invoiceTotal && +invoiceTotal > 0
          ? 'PAID'
          : invoice.status === 'DRAFT'
          ? 'SENT'
          : invoice.status;

      await tx.invoice.update({
        where: { id: parsed.invoiceId },
        data: {
          // update status only if it changes
          ...(newStatus !== invoice.status ? { status: newStatus as any } : {}),
          // optionally update metadata fields (e.g., updatedAt by default)
        },
      });

      return payment;
    });

    return result;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Get a payment by ID.
 * - Enforces tenant scoping if actor provided.
 */
export async function getPaymentById(id: number, actor?: Actor) {
  try {
    const payment = await prisma.payment.findUnique({ where: { id } });
    if (!payment) return null;
    if (actor) requireTenantMatch(actor, payment.tenantId.toString());
    return payment;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * List payments with filters and pagination.
 * - Filters: tenantId (recommended), invoiceId, date range, min/max amount, method, syncStatus.
 * - If actor provided, default tenant is actor.tenantId and tenantId must match actor.
 */
export async function getPayments(options?: {
  tenantId: string;
  invoiceId?: number;
  page?: number;
  pageSize?: number;
  dateFrom?: Date | string;
  dateTo?: Date | string;
  minAmount?: number;
  maxAmount?: number;
  method?: string;
  syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
  actor?: Actor;
  includeCount?: boolean;
}) {
  try {
    const {
      tenantId,
      invoiceId,
      page = 1,
      pageSize = 50,
      dateFrom,
      dateTo,
      minAmount,
      maxAmount,
      method,
      syncStatus,
      actor,
      includeCount = false,
    } = options || {};

    const effectiveTenantId = actor ? actor.tenantId : tenantId;
    if (actor && tenantId && tenantId !== actor.tenantId) requireTenantMatch(actor, tenantId);

    const where: any = {};
    if (effectiveTenantId) where.tenantId = effectiveTenantId;
    if (invoiceId) where.invoiceId = invoiceId;
    if (dateFrom || dateTo) where.date = {};
    if (dateFrom) where.date.gte = typeof dateFrom === 'string' ? new Date(dateFrom) : dateFrom;
    if (dateTo) where.date.lte = typeof dateTo === 'string' ? new Date(dateTo) : dateTo;
    if (minAmount !== undefined) where.amount = { ...(where.amount ?? {}), gte: minAmount };
    if (maxAmount !== undefined) where.amount = { ...(where.amount ?? {}), lte: maxAmount };
    if (method) where.method = method;
    if (syncStatus) where.syncStatus = syncStatus;

    const payments = await prisma.payment.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { date: 'desc' },
    });

    if (includeCount) {
      const total = await prisma.payment.count({ where });
      return { payments, total, page, pageSize };
    }

    return payments;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Update a payment by ID.
 * - Validates inputs.
 * - Recalculates invoice status if amount or invoice relation changes.
 * - Only allows actor from same tenant (or Super_Admin).
 */
export async function updatePayment(
  id: number,
  data: {
    reference?: string;
    paidDate?: Date | string;
    date?: Date | string;
    amount?: number;
    method?: string;
    syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
  },
  actor?: Actor
) {
  try {
    const parsed = updatePaymentSchema.parse(data);
    const existing = await prisma.payment.findUnique({ where: { id } });
    if (!existing) throw new Error('Payment not found.');

    if (actor) requireTenantMatch(actor, existing.tenantId);

    // apply update in a transaction and recompute invoice status if amount changed
    const updated = await (prisma as unknown as PrismaClient).$transaction(async (tx) => {
      const updatedPayment = await tx.payment.update({
        where: { id },
        data: {
          ...(parsed.reference ? { reference: parsed.reference } : {}),
          ...(parsed.paidDate ? { paidDate: parsed.paidDate } : {}),
          ...(parsed.date ? { date: parsed.date } : {}),
          ...(parsed.amount !== undefined ? { amount: parsed.amount } : {}),
          ...(parsed.method ? { method: parsed.method } : {}),
          ...(parsed.syncStatus ? { syncStatus: parsed.syncStatus } : {}),
        },
      });

      // If amount changed, recalculate invoice totals and possibly invoice status
      if (parsed.amount !== undefined) {
        const invoice = await tx.invoice.findUnique({ where: { id: existing.invoiceId } });
        if (invoice) {
          const paymentsAgg = await tx.payment.aggregate({
            where: { invoiceId: invoice.id, tenantId: invoice.tenantId },
            _sum: { amount: true },
          });
          const totalPaid = Number(paymentsAgg?._sum?.amount ?? null);
          const invoiceTotal = invoice.total ?? 0;
          const newStatus =
            totalPaid >= +invoiceTotal && +invoiceTotal > 0
              ? 'PAID'
              : invoice.status === 'DRAFT'
              ? 'SENT'
              : invoice.status;

          if (newStatus !== invoice.status) {
            await tx.invoice.update({
              where: { id: invoice.id },
              data: { status: newStatus as any },
            });
          }
        }
      }

      return updatedPayment;
    });

    return updated;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Delete a payment by ID.
 * - Only tenant Admin or Super_Admin may delete.
 * - Recomputes invoice totals/status after deletion.
 * - Consider soft-delete in future; this is permanent delete.
 */
export async function deletePayment(id: number, actor?: Actor) {
  try {
    const existing = await prisma.payment.findUnique({ where: { id } });
    if (!existing) throw new Error('Payment not found.');
    if (actor) {
      requireTenantMatch(actor, existing.tenantId);
      requireAdmin(actor);
    }

    const result = await (prisma as unknown as PrismaClient).$transaction(async (tx) => {
      const deleted = await tx.payment.delete({ where: { id } });

      // Recompute invoice totals and status
      const invoice = await tx.invoice.findUnique({ where: { id: deleted.invoiceId } });
      if (invoice) {
        const paymentsAgg = await tx.payment.aggregate({
          where: { invoiceId: invoice.id, tenantId: invoice.tenantId },
          _sum: { amount: true },
        });
        const totalPaid = +(paymentsAgg._sum.amount ?? 0);
        const invoiceTotal = +(invoice.total ?? 0);
        const newStatus =
          totalPaid >= invoiceTotal && invoiceTotal > 0
            ? 'PAID'
            : invoice.status === 'DRAFT'
            ? 'DRAFT'
            : 'SENT';
        if (newStatus !== invoice.status) {
          await tx.invoice.update({
            where: { id: invoice.id },
            data: { status: newStatus as any },
          });
        }
      }

      return deleted;
    });

    return result;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/* ---------------- Sync & utility helpers ---------------- */

/**
 * Get unsynced payments for client sync engine.
 */
export async function getUnsyncedPayments(tenantId: string, limit = 200, actor?: Actor) {
  try {
    if (actor) requireTenantMatch(actor, tenantId);

    const payments = await prisma.payment.findMany({
      where: { tenantId, syncStatus: 'PENDING' },
      take: limit,
      orderBy: { updatedAt: 'asc' },
    });

    return payments;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Mark payments as synced (bulk).
 */
export async function markPaymentsAsSynced(ids: number[], actor?: Actor) {
  try {
    if (!ids || ids.length === 0) return { count: 0 };
    if (actor) {
      const countDifferentTenant = await prisma.payment.count({
        where: { id: { in: ids }, tenantId: { not: actor.tenantId } },
      });
      if (countDifferentTenant > 0)
        throw new Error('Attempt to mark payments outside your tenant.');
    }

    const res = await prisma.payment.updateMany({
      where: { id: { in: ids } },
      data: { syncStatus: 'SYNCED' },
    });

    return { count: res.count };
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Apply remote payments to server (used when a device pushes changes).
 * - Basic conflict strategy: create missing records; for existing ones compare updatedAt.
 * - Actor (if provided) is used to validate tenant boundaries.
 */
export async function applyRemotePayments(
  remotePayments: Array<
    Partial<{
      id: number;
      invoiceId: number;
      reference: string;
      date: string | Date;
      paidDate: string | Date;
      tenantId: string;
      amount: number;
      method: PaymentMethod;
      updatedAt: string | Date;
      syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
    }>
  >,
  actor?: Actor
) {
  if (!remotePayments || remotePayments.length === 0) return { applied: 0 };

  const chunkSize = 25;
  let applied = 0;

  try {
    for (let i = 0; i < remotePayments.length; i += chunkSize) {
      const chunk = remotePayments.slice(i, i + chunkSize);

      // Tenant boundary checks
      if (actor) {
        const mismatch = chunk.some(
          (p) => typeof p.tenantId === 'number' && p.tenantId !== actor.tenantId
        );
        if (mismatch) throw new Error('Tenant mismatch in remote payload.');
      }

      for (const rp of chunk) {
        if (!rp.tenantId) {
          if (actor) rp.tenantId = actor.tenantId;
          else throw new Error('tenantId missing from remote payment payload.');
        }

        // If reference exists for tenant, use it to dedupe
        if (rp.reference) {
          const existing = await prisma.payment.findFirst({
            where: { reference: rp.reference, tenantId: rp.tenantId },
          });
          if (existing) {
            // compare updatedAt to decide
            const remoteUpdated = rp.updatedAt ? new Date(rp.updatedAt).getTime() : 0;
            const localUpdated = (existing.updatedAt ?? existing.createdAt).getTime();
            if (remoteUpdated > localUpdated) {
              await prisma.payment.update({
                where: { id: existing.id },
                data: {
                  date: rp.date ? new Date(rp.date) : existing.date,
                  paidDate: rp.paidDate ? new Date(rp.paidDate) : existing.paidDate,
                  amount: rp.amount ?? existing.amount,
                  method: rp.method ?? existing.method,
                  syncStatus: rp.syncStatus ?? existing.syncStatus,
                },
              });
              applied++;
            }
            continue;
          }
        }

        // If invoiceId provided, ensure invoice exists & belongs to tenant
        if (rp.invoiceId) {
          const invoice = await prisma.invoice.findUnique({ where: { id: rp.invoiceId } });
          if (!invoice) {
            // skip or create a stub? Here we skip to avoid FK violation.
            continue;
          }
          if (invoice.tenantId !== rp.tenantId) continue;
        }

        // Create new payment
        if (!rp.invoiceId)
          throw new ApiError(400, 'invoiceId is required when creating a payment.');

        if (!rp.method) throw new ApiError(400, 'method is required when creating a payment.');

        await prisma.payment.create({
          data: {
            invoiceId: rp.invoiceId,
            reference: rp.reference ?? `remote-${Date.now()}`,
            date: rp.date ? new Date(rp.date) : new Date(),
            paidDate: rp.paidDate ? new Date(rp.paidDate) : new Date(),
            tenantId: rp.tenantId,
            amount: rp.amount ?? 0,
            method: rp.method,
            syncStatus: rp.syncStatus ?? 'SYNCED',
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
 * Get payments updated since timestamp (for server->client sync).
 */
export async function getPaymentsUpdatedSince(
  since: Date,
  options?: { tenantId?: number; actor?: Actor }
) {
  try {
    const { tenantId, actor } = options || {};
    const where: any = { updatedAt: { gt: since } };
    if (actor && actor.role !== 'Super_Admin') {
      where.tenantId = actor.tenantId;
    } else if (tenantId) {
      where.tenantId = tenantId;
    }

    const payments = await prisma.payment.findMany({ where, orderBy: { updatedAt: 'asc' } });
    return payments;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/* ---------------- Reporting helpers ---------------- */

/**
 * Get payment aggregates by method for a tenant (dashboard).
 */
export async function getPaymentAggregatesByMethod(tenantId: string, actor?: Actor) {
  try {
    if (actor) requireTenantMatch(actor, tenantId);

    // Get all payments for the tenant first
    const payments = await prisma.payment.findMany({
      where: { tenantId },
      select: { method: true, amount: true },
    });

    // Group manually by method
    const grouped = payments.reduce((acc, payment) => {
      const method = payment.method;
      if (!acc[method]) {
        acc[method] = { total: 0, count: 0 };
      }
      acc[method].total += +payment.amount;
      acc[method].count += 1;
      return acc;
    }, {} as Record<string, { total: number; count: number }>);

    return Object.entries(grouped).map(([method, data]) => ({
      method,
      total: data.total,
      count: data.count,
    }));
  } catch (err) {
    prismaErrorHandler(err);
    return [];
  }
}

/**
 * Export payments for a tenant (date range) for reconciliation / backup.
 */
export async function exportPaymentsForTenant(
  tenantId: string,
  options?: { dateFrom?: Date | string; dateTo?: Date | string; actor?: Actor }
) {
  try {
    const { dateFrom, dateTo, actor } = options || {};
    if (actor) requireTenantMatch(actor, tenantId);

    const where: any = { tenantId };
    if (dateFrom || dateTo) where.date = {};
    if (dateFrom) where.date.gte = typeof dateFrom === 'string' ? new Date(dateFrom) : dateFrom;
    if (dateTo) where.date.lte = typeof dateTo === 'string' ? new Date(dateTo) : dateTo;

    const payments = await prisma.payment.findMany({ where, orderBy: { date: 'asc' } });
    return { tenantId, count: payments.length, payments, exportedAt: new Date().toISOString() };
  } catch (err) {
    prismaErrorHandler(err);
  }
}
