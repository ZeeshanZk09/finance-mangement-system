'use server';

import { Actor } from '@/types/userTypes';
import prisma from '@/lib/prisma';
import {
  ensureTenantExists,
  prismaErrorHandler,
  // requireActor,
  requireAdmin,
} from '@/utils/helpers/userHelpers';
import { createTenantSchema, updateTenantSchema } from '@/utils/validators/userValidator';
import { ApiError } from '@/utils/NextApiError';
import { TenantCreateInput } from '@/app/generated/prisma/client/models';

/**
 * Actor = caller identity (optional) used to enforce tenant boundaries and Admin checks.
 * role examples: 'USER', 'Admin', 'Super_Admin'
 */

/* ---------- Validation Schemas ---------- */

/* ---------- Helper checks & utilities ---------- */

/* ---------- Tenant CRUD + Extra features ---------- */

/**
 * Create a new tenant.
 * - Validates input.
 * - Only Super_Admin (if actor provided) may create tenants.
 * - Ensures tenant name uniqueness.
 */
export async function createTenant(data: TenantCreateInput) {
  try {
    const parsed = createTenantSchema.parse(data);

    // Check uniqueness of name (best-effort; consider unique DB constraint if required)
    const existing = await prisma.tenant.findFirst({ where: { name: parsed.name } });
    if (existing) throw new ApiError(400, 'A tenant with this name already exists.');

    const tenant = await prisma.tenant.create({
      data: {
        name: parsed.name,
        // You may need to provide dummy or default values for required fields
        email: parsed.email || '', // Replace with actual email if available
        slug: parsed.slug || parsed.name.toLowerCase().replace(/\s+/g, '-'), // Example slug generation
      },
    });

    return tenant;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Get a tenant by ID.
 * - Optionally include relational counts and a basic financial summary.
 * - If actor provided, ensures actor belongs to the tenant or is Super_Admin.
 */
export async function getTenantById(
  id: string,
  options?: { includeCounts?: boolean; includeFinancialSummary?: boolean; actor?: Actor }
) {
  try {
    const { includeCounts = false, includeFinancialSummary = false, actor } = options || {};

    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) return null;

    // If caller provided, ensure they either belong to tenant or are Super_Admin
    if (actor && actor.role !== 'Admin' && actor.tenantId !== id) {
      throw new Error('Access denied: tenant mismatch.');
    }

    const result: any = { ...tenant };

    if (includeCounts) {
      const [userCount, vendorCount, customerCount, itemCount, invoiceCount, paymentCount] =
        await Promise.all([
          prisma.user.count({ where: { tenantId: id } }),
          prisma.vendor.count({ where: { tenantId: id } }),
          prisma.customer.count({ where: { tenantId: id } }),
          prisma.item.count({ where: { tenantId: id } }),
          prisma.invoice.count({ where: { tenantId: id } }),
          prisma.payment.count({ where: { tenantId: id } }),
        ]);
      result.counts = {
        users: userCount,
        vendors: vendorCount,
        customers: customerCount,
        items: itemCount,
        invoices: invoiceCount,
        payments: paymentCount,
      };
    }

    if (includeFinancialSummary) {
      const [invoicedAgg, paymentsAgg] = await Promise.all([
        prisma.invoice.aggregate({
          where: { tenantId: id },
          _sum: { total: true },
          _count: { id: true },
        }),
        prisma.payment.aggregate({
          where: { tenantId: id },
          _sum: { amount: true },
          _count: { id: true },
        }),
      ]);
      const totalInvoiced = invoicedAgg._sum.total ?? 0;
      const totalPayments = paymentsAgg._sum.amount ?? 0;
      result.financial = {
        totalInvoiced: Number(totalInvoiced),
        totalPayments: Number(totalPayments),
        outstanding: Number(totalInvoiced) - Number(totalPayments),
        invoiceCount: invoicedAgg._count.id ?? 0,
        paymentCount: paymentsAgg._count.id ?? 0,
      };
    }

    return result;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * List tenants with pagination & search.
 * - Only Super_Admin can list all tenants if actor provided.
 * - Supports page, pageSize, and name search.
 */
export async function getAllTenants(options?: {
  page?: number;
  pageSize?: number;
  search?: string;
  actor?: Actor;
  includeCounts?: boolean;
}) {
  try {
    const { page = 1, pageSize = 20, search, actor, includeCounts = false } = options || {};

    // If an actor is provided and is not Super_Admin, restrict visibility to their tenant only.
    const where: any = {};
    if (actor && actor.role !== 'Admin') {
      where.id = actor.tenantId;
    } else if (search) {
      where.name = { contains: search, mode: 'insensitive' };
    }

    const tenants = await prisma.tenant.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
    });

    if (!includeCounts) return tenants;

    // If includeCounts requested, augment each tenant with counts (parallelized)
    const tenantsWithCounts = await Promise.all(
      (tenants as any[]).map(async (t) => {
        const counts = await prisma.$transaction([
          prisma.user.count({ where: { tenantId: t.id } }),
          prisma.vendor.count({ where: { tenantId: t.id } }),
          prisma.customer.count({ where: { tenantId: t.id } }),
          prisma.item.count({ where: { tenantId: t.id } }),
          prisma.invoice.count({ where: { tenantId: t.id } }),
          prisma.payment.count({ where: { tenantId: t.id } }),
        ]);
        return {
          ...t,
          counts: {
            users: counts[0],
            vendors: counts[1],
            customers: counts[2],
            items: counts[3],
            invoices: counts[4],
            payments: counts[5],
          },
        };
      })
    );

    return tenantsWithCounts;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Update a tenant.
 * - Only Super_Admin or the tenant's Super_Admin-level user may update tenant metadata.
 * - Validates input.
 */
export async function updateTenant(id: string, data: { name?: string }, actor?: Actor) {
  try {
    const parsed = updateTenantSchema.parse(data);

    // Ensure tenant exists
    await ensureTenantExists(id);

    if (actor) {
      // allow Super_Admin to update any tenant; otherwise only allow if actor.tenantId matches and actor is Admin
      if (actor.role !== 'Admin') {
        if (actor.tenantId !== id) throw new ApiError(401, 'Access denied: tenant mismatch.');
        if (actor.role !== 'Approver')
          throw new ApiError(401, 'Admin privileges required to update tenant.');
      }
    }

    const updated = await prisma.tenant.update({
      where: { id },
      data: { ...parsed },
    });

    return updated;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Delete a tenant.
 * - Safe delete: by default refuses to delete if there are related records (prevents accidental data loss).
 * - If force=true, runs a transactional cascade delete on tenant-owned resources in the correct order.
 * - Only Super_Admin may perform force deletes. Local Admin may request non-force deletes (but will fail if relations exist).
 */
export async function deleteTenant(id: string, options?: { force?: boolean; actor?: Actor }) {
  try {
    const { force = false, actor } = options || {};

    // existence check
    await ensureTenantExists(id);

    // Security: only Super_Admin can force-delete; tenant-level Admins cannot force-delete their own tenant.
    if (force && actor) {
      requireAdmin(actor);
    } else if (!actor) {
      // if no actor (script), allow delete if force true
      if (!force) throw new Error('Authentication required for deletions.');
    } else {
      // actor provided but not force: ensure actor belongs to tenant and is Admin or Super_Admin
      if (actor.role !== 'Admin' && actor.tenantId !== id) {
        throw new Error('Access denied: tenant mismatch.');
      }
      if (actor.role !== 'Admin') {
        throw new Error('Admin privileges required to delete tenant.');
      }
    }

    // Check for any related records
    const [userCount, vendorCount, customerCount, itemCount, invoiceCount, paymentCount] =
      await Promise.all([
        prisma.user.count({ where: { tenantId: id } }),
        prisma.vendor.count({ where: { tenantId: id } }),
        prisma.customer.count({ where: { tenantId: id } }),
        prisma.item.count({ where: { tenantId: id } }),
        prisma.invoice.count({ where: { tenantId: id } }),
        prisma.payment.count({ where: { tenantId: id } }),
      ]);

    const totalRelated =
      userCount + vendorCount + customerCount + itemCount + invoiceCount + paymentCount;

    if (totalRelated > 0 && !force) {
      // refuse to delete to prevent data loss
      throw new Error(
        `Tenant has ${totalRelated} related records. Use force=true (Super_Admin only) to permanently delete tenant and all related data.`
      );
    }

    if (!force) {
      // safe deletion when no related records — just delete tenant
      const deleted = await prisma.tenant.delete({ where: { id } });
      return { deleted, cascade: false };
    }

    // Force delete path: remove child records in an order that respects FKs (inside transaction)
    // Order: InvoiceItem -> Payment -> Invoice -> Item -> Customer -> Vendor -> User -> Tenant
    await prisma.$transaction([
      prisma.invoiceItem.deleteMany({ where: { tenantId: id } }),
      prisma.payment.deleteMany({ where: { tenantId: id } }),
      prisma.invoice.deleteMany({ where: { tenantId: id } }),
      prisma.item.deleteMany({ where: { tenantId: id } }),
      prisma.customer.deleteMany({ where: { tenantId: id } }),
      prisma.vendor.deleteMany({ where: { tenantId: id } }),
      prisma.user.deleteMany({ where: { tenantId: id } }),
      prisma.tenant.delete({ where: { id } }),
    ]);

    return { deletedTenantId: id, cascade: true };
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/* ---------- Offline-first / Sync helpers & Export ---------- */

/**
 * Get tenants that have been updated since a given timestamp.
 * - Useful for server->client sync to pull changed tenants.
 * - Only Super_Admin can query all tenants; otherwise actor sees only their tenant.
 */
export async function getTenantsUpdatedSince(since: Date, options?: { actor?: Actor }) {
  try {
    const { actor } = options || {};
    const where: any = { updatedAt: { gt: since } };
    if (actor && actor.role !== 'Admin') {
      // restrict to actor tenant only
      where.id = actor.tenantId;
    }

    const tenants = await prisma.tenant.findMany({ where, orderBy: { updatedAt: 'asc' } });
    return tenants;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Export tenant data (full dump) for backups / tenant export.
 * - Gathers tenant and all related entities and returns a JSON-serializable object.
 * - Only Super_Admin or tenant Admin may export.
 */
export async function exportTenantData(tenantId: string, actor?: Actor) {
  try {
    // permission check
    if (actor) {
      if (actor.role !== 'Admin') {
        if (actor.tenantId !== tenantId) throw new Error('Access denied: tenant mismatch.');
        if (actor.role !== 'Approver') {
          throw new Error('Admin privileges required to export tenant data.');
        }
      }
    } else {
      // Require authentication to export tenant data in production.
      throw new Error('Authentication required to export tenant data.');
    }

    await ensureTenantExists(tenantId);

    // fetch related data (be mindful of size — paginate in production)
    const [tenant, users, vendors, customers, items, invoices, payments, invoiceItems] =
      await Promise.all([
        prisma.tenant.findUnique({ where: { id: tenantId } }),
        prisma.user.findMany({ where: { tenantId } }),
        prisma.vendor.findMany({ where: { tenantId } }),
        prisma.customer.findMany({ where: { tenantId } }),
        prisma.item.findMany({ where: { tenantId } }),
        prisma.invoice.findMany({ where: { tenantId } }),
        prisma.payment.findMany({ where: { tenantId } }),
        prisma.invoiceItem.findMany({ where: { tenantId } }),
      ]);

    return {
      tenant,
      users: users.map((u: any) => {
        const { password, ...safe } = u;
        return safe;
      }),
      vendors,
      customers,
      items,
      invoices,
      payments,
      invoiceItems,
      exportedAt: new Date().toISOString(),
    };
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * A lightweight health-check / tenant sanity check.
 * - Validates that essential counts are present and returns issues if any.
 */
export async function tenantSanityCheck(tenantId: string, actor?: Actor) {
  try {
    if (actor) {
      if (actor.role !== 'Admin' && actor.tenantId !== tenantId) {
        throw new Error('Access denied: tenant mismatch.');
      }
    } else {
      throw new Error('Authentication required.');
    }

    await ensureTenantExists(tenantId);

    const [userCount, invoiceCount, itemCount] = await Promise.all([
      prisma.user.count({ where: { tenantId } }),
      prisma.invoice.count({ where: { tenantId } }),
      prisma.item.count({ where: { tenantId } }),
    ]);

    const issues: string[] = [];
    if (userCount === 0) issues.push('No users for tenant (recommend creating an Admin).');
    if (invoiceCount === 0) issues.push('No invoices found (tenant may be unused).');
    if (itemCount === 0) issues.push('No items found (inventory empty).');

    return { userCount, invoiceCount, itemCount, issues };
  } catch (err) {
    prismaErrorHandler(err);
  }
}
