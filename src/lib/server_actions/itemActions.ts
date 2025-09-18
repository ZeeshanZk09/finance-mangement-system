'use server';

import { Actor } from '@/types/userTypes';
import prisma from '@/lib/prisma';
import type { PrismaClient } from '@/app/generated/prisma/client';
import {
  adjustStockSchema,
  createItemSchema,
  updateItemSchema,
} from '@/utils/validators/itemValidator';
import {
  ensureTenantExists,
  prismaErrorHandler,
  requireAdmin,
  requireTenantMatch,
} from '@/utils/helpers/userHelpers';

/**
 * Actor type used for tenant scoping and permission checks.
 * Example roles: 'User' | 'Admin' | 'Super_Admin'
 */
/* ---------------- Validation Schemas ---------------- */

/* ---------------- Helper utilities ---------------- */

/* ---------------- Core Item operations ---------------- */

/**
 * Create a new item (product).
 * - Validates input.
 * - Enforces tenant scoping if actor provided.
 * - Prevents duplicate SKU within tenant (best-effort).
 */
export async function createItem(
  data: {
    tenantId: number;
    name: string;
    sku?: string;
    description?: string;
    unitPrice: number;
    quantity?: number;
    syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
  },
  actor?: Actor
) {
  try {
    const parsed = createItemSchema.parse(data);

    if (actor) requireTenantMatch(actor, parsed.tenantId);

    await ensureTenantExists(parsed.tenantId);

    // If SKU provided, ensure uniqueness per tenant
    if (parsed.sku) {
      const existingSku = await prisma.item.findFirst({
        where: { tenantId: parsed.tenantId, sku: parsed.sku },
      });
      if (existingSku) {
        // Return existing to avoid duplicates (optionally throw instead)
        return existingSku;
      }
    }

    const item = await prisma.item.create({
      data: {
        tenantId: parsed.tenantId,
        name: parsed.name,
        sku: parsed.sku ?? null,
        description: parsed.description ?? null,
        unitPrice: parsed.unitPrice,
        quantity: parsed.quantity ?? 0,
        syncStatus: parsed.syncStatus ?? 'PENDING',
      },
    });

    return item;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Get item by id
 * - Enforces tenant scoping when actor provided.
 */
export async function getItemById(id: number, actor?: Actor) {
  try {
    const item = await prisma.item.findUnique({ where: { id } });
    if (!item) return null;
    if (actor) requireTenantMatch(actor, item.tenantId);
    return item;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Paginated / searchable listing of items for a tenant.
 * - Defaults to actor.tenantId if actor provided.
 * - Supports search by name/sku, price range, low-stock filter.
 */
export async function getItems(options?: {
  tenantId: string;
  page?: number;
  pageSize?: number;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  lowStockOnly?: boolean;
  lowStockThreshold?: number;
  includeCount?: boolean;
  actor?: Actor;
}) {
  try {
    const {
      tenantId,
      page = 1,
      pageSize = 50,
      search,
      minPrice,
      maxPrice,
      lowStockOnly = false,
      lowStockThreshold = 5,
      includeCount = false,
      actor,
    } = options || {};

    const effectiveTenantId = actor ? actor.tenantId : tenantId;
    if (actor && typeof tenantId === 'number') requireTenantMatch(actor, tenantId);

    if (!effectiveTenantId) throw new Error('tenantId required.');

    const where: any = { tenantId: effectiveTenantId };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (minPrice !== undefined || maxPrice !== undefined) {
      where.unitPrice = {};
      if (minPrice !== undefined) where.unitPrice.gte = minPrice;
      if (maxPrice !== undefined) where.unitPrice.lte = maxPrice;
    }
    if (lowStockOnly) {
      where.quantity = { lt: lowStockThreshold };
    }

    const items = await prisma.item.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { updatedAt: 'desc' },
    });

    if (includeCount) {
      const total = await prisma.item.count({ where });
      return { items, total, page, pageSize };
    }

    return items;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Update an item by ID.
 * - Validates input.
 * - Enforces tenant scoping and optional Admin check for critical changes (SKU, price).
 * - If unitPrice or quantity changed, update accordingly.
 */
export async function updateItem(
  id: number,
  data: {
    name?: string;
    sku?: string;
    description?: string;
    unitPrice?: number;
    quantity?: number;
    syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
  },
  actor?: Actor
) {
  try {
    const parsed = updateItemSchema.parse(data);
    const existing = await prisma.item.findUnique({ where: { id } });
    if (!existing) throw new Error('Item not found.');
    if (actor) requireTenantMatch(actor, existing.tenantId);

    // If SKU changing, ensure uniqueness within tenant
    if (parsed.sku && parsed.sku !== existing.sku) {
      // Only Admin may change SKU (sensitive)
      if (actor) requireAdmin(actor);
      const skuConflict = await prisma.item.findFirst({
        where: { tenantId: existing.tenantId, sku: parsed.sku, id: { not: id } },
      });
      if (skuConflict) throw new Error('Another item with this SKU exists in the tenant.');
    }

    const updated = await prisma.item.update({
      where: { id },
      data: {
        ...(parsed.name ? { name: parsed.name } : {}),
        ...(parsed.sku !== undefined ? { sku: parsed.sku ?? null } : {}),
        ...(parsed.description !== undefined ? { description: parsed.description ?? null } : {}),
        ...(parsed.unitPrice !== undefined ? { unitPrice: parsed.unitPrice } : {}),
        ...(parsed.quantity !== undefined ? { quantity: parsed.quantity } : {}),
        ...(parsed.syncStatus ? { syncStatus: parsed.syncStatus } : {}),
      },
    });

    return updated;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Adjust stock quantity (increase or decrease).
 * - Writes a StockAdjustment record (if you add such model later) could be used for audit.
 * - Recomputes quantity defensively using transaction to avoid race conditions.
 * - Records reason and actorId optionally in a logs table (not present in schema — comment left).
 */
export async function adjustStock(
  itemId: number,
  data: { delta: number; reason?: string; actorId?: number },
  actor?: Actor
) {
  try {
    const parsed = adjustStockSchema.parse(data);
    const item = await prisma.item.findUnique({ where: { id: itemId } });
    if (!item) throw new Error('Item not found.');
    if (actor) requireTenantMatch(actor, item.tenantId);
    // Only Admin can reduce stock arbitrarily (for example write-offs)
    if (parsed.delta < 0 && actor) requireAdmin(actor);

    const updated = await (prisma as unknown as PrismaClient).$transaction(async (tx) => {
      // compute new quantity
      const newQty = +(item.quantity ?? 0) + +parsed.delta;
      if (newQty < 0) throw new Error('Resulting quantity would be negative.');

      const u = await tx.item.update({
        where: { id: itemId },
        data: { quantity: newQty, syncStatus: 'PENDING' },
      });

      // Optional: create stock adjustment audit table record if you add model later:
      // await tx.stockAdjustment.create({ data: { itemId, delta: parsed.delta, reason: parsed.reason ?? null, actorId: parsed.actorId ?? null }});

      return u;
    });

    return updated;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Delete an item by id.
 * - Prevent deletion if invoiceItems reference the item unless force=true and actor is Super_Admin.
 * - Prefer soft-delete (add isActive/deletedAt in schema) to avoid data loss.
 */
export async function deleteItem(id: number, options?: { force?: boolean; actor?: Actor }) {
  try {
    const { force = false, actor } = options || {};
    const existing = await prisma.item.findUnique({ where: { id } });
    if (!existing) throw new Error('Item not found.');
    if (actor) requireTenantMatch(actor, existing.tenantId);

    // Check FK references (invoiceItems)
    const refCount = await prisma.invoiceItem.count({ where: { itemId: id } });
    if (refCount > 0 && !force) {
      throw new Error(
        `Item has ${refCount} line references and cannot be deleted (use force=true to override).`
      );
    }

    if (force) {
      if (!actor) throw new Error('Authentication required for force delete.');
      if (actor.role !== 'Super_Admin')
        throw new Error('Only Super_Admin may force delete items with references.');
    } else {
      if (actor) requireAdmin(actor);
    }

    // Delete item (permanent). Wrap in transaction if other cleanups needed.
    const deleted = await prisma.item.delete({ where: { id } });
    return deleted;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/* ---------------- Sync helpers & bulk operations ---------------- */

/**
 * Get unsynced items for client sync engine.
 */
export async function getUnsyncedItems(tenantId: string, limit = 200, actor?: Actor) {
  try {
    if (actor) requireTenantMatch(actor, tenantId);

    const items = await prisma.item.findMany({
      where: { tenantId, syncStatus: 'PENDING' },
      take: limit,
      orderBy: { updatedAt: 'asc' },
    });

    return items;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Mark items as synced (bulk).
 */
export async function markItemsAsSynced(ids: number[], actor?: Actor) {
  try {
    if (!ids || ids.length === 0) return { count: 0 };
    if (actor) {
      const countDifferentTenant = await prisma.item.count({
        where: { id: { in: ids }, tenantId: { not: actor.tenantId } },
      });
      if (countDifferentTenant > 0) throw new Error('Attempt to mark items outside your tenant.');
    }

    const res = await prisma.item.updateMany({
      where: { id: { in: ids } },
      data: { syncStatus: 'SYNCED' },
    });

    return { count: res.count };
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Apply remote items payload (device -> server sync).
 * - Conflict strategy: use updatedAt timestamp; create new items when missing.
 * - Actor used to validate tenant boundaries.
 */
export async function applyRemoteItems(
  remoteItems: Array<
    Partial<{
      id: number;
      tenantId: string;
      name: string;
      sku?: string;
      description?: string;
      unitPrice?: number;
      quantity?: number;
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
          (r) => typeof r.tenantId === 'string' && r.tenantId !== actor.tenantId
        );
        if (mismatch) throw new Error('Tenant mismatch in remote payload.');
      }

      for (const ri of chunk) {
        if (!ri.tenantId) {
          if (actor) ri.tenantId = actor.tenantId;
          else throw new Error('tenantId missing from remote item payload.');
        }

        // If id provided, attempt to upsert-like behaviour
        if (typeof ri.id === 'number') {
          const local = await prisma.item.findUnique({ where: { id: ri.id } });
          if (!local) {
            // create new item (cannot set id)
            await prisma.item.create({
              data: {
                tenantId: ri.tenantId,
                name: ri.name ?? `remote-${Date.now()}`,
                sku: ri.sku ?? null,
                description: ri.description ?? null,
                unitPrice: ri.unitPrice ?? 0,
                quantity: ri.quantity ?? 0,
                syncStatus: ri.syncStatus ?? 'SYNCED',
              },
            });
            applied++;
            continue;
          }

          const remoteUpdated = ri.updatedAt ? new Date(ri.updatedAt).getTime() : 0;
          const localUpdated = (local.updatedAt ?? local.createdAt).getTime();
          if (remoteUpdated > localUpdated) {
            // If SKU change could conflict, skip or rename — here we attempt update with dedupe checks
            if (ri.sku && ri.sku !== local.sku) {
              const conflict = await prisma.item.findFirst({
                where: { tenantId: ri.tenantId, sku: ri.sku, id: { not: local.id } },
              });
              if (conflict) {
                // skip SKU update to avoid collision; still apply other fields
                ri.sku = undefined;
              }
            }

            await prisma.item.update({
              where: { id: local.id },
              data: {
                ...(ri.name ? { name: ri.name } : {}),
                ...(ri.sku !== undefined ? { sku: ri.sku ?? null } : {}),
                ...(ri.description !== undefined ? { description: ri.description ?? null } : {}),
                ...(ri.unitPrice !== undefined ? { unitPrice: ri.unitPrice } : {}),
                ...(ri.quantity !== undefined ? { quantity: ri.quantity } : {}),
                ...(ri.syncStatus ? { syncStatus: ri.syncStatus } : {}),
              },
            });
            applied++;
          }
          continue;
        }

        // No id: try to dedupe by SKU (preferred) or name
        if (ri.sku) {
          const exists = await prisma.item.findFirst({
            where: { tenantId: ri.tenantId, sku: ri.sku },
          });
          if (exists) {
            const remoteUpdated = ri.updatedAt ? new Date(ri.updatedAt).getTime() : 0;
            const localUpdated = (exists.updatedAt ?? exists.createdAt).getTime();
            if (remoteUpdated > localUpdated) {
              await prisma.item.update({
                where: { id: exists.id },
                data: {
                  ...(ri.name ? { name: ri.name } : {}),
                  ...(ri.description !== undefined ? { description: ri.description ?? null } : {}),
                  ...(ri.unitPrice !== undefined ? { unitPrice: ri.unitPrice } : {}),
                  ...(ri.quantity !== undefined ? { quantity: ri.quantity } : {}),
                  ...(ri.syncStatus ? { syncStatus: ri.syncStatus } : {}),
                },
              });
              applied++;
            }
            continue;
          }
        }

        // Fallback create new
        await prisma.item.create({
          data: {
            tenantId: ri.tenantId,
            name: ri.name ?? `remote-${Date.now()}`,
            sku: ri.sku ?? null,
            description: ri.description ?? null,
            unitPrice: ri.unitPrice ?? 0,
            quantity: ri.quantity ?? 0,
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
 * Get items updated since a timestamp (server -> client sync).
 */
export async function getItemsUpdatedSince(
  since: Date,
  options?: { tenantId?: number; actor?: Actor }
) {
  try {
    const { tenantId, actor } = options || {};
    const where: any = { updatedAt: { gt: since } };
    if (actor && actor.role !== 'Super_Admin') where.tenantId = actor.tenantId;
    else if (tenantId) where.tenantId = tenantId;

    const items = await prisma.item.findMany({ where, orderBy: { updatedAt: 'asc' } });
    return items;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Bulk import items (array of simple item DTOs).
 * - Performs create or update by SKU within tenant.
 * - Returns summary counts.
 */
export async function importItemsBulk(
  tenantId: string,
  rows: Array<{
    name: string;
    sku?: string;
    description?: string;
    unitPrice?: number;
    quantity?: number;
  }>,
  actor?: Actor
) {
  try {
    if (actor) requireTenantMatch(actor, tenantId);
    await ensureTenantExists(tenantId);
    if (!rows || rows.length === 0) return { created: 0, updated: 0, skipped: 0 };

    let created = 0;
    let updated = 0;
    let skipped = 0;

    // Process sequentially to avoid race conditions on SKU
    for (const r of rows) {
      if (r.sku) {
        const existing = await prisma.item.findFirst({ where: { tenantId, sku: r.sku } });
        if (existing) {
          await prisma.item.update({
            where: { id: existing.id },
            data: {
              name: r.name ?? existing.name,
              description: r.description ?? existing.description,
              unitPrice: r.unitPrice ?? existing.unitPrice,
              quantity: r.quantity ?? existing.quantity,
              syncStatus: 'PENDING',
            },
          });
          updated++;
        } else {
          await prisma.item.create({
            data: {
              tenantId,
              name: r.name,
              sku: r.sku,
              description: r.description ?? null,
              unitPrice: r.unitPrice ?? 0,
              quantity: r.quantity ?? 0,
              syncStatus: 'PENDING',
            },
          });
          created++;
        }
      } else {
        // If no SKU, attempt to find by name (not ideal). Skip duplicates with same name.
        const existingByName = await prisma.item.findFirst({ where: { tenantId, name: r.name } });
        if (existingByName) {
          skipped++;
          continue;
        }
        await prisma.item.create({
          data: {
            tenantId,
            name: r.name,
            sku: null,
            description: r.description ?? null,
            unitPrice: r.unitPrice ?? 0,
            quantity: r.quantity ?? 0,
            syncStatus: 'PENDING',
          },
        });
        created++;
      }
    }

    return { created, updated, skipped };
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/* ---------------- Reporting & export ---------------- */

/**
 * Export items for a tenant (optionally filter low-stock).
 */
export async function exportItemsForTenant(
  tenantId: string,
  options?: { lowStockOnly?: boolean; lowStockThreshold?: number; actor?: Actor }
) {
  try {
    const { lowStockOnly = false, lowStockThreshold = 5, actor } = options || {};
    if (actor) requireTenantMatch(actor, tenantId);

    const where: any = { tenantId };
    if (lowStockOnly) where.quantity = { lt: lowStockThreshold };

    const items = await prisma.item.findMany({ where, orderBy: { name: 'asc' } });
    return { tenantId, count: items.length, items, exportedAt: new Date().toISOString() };
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Basic item sanity check (tenant).
 */
export async function itemSanityCheck(tenantId: string, actor?: Actor) {
  try {
    if (actor) requireTenantMatch(actor, tenantId);
    await ensureTenantExists(tenantId);
    const [itemCount, lowStockCount] = await Promise.all([
      prisma.item.count({ where: { tenantId } }),
      prisma.item.count({ where: { tenantId, quantity: { lt: 5 } } }),
    ]);

    const issues: string[] = [];
    if (itemCount === 0) issues.push('No items found for tenant.');
    if (lowStockCount > 0) issues.push(`${lowStockCount} items are low in stock.`);

    return { itemCount, lowStockCount, issues };
  } catch (err) {
    prismaErrorHandler(err);
  }
}
