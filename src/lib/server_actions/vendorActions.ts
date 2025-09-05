'use server';

import { Actor } from '@/types/userTypes';
import prisma from '../prisma';
import { createVendorSchema, updateVendorSchema } from '@/utils/vendorValidator';
import {
  ensureTenantExists,
  prismaErrorHandler,
  requireAdmin,
  requireTenantMatch,
} from '@/utils/userHelper';

/**
 * Actor = calling user identity (optional). Used for tenant scoping and role checks.
 * Example roles: 'USER' | 'Admin' | 'Super_Admin'
 */
/* ---------------- Validation Schemas ---------------- */

/* ---------------- Helper Utilities ---------------- */

/* ---------------- Core Vendor Operations ---------------- */

/**
 * Create a new vendor.
 * - Validates input.
 * - Enforces tenant scoping if actor provided.
 * - Prevents accidental duplicates by checking (name + phone/email) for the tenant.
 */
export async function createVendor(
  data: {
    tenantId: number;
    name: string;
    email?: string;
    phone?: string;
    address?: string;
    taxId?: string;
    syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
  },
  actor?: Actor
) {
  try {
    const parsed = createVendorSchema.parse(data);

    if (actor) requireTenantMatch(actor, parsed.tenantId);

    await ensureTenantExists(parsed.tenantId);

    // Simple dedupe: same name + phone or same email within tenant
    if (parsed.email) {
      const byEmail = await prisma.vendor.findFirst({
        where: { tenantId: parsed.tenantId, email: parsed.email },
      });
      if (byEmail) return byEmail;
    }
    if (parsed.phone) {
      const byPhone = await prisma.vendor.findFirst({
        where: { tenantId: parsed.tenantId, phone: parsed.phone },
      });
      if (byPhone) return byPhone;
    }

    const vendor = await prisma.vendor.create({
      data: {
        tenantId: parsed.tenantId,
        name: parsed.name,
        email: parsed.email ?? null,
        phone: parsed.phone ?? null,
        address: parsed.address ?? null,
        taxId: parsed.taxId ?? null,
        syncStatus: parsed.syncStatus ?? 'PENDING',
      },
    });

    return vendor;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Get vendor by id.
 * - Enforces tenant scoping when actor provided.
 */
export async function getVendorById(id: number, actor?: Actor) {
  try {
    const vendor = await prisma.vendor.findUnique({ where: { id } });
    if (!vendor) return null;
    if (actor) requireTenantMatch(actor, vendor.tenantId);
    return vendor;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * List vendors with pagination, search and filters.
 * - By default, scoped to actor.tenantId when actor present.
 * - Supports search on name/email/phone and optional includeCount.
 */
export async function getVendors(options?: {
  tenantId?: number;
  page?: number;
  pageSize?: number;
  search?: string;
  includeCount?: boolean;
  actor?: Actor;
}) {
  try {
    const {
      tenantId,
      page = 1,
      pageSize = 25,
      search,
      includeCount = false,
      actor,
    } = options || {};

    const effectiveTenantId = actor ? actor.tenantId : tenantId;
    if (actor && typeof tenantId === 'number') requireTenantMatch(actor, tenantId);

    const where: any = {};
    if (effectiveTenantId) where.tenantId = effectiveTenantId;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }

    const vendors = await prisma.vendor.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { updatedAt: 'desc' },
    });

    if (includeCount) {
      const total = await prisma.vendor.count({ where });
      return { vendors, total, page, pageSize };
    }

    return vendors;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Update vendor by id.
 * - Validates input.
 * - Enforces tenant and Admin scoping when actor provided for sensitive changes.
 * - Optionally sets syncStatus.
 */
export async function updateVendor(
  id: number,
  data: {
    name?: string;
    email?: string;
    phone?: string;
    address?: string;
    taxId?: string;
    syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
  },
  actor?: Actor
) {
  try {
    const parsed = updateVendorSchema.parse(data);
    const existing = await prisma.vendor.findUnique({ where: { id } });
    if (!existing) throw new Error('Vendor not found.');

    if (actor) requireTenantMatch(actor, existing.tenantId);

    // If changing email/phone ensure not creating a dup within tenant
    if (parsed.email && parsed.email !== existing.email) {
      const conflict = await prisma.vendor.findFirst({
        where: { tenantId: existing.tenantId, email: parsed.email, id: { not: id } },
      });
      if (conflict) throw new Error('Another vendor with this email exists for this tenant.');
    }
    if (parsed.phone && parsed.phone !== existing.phone) {
      const conflict = await prisma.vendor.findFirst({
        where: { tenantId: existing.tenantId, phone: parsed.phone, id: { not: id } },
      });
      if (conflict) throw new Error('Another vendor with this phone exists for this tenant.');
    }

    // Only Admins may change taxId or syncStatus (enforce more strict control for sensitive fields)
    if ((parsed.taxId || parsed.syncStatus) && actor) {
      requireAdmin(actor);
    }

    const updated = await prisma.vendor.update({
      where: { id },
      data: {
        ...(parsed.name ? { name: parsed.name } : {}),
        ...(parsed.email ? { email: parsed.email } : {}),
        ...(parsed.phone ? { phone: parsed.phone } : {}),
        ...(parsed.address ? { address: parsed.address } : {}),
        ...(parsed.taxId ? { taxId: parsed.taxId } : {}),
        ...(parsed.syncStatus ? { syncStatus: parsed.syncStatus } : {}),
      },
    });

    return updated;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Delete vendor by id.
 * - If vendor has related records (invoices/purchase bills) refuse unless force=true and actor is Super_Admin.
 * - Prefer soft-delete pattern if you add `isActive`/`deletedAt` to schema.
 */
export async function deleteVendor(id: number, options?: { force?: boolean; actor?: Actor }) {
  try {
    const { force = false, actor } = options || {};
    const existing = await prisma.vendor.findUnique({ where: { id } });
    if (!existing) throw new Error('Vendor not found.');

    if (actor) requireTenantMatch(actor, existing.tenantId);

    // Check related records. Schema currently doesn't have explicit bills but be defensive.
    const relatedCounts = await Promise.all([
      prisma.invoice.count({ where: { tenantId: existing.tenantId /* , vendorId: id */ } }), // placeholder if vendor linked later
      // add other checks (purchaseOrders, bills) when schema has them
    ]);
    const totalRelated = relatedCounts.reduce((s, v) => s + v, 0);

    if (totalRelated > 0 && !force) {
      throw new Error(
        `Vendor has related records (${totalRelated}). Use force=true (Super_Admin only) to permanently delete.`
      );
    }

    if (force) {
      if (!actor) throw new Error('Authentication required for force delete.');
      if (actor.role !== 'Super_Admin')
        throw new Error('Only Super_Admin may force delete vendors.');
    } else {
      if (actor) requireAdmin(actor);
    }

    // permanent delete — wrap in transaction in case of cascading cleanup
    const deleted = await prisma.$transaction([prisma.vendor.delete({ where: { id } })]);
    return { deleted: deleted[0], cascade: force };
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/* ---------------- Sync helpers & bulk operations ---------------- */

/**
 * Get unsynced vendors for a tenant (client sync engine).
 */
export async function getUnsyncedVendors(tenantId: number, limit = 200, actor?: Actor) {
  try {
    if (actor) requireTenantMatch(actor, tenantId);

    const vendors = await prisma.vendor.findMany({
      where: { tenantId, syncStatus: 'PENDING' },
      take: limit,
      orderBy: { updatedAt: 'asc' },
    });

    return vendors;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Mark vendors as synced (bulk operation).
 */
export async function markVendorsAsSynced(ids: number[], actor?: Actor) {
  try {
    if (!ids || ids.length === 0) return { count: 0 };
    if (actor) {
      const countDifferentTenant = await prisma.vendor.count({
        where: { id: { in: ids }, tenantId: { not: actor.tenantId } },
      });
      if (countDifferentTenant > 0) throw new Error('Attempt to mark vendors outside your tenant.');
    }

    const res = await prisma.vendor.updateMany({
      where: { id: { in: ids } },
      data: { syncStatus: 'SYNCED' },
    });

    return { count: res.count };
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Apply remote vendor payloads (device -> server sync).
 * - Basic conflict strategy: if vendor exists (by id or dedupe keys) compare updatedAt, update if remote newer.
 * - Actor used to validate tenant boundaries.
 */
export async function applyRemoteVendors(
  remoteVendors: Array<
    Partial<{
      id: number;
      tenantId: number;
      name: string;
      email: string;
      phone: string;
      address: string;
      taxId: string;
      updatedAt: string | Date;
      syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
    }>
  >,
  actor?: Actor
) {
  if (!remoteVendors || remoteVendors.length === 0) return { applied: 0 };

  const chunkSize = 25;
  let applied = 0;

  try {
    for (let i = 0; i < remoteVendors.length; i += chunkSize) {
      const chunk = remoteVendors.slice(i, i + chunkSize);

      // tenant boundary checks
      if (actor) {
        const mismatch = chunk.some(
          (v) => typeof v.tenantId === 'number' && v.tenantId !== actor.tenantId
        );
        if (mismatch) throw new Error('Tenant mismatch in remote payload.');
      }

      for (const rv of chunk) {
        if (!rv.tenantId) {
          if (actor) rv.tenantId = actor.tenantId;
          else throw new Error('tenantId missing in remote vendor payload.');
        }

        // If id present try to find local by id
        if (typeof rv.id === 'number') {
          const local = await prisma.vendor.findUnique({ where: { id: rv.id } });
          if (!local) {
            // create new vendor (id cannot be set due to autoincrement)
            await prisma.vendor.create({
              data: {
                tenantId: rv.tenantId,
                name: rv.name ?? `remote-${Date.now()}`,
                email: rv.email ?? null,
                phone: rv.phone ?? null,
                address: rv.address ?? null,
                taxId: rv.taxId ?? null,
                syncStatus: rv.syncStatus ?? 'SYNCED',
              },
            });
            applied++;
            continue;
          }

          // conflict resolution by updatedAt
          const remoteUpdated = rv.updatedAt ? new Date(rv.updatedAt).getTime() : 0;
          const localUpdated = (local.updatedAt ?? local.createdAt).getTime();
          if (remoteUpdated > localUpdated) {
            await prisma.vendor.update({
              where: { id: local.id },
              data: {
                name: rv.name ?? local.name,
                email: rv.email ?? local.email,
                phone: rv.phone ?? local.phone,
                address: rv.address ?? local.address,
                taxId: rv.taxId ?? local.taxId,
                syncStatus: rv.syncStatus ?? local.syncStatus,
              },
            });
            applied++;
          }
          continue;
        }

        // No id: try to dedupe by email or phone within tenant
        if (rv.email) {
          const exists = await prisma.vendor.findFirst({
            where: { tenantId: rv.tenantId, email: rv.email },
          });
          if (exists) {
            const remoteUpdated = rv.updatedAt ? new Date(rv.updatedAt).getTime() : 0;
            const localUpdated = (exists.updatedAt ?? exists.createdAt).getTime();
            if (remoteUpdated > localUpdated) {
              await prisma.vendor.update({
                where: { id: exists.id },
                data: {
                  name: rv.name ?? exists.name,
                  phone: rv.phone ?? exists.phone,
                  address: rv.address ?? exists.address,
                  taxId: rv.taxId ?? exists.taxId,
                  syncStatus: rv.syncStatus ?? exists.syncStatus,
                },
              });
              applied++;
            }
            continue;
          }
        }

        if (rv.phone) {
          const exists = await prisma.vendor.findFirst({
            where: { tenantId: rv.tenantId, phone: rv.phone },
          });
          if (exists) {
            const remoteUpdated = rv.updatedAt ? new Date(rv.updatedAt).getTime() : 0;
            const localUpdated = (exists.updatedAt ?? exists.createdAt).getTime();
            if (remoteUpdated > localUpdated) {
              await prisma.vendor.update({
                where: { id: exists.id },
                data: {
                  name: rv.name ?? exists.name,
                  email: rv.email ?? exists.email,
                  address: rv.address ?? exists.address,
                  taxId: rv.taxId ?? exists.taxId,
                  syncStatus: rv.syncStatus ?? exists.syncStatus,
                },
              });
              applied++;
            }
            continue;
          }
        }

        // create new vendor
        await prisma.vendor.create({
          data: {
            tenantId: rv.tenantId,
            name: rv.name ?? `remote-${Date.now()}`,
            email: rv.email ?? null,
            phone: rv.phone ?? null,
            address: rv.address ?? null,
            taxId: rv.taxId ?? null,
            syncStatus: rv.syncStatus ?? 'SYNCED',
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
 * Get vendors updated since a timestamp (server -> client sync).
 */
export async function getVendorsUpdatedSince(
  since: Date,
  options?: { tenantId?: number; actor?: Actor }
) {
  try {
    const { tenantId, actor } = options || {};
    const where: any = { updatedAt: { gt: since } };
    if (actor && actor.role !== 'Super_Admin') where.tenantId = actor.tenantId;
    else if (tenantId) where.tenantId = tenantId;

    const vendors = await prisma.vendor.findMany({ where, orderBy: { updatedAt: 'asc' } });
    return vendors;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/* ---------------- Reporting & Export ---------------- */

/**
 * Export vendors for a tenant (optional filters).
 */
export async function exportVendorsForTenant(
  tenantId: number,
  options?: { actor?: Actor; search?: string }
) {
  try {
    const { actor, search } = options || {};
    if (actor) requireTenantMatch(actor, tenantId);

    const where: any = { tenantId };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }

    const vendors = await prisma.vendor.findMany({ where, orderBy: { name: 'asc' } });
    return { tenantId, count: vendors.length, vendors, exportedAt: new Date().toISOString() };
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Simple tenant-level vendor sanity check (useful for health dashboards).
 */
export async function vendorSanityCheck(tenantId: number, actor?: Actor) {
  try {
    if (actor) requireTenantMatch(actor, tenantId);

    await ensureTenantExists(tenantId);

    const [vendorCount] = await Promise.all([prisma.vendor.count({ where: { tenantId } })]);

    const issues: string[] = [];
    if (vendorCount === 0) issues.push('No vendors found for tenant.');

    return { vendorCount, issues };
  } catch (err) {
    prismaErrorHandler(err);
  }
}
