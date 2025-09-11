'use server';

import { Actor } from '@/types/userTypes';
import prisma from '../prisma';
import { z } from 'zod';
import { createCustomerSchema, updateCustomerSchema } from '@/utils/validators/customerValidator';
import {
  ensureTenantExists,
  prismaErrorHandler,
  requireAdmin,
  requireTenantMatch,
} from '@/utils/helpers/userHelper';

/**
 * Actor type for permission/tenant scoping and role checks.
 * Example roles: 'USER' | 'Admin' | 'Super_Admin'
 */

/* ---------------- Validation Schemas ---------------- */

/* ---------------- Helpers & Guards ---------------- */

/* ---------------- Core Customer operations ---------------- */

/**
 * Create a new customer.
 * - Validates input.
 * - Enforces tenant scoping if actor provided.
 * - Attempts to dedupe by email or phone within the tenant.
 */
export async function createCustomer(
  data: {
    tenantId: number;
    name: string;
    email?: string;
    phone?: string;
    address?: string;
    syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
  },
  actor?: Actor
) {
  try {
    const parsed = createCustomerSchema.parse(data);

    if (actor) requireTenantMatch(actor, parsed.tenantId);

    await ensureTenantExists(parsed.tenantId);

    // dedupe by email or phone within tenant
    if (parsed.email) {
      const existingByEmail = await prisma.customer.findFirst({
        where: { tenantId: parsed.tenantId, email: parsed.email },
      });
      if (existingByEmail) return existingByEmail;
    }

    if (parsed.phone) {
      const existingByPhone = await prisma.customer.findFirst({
        where: { tenantId: parsed.tenantId, phone: parsed.phone },
      });
      if (existingByPhone) return existingByPhone;
    }

    const customer = await prisma.customer.create({
      data: {
        tenantId: parsed.tenantId,
        name: parsed.name,
        email: parsed.email ?? null,
        phone: parsed.phone ?? null,
        address: parsed.address ?? null,
        syncStatus: parsed.syncStatus ?? 'PENDING',
      },
    });

    return customer;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Get a customer by id (tenant-scoped when actor provided).
 */
export async function getCustomerById(id: number, actor?: Actor) {
  try {
    const customer = await prisma.customer.findUnique({ where: { id } });
    if (!customer) return null;
    if (actor) requireTenantMatch(actor, customer.tenantId);
    return customer;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * List customers with pagination, search and optional counts.
 * - Defaults to actor.tenantId when actor provided.
 */
export async function getCustomers(options?: {
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
    if (!effectiveTenantId) throw new Error('tenantId required.');

    if (actor && typeof tenantId === 'number' && tenantId !== actor.tenantId)
      requireTenantMatch(actor, tenantId);

    const where: any = { tenantId: effectiveTenantId };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }

    const customers = await prisma.customer.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { updatedAt: 'desc' },
    });

    if (includeCount) {
      const total = await prisma.customer.count({ where });
      return { customers, total, page, pageSize };
    }

    return customers;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Update a customer.
 * - Validates input.
 * - Enforces tenant scoping.
 * - Ensures email uniqueness within tenant when changing email.
 */
export async function updateCustomer(
  id: number,
  data: {
    name?: string;
    email?: string;
    phone?: string;
    address?: string;
    syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
  },
  actor?: Actor
) {
  try {
    const parsed = updateCustomerSchema.parse(data);
    const existing = await prisma.customer.findUnique({ where: { id } });
    if (!existing) throw new Error('Customer not found.');

    if (actor) requireTenantMatch(actor, existing.tenantId);

    if (parsed.email && parsed.email !== existing.email) {
      const conflict = await prisma.customer.findFirst({
        where: { tenantId: existing.tenantId, email: parsed.email, id: { not: id } },
      });
      if (conflict) throw new Error('Another customer with this email exists for the tenant.');
    }

    const updated = await prisma.customer.update({
      where: { id },
      data: {
        ...(parsed.name ? { name: parsed.name } : {}),
        ...(parsed.email !== undefined ? { email: parsed.email ?? null } : {}),
        ...(parsed.phone !== undefined ? { phone: parsed.phone ?? null } : {}),
        ...(parsed.address !== undefined ? { address: parsed.address ?? null } : {}),
        ...(parsed.syncStatus ? { syncStatus: parsed.syncStatus } : {}),
      },
    });

    return updated;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Delete a customer.
 * - Prevent deletion if there are invoices unless force=true and actor is Super_Admin.
 * - Prefer soft-delete pattern for production (add isActive/deletedAt to schema).
 */
export async function deleteCustomer(id: number, options?: { force?: boolean; actor?: Actor }) {
  try {
    const { force = false, actor } = options || {};
    const existing = await prisma.customer.findUnique({ where: { id } });
    if (!existing) throw new Error('Customer not found.');

    if (actor) requireTenantMatch(actor, existing.tenantId);

    const invoiceCount = await prisma.invoice.count({ where: { customerId: id } });
    if (invoiceCount > 0 && !force) {
      throw new Error('Customer has invoices; cannot delete without force=true.');
    }

    if (force) {
      if (!actor) throw new Error('Authentication required for force delete.');
      if (actor.role !== 'Super_Admin')
        throw new Error('Only Super_Admin may force-delete customers with invoices.');
    } else {
      if (actor) requireAdmin(actor);
    }

    const deleted = await prisma.customer.delete({ where: { id } });
    return deleted;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/* ---------------- Sync helpers & bulk operations ---------------- */

/**
 * Get unsynced customers for client sync engine.
 */
export async function getUnsyncedCustomers(tenantId: number, limit = 200, actor?: Actor) {
  try {
    if (actor) requireTenantMatch(actor, tenantId);

    const rows = await prisma.customer.findMany({
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
 * Mark customers as synced (bulk).
 */
export async function markCustomersAsSynced(ids: number[], actor?: Actor) {
  try {
    if (!ids || ids.length === 0) return { count: 0 };
    if (actor) {
      const countDifferentTenant = await prisma.customer.count({
        where: { id: { in: ids }, tenantId: { not: actor.tenantId } },
      });
      if (countDifferentTenant > 0)
        throw new Error('Attempt to mark customers outside your tenant.');
    }

    const res = await prisma.customer.updateMany({
      where: { id: { in: ids } },
      data: { syncStatus: 'SYNCED' },
    });

    return { count: res.count };
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Apply remote customers (device -> server).
 * - Basic conflict strategy: use updatedAt timestamp; dedupe by id, email or phone.
 * - Actor used to enforce tenant boundaries.
 */
export async function applyRemoteCustomers(
  remoteCustomers: Array<
    Partial<{
      id: number;
      tenantId: number;
      name: string;
      email?: string;
      phone?: string;
      address?: string;
      updatedAt?: string | Date;
      syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
    }>
  >,
  actor?: Actor
) {
  if (!remoteCustomers || remoteCustomers.length === 0) return { applied: 0 };

  const chunkSize = 25;
  let applied = 0;

  try {
    for (let i = 0; i < remoteCustomers.length; i += chunkSize) {
      const chunk = remoteCustomers.slice(i, i + chunkSize);

      if (actor) {
        const mismatch = chunk.some(
          (r) => typeof r.tenantId === 'number' && r.tenantId !== actor.tenantId
        );
        if (mismatch) throw new Error('Tenant mismatch in remote payload.');
      }

      for (const rc of chunk) {
        if (!rc.tenantId) {
          if (actor) rc.tenantId = actor.tenantId;
          else throw new Error('tenantId missing from remote customer payload.');
        }

        // If id provided, try upsert-like behaviour
        if (typeof rc.id === 'number') {
          const local = await prisma.customer.findUnique({ where: { id: rc.id } });
          if (!local) {
            await prisma.customer.create({
              data: {
                tenantId: rc.tenantId,
                name: rc.name ?? `remote-${Date.now()}`,
                email: rc.email ?? null,
                phone: rc.phone ?? null,
                address: rc.address ?? null,
                syncStatus: rc.syncStatus ?? 'SYNCED',
              },
            });
            applied++;
            continue;
          } else {
            const remoteUpdated = rc.updatedAt ? new Date(rc.updatedAt).getTime() : 0;
            const localUpdated = (local.updatedAt ?? local.createdAt).getTime();
            if (remoteUpdated > localUpdated) {
              await prisma.customer.update({
                where: { id: local.id },
                data: {
                  name: rc.name ?? local.name,
                  email: rc.email ?? local.email,
                  phone: rc.phone ?? local.phone,
                  address: rc.address ?? local.address,
                  syncStatus: rc.syncStatus ?? local.syncStatus,
                },
              });
              applied++;
            }
            continue;
          }
        }

        // No id: try dedupe by email or phone within tenant
        if (rc.email) {
          const exists = await prisma.customer.findFirst({
            where: { tenantId: rc.tenantId, email: rc.email },
          });
          if (exists) {
            const remoteUpdated = rc.updatedAt ? new Date(rc.updatedAt).getTime() : 0;
            const localUpdated = (exists.updatedAt ?? exists.createdAt).getTime();
            if (remoteUpdated > localUpdated) {
              await prisma.customer.update({
                where: { id: exists.id },
                data: {
                  name: rc.name ?? exists.name,
                  phone: rc.phone ?? exists.phone,
                  address: rc.address ?? exists.address,
                  syncStatus: rc.syncStatus ?? exists.syncStatus,
                },
              });
              applied++;
            }
            continue;
          }
        }

        if (rc.phone) {
          const exists = await prisma.customer.findFirst({
            where: { tenantId: rc.tenantId, phone: rc.phone },
          });
          if (exists) {
            const remoteUpdated = rc.updatedAt ? new Date(rc.updatedAt).getTime() : 0;
            const localUpdated = (exists.updatedAt ?? exists.createdAt).getTime();
            if (remoteUpdated > localUpdated) {
              await prisma.customer.update({
                where: { id: exists.id },
                data: {
                  name: rc.name ?? exists.name,
                  email: rc.email ?? exists.email,
                  address: rc.address ?? exists.address,
                  syncStatus: rc.syncStatus ?? exists.syncStatus,
                },
              });
              applied++;
            }
            continue;
          }
        }

        // Fallback create new
        await prisma.customer.create({
          data: {
            tenantId: rc.tenantId,
            name: rc.name ?? `remote-${Date.now()}`,
            email: rc.email ?? null,
            phone: rc.phone ?? null,
            address: rc.address ?? null,
            syncStatus: rc.syncStatus ?? 'SYNCED',
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
 * Get customers updated since a timestamp (server -> client sync).
 */
export async function getCustomersUpdatedSince(
  since: Date,
  options?: { tenantId?: number; actor?: Actor }
) {
  try {
    const { tenantId, actor } = options || {};
    const where: any = { updatedAt: { gt: since } };
    if (actor && actor.role !== 'Super_Admin') where.tenantId = actor.tenantId;
    else if (tenantId) where.tenantId = tenantId;

    const rows = await prisma.customer.findMany({ where, orderBy: { updatedAt: 'asc' } });
    return rows;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/* ---------------- Reporting & Export ---------------- */

/**
 * Export customers for a tenant (optional search).
 */
export async function exportCustomersForTenant(
  tenantId: number,
  options?: { search?: string; actor?: Actor }
) {
  try {
    const { search, actor } = options || {};
    if (actor) requireTenantMatch(actor, tenantId);

    const where: any = { tenantId };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }

    const customers = await prisma.customer.findMany({ where, orderBy: { name: 'asc' } });
    return { tenantId, count: customers.length, customers, exportedAt: new Date().toISOString() };
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Basic customer sanity check for tenant health dashboards.
 */
export async function customerSanityCheck(tenantId: number, actor?: Actor) {
  try {
    if (actor) requireTenantMatch(actor, tenantId);
    await ensureTenantExists(tenantId);

    const [customerCount, anonymousEmails] = await Promise.all([
      prisma.customer.count({ where: { tenantId } }),
      prisma.customer.count({ where: { tenantId, email: null } }),
    ]);

    const issues: string[] = [];
    if (customerCount === 0) issues.push('No customers found for tenant.');
    if (anonymousEmails > 0)
      issues.push(`${anonymousEmails} customers are missing email addresses.`);

    return { customerCount, anonymousEmails, issues };
  } catch (err) {
    prismaErrorHandler(err);
  }
}
