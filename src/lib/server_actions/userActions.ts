'use server';

import { Actor } from '@/types/userTypes';
import prisma from '../prisma';
import bcrypt from 'bcryptjs';
import { createUserSchema, updateUserSchema } from '@/utils/userValidator';
import {
  prismaErrorHandler,
  requireActor,
  requireAdmin,
  requireTenantMatch,
} from '@/utils/userHelper';

/**
 * Helpful types
 */

/**
 * Validation schemas (Zod)
 */

/**
 * Helpers
 */

/**
 * Standardized error wrapper for prisma calls
 */
// function prismaErrorHandler(err: any) {
//   // In production you might map prisma errors to friendly messages.
//   // Keep the full error available for logs but throw a simpler message to clients.
//   // (Do not leak internal database details in real prod.)
//   throw new Error(err?.message ?? 'Database operation failed');
// }

/**
 * Create a new user.
 * - Hashes the password.
 * - Validates input.
 * - Ensures tenant exists and email isn't already used.
 * - Optionally require the calling actor to be an Admin on the tenant (if provided).
 */
export async function createUser(
  data: {
    name: string;
    email: string;
    password: string;
    role: 'User' | 'Admin' | 'Super_Admin';
    tenantId: number;
  },
  actor?: Actor // optional: the caller (used to enforce tenant boundaries / Admin rights)
) {
  try {
    const parsed = createUserSchema.parse(data);

    if (actor) {
      // Only Admins (or super-Admin) can create users for a tenant other than themselves
      requireActor(actor);
      requireTenantMatch(actor, parsed.tenantId);
      requireAdmin(actor);
    }

    // ensure tenant exists
    const tenant = await prisma.tenant.findUnique({
      where: { id: parsed.tenantId },
      select: { id: true },
    });
    if (!tenant) throw new Error('Tenant does not exist.');

    // ensure email uniqueness (schema has a global unique constraint on email, so catch early)
    const existing = await prisma.user.findUnique({ where: { email: parsed.email } });
    if (existing) throw new Error('Email already in use.');

    const hashed = await bcrypt.hash(parsed.password, 10);

    if (parsed.role !== 'User' && parsed.role !== 'Super_Admin' && parsed.role !== 'Admin') {
      throw new Error('Invalid role specified.');
    }

    const user = await prisma.user.create({
      data: {
        name: parsed.name,
        email: parsed.email,
        password: hashed,
        role: parsed.role as 'User' | 'Admin' | 'Super_Admin',
        tenantId: parsed.tenantId,
        // syncStatus defaults to PENDING via schema
      },
    });

    // Remove sensitive fields before returning
    // (we still return the created object but hide password)
    // Note: Prisma returns password field — omit it here.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password, ...safe } = user as any;
    return safe;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Get a user by id.
 * - If actor is provided, it enforces tenant scoping (no cross-tenant reads).
 */
export async function getUserById(id: number, actor?: Actor) {
  try {
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return null;

    if (actor) requireTenantMatch(actor, user.tenantId);

    const { password, ...safe } = user as any;
    return safe;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Get users with pagination, filtering, and optional search.
 * - By default, returns users for the actor's tenant only (if actor provided).
 * - Supports page & pageSize for pagination.
 */
export async function getUsers(options?: {
  tenantId?: number;
  page?: number;
  pageSize?: number;
  search?: string;
  role?: string;
  includeCount?: boolean;
  actor?: Actor;
}) {
  try {
    const {
      tenantId,
      page = 1,
      pageSize = 20,
      search,
      role,
      includeCount = false,
      actor,
    } = options || {};

    // If actor present and tenantId not explicitly provided, scope to actor.tenantId
    const effectiveTenantId = actor ? actor.tenantId : tenantId;

    const where: any = {};
    if (effectiveTenantId) where.tenantId = effectiveTenantId;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (role) where.role = role;

    // Enforce tenant scoping: if actor provided and tenantId is provided which does not match actor, deny
    if (actor && typeof tenantId === 'number') requireTenantMatch(actor, tenantId);

    const users = await prisma.user.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
    });

    const sanitized = (users as any[]).map(({ password, ...rest }) => rest);

    if (includeCount) {
      const total = await prisma.user.count({ where });
      return { users: sanitized, total, page, pageSize };
    }
    return sanitized;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Update a user.
 * - If password is present, it will be hashed.
 * - Role changes require Admin privilege.
 * - Enforces tenant scoping when actor provided.
 */
export async function updateUser(
  id: number,
  data: {
    name?: string;
    email?: string;
    password?: string;
    role?: string;
    syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
  },
  actor?: Actor
) {
  try {
    const parsed = updateUserSchema.parse(data);
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw new Error('User not found.');

    if (actor) requireTenantMatch(actor, existing.tenantId);

    // Only Admins can change roles
    if (parsed.role && actor) {
      requireAdmin(actor);
    }

    // If email is updated, ensure uniqueness (schema has unique constraint globally)
    if (parsed.email && parsed.email !== existing.email) {
      const conflict = await prisma.user.findUnique({ where: { email: parsed.email } });
      if (conflict) throw new Error('Email already in use.');
    }

    const updateData: any = { ...parsed };

    if (parsed.password) {
      updateData.password = await bcrypt.hash(parsed.password, 10);
    }

    // Only allow explicit syncStatus values
    if (parsed.syncStatus) {
      updateData.syncStatus = parsed.syncStatus;
    }

    const updated = await prisma.user.update({
      where: { id },
      data: updateData,
    });

    const { password, ...safe } = updated as any;
    return safe;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Permanently delete a user by id.
 * - Only Admins or super-Admins for the tenant can delete.
 * - In many products you may prefer a soft-delete pattern; your schema would need a flag (isActive/deletedAt).
 */
export async function deleteUser(id: number, actor?: Actor) {
  try {
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw new Error('User not found.');
    if (actor) {
      requireTenantMatch(actor, existing.tenantId);
      requireAdmin(actor);
    }

    // Note: this is a permanent delete. Adjust to soft-delete pattern if you extend schema.
    const deleted = await prisma.user.delete({ where: { id } });
    const { password, ...safe } = deleted as any;
    return safe;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Change password with old password verification.
 */
export async function changePassword(
  userId: number,
  oldPassword: string,
  newPassword: string,
  actor?: Actor
) {
  try {
    if (!newPassword || newPassword.length < 6) throw new Error('New password too short.');
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('User not found.');
    if (actor) requireTenantMatch(actor, user.tenantId);

    const ok = await bcrypt.compare(oldPassword, user.password);
    if (!ok) throw new Error('Old password does not match.');

    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: userId }, data: { password: hashed } });
    return { success: true };
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Get unsynced users (for client sync engine)
 */
export async function getUnsyncedUsers(tenantId: number, limit = 200, actor?: Actor) {
  try {
    if (actor) requireTenantMatch(actor, tenantId);

    const users = await prisma.user.findMany({
      where: { tenantId, syncStatus: 'PENDING' },
      take: limit,
      orderBy: { updatedAt: 'asc' },
    });

    return (users as any[]).map(({ password, ...rest }) => rest);
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Mark users as synced (bulk)
 */
export async function markUsersAsSynced(ids: number[], actor?: Actor) {
  try {
    if (!ids || ids.length === 0) return { count: 0 };

    // Optionally check actor tenant ownership for each id
    if (actor) {
      const countDifferentTenant = await prisma.user.count({
        where: { id: { in: ids }, tenantId: { not: actor.tenantId } },
      });
      if (countDifferentTenant > 0) throw new Error('Attempt to mark users outside your tenant.');
    }

    const res = await prisma.user.updateMany({
      where: { id: { in: ids } },
      data: { syncStatus: 'SYNCED' },
    });

    return { count: res.count };
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Apply remote changes received from server (client->server sync scenario).
 * - Accepts an array of user records from a trusted source (e.g. device sync payload).
 * - The function tries to apply updates transactionally where possible.
 * - Conflict rule used here: server trusts remote updatedAt if newer than DB updatedAt.
 *
 * NOTE: This is an example reconciliation strategy. For stronger guarantees you'd
 * want to include operation logs, vector clocks, or CRDTs depending on conflict needs.
 */
export async function applyRemoteUsers(
  remoteUsers: Array<
    Partial<{
      id: number;
      name: string;
      email: string;
      password?: string; // hashed on client? normally clients shouldn't send raw passwords
      role: 'User' | 'Admin' | 'Super_Admin';
      tenantId: number;
      updatedAt: string | Date;
      syncStatus?: 'PENDING' | 'SYNCED' | 'FAILED';
    }>
  >,
  actor?: Actor
) {
  if (!remoteUsers || remoteUsers.length === 0) return { applied: 0 };

  // Keep operations small for serverless limits — batch in chunks.
  const chunkSize = 25;
  let applied = 0;

  try {
    for (let i = 0; i < remoteUsers.length; i += chunkSize) {
      const chunk = remoteUsers.slice(i, i + chunkSize);

      // validate tenant boundaries if actor provided
      if (actor) {
        const tenantMismatch = chunk.some(
          (r) => typeof r.tenantId === 'number' && r.tenantId !== actor.tenantId
        );
        if (tenantMismatch) throw new Error('Tenant mismatch in remote payload.');
      }

      // We will upsert by id when provided, otherwise create if no id/email exists.
      // IMPORTANT: this naive approach assumes remote payloads are trusted and include consistent updatedAt timestamps.
      for (const ru of chunk) {
        if (!ru.tenantId) {
          // If actor provided, assume actor.tenantId
          if (actor) ru.tenantId = actor.tenantId;
          else throw new Error('tenantId missing from remote user payload.');
        }

        // If id present, check for existing record
        if (typeof ru.id === 'number') {
          const local = await prisma.user.findUnique({ where: { id: ru.id } });
          if (!local) {
            // Create new with provided id is not possible when id is autoincrement.
            // Create new ignoring id (server will issue a new id).
            await prisma.user.create({
              data: {
                name: ru.name ?? 'Unnamed',
                email: ru.email ?? `unknown+${Date.now()}@local.invalid`,
                password: ru.password ?? '', // In practice, clients should not send raw passwords. Handle carefully.
                role: (ru.role as 'User' | 'Admin' | 'Super_Admin') ?? 'USER',
                tenantId: ru.tenantId,
                syncStatus: ru.syncStatus ?? 'SYNCED',
              },
            });
            applied++;
          } else {
            // conflict resolution: compare updatedAt
            const remoteUpdated = ru.updatedAt ? new Date(ru.updatedAt).getTime() : 0;
            const localUpdated = (local.updatedAt ?? local.createdAt).getTime();
            if (remoteUpdated > localUpdated) {
              // Perform update (hash password only if provided and appears unhashed)
              const updateData: any = {
                name: ru.name ?? local.name,
                email: ru.email ?? local.email,
                role: ru.role ?? local.role,
                syncStatus: ru.syncStatus ?? local.syncStatus,
              };
              if (ru.password) {
                // assume remote sent a hashed password (if not, you'd need a secure password change workflow)
                updateData.password = ru.password;
              }
              await prisma.user.update({ where: { id: local.id }, data: updateData });
              applied++;
            } else {
              // local is newer: ignore remote or record conflict for later resolution
              // For now, we skip.
            }
          }
        } else {
          // No id present: try to find by email (email unique globally per schema)
          if (!ru.email) {
            // fallback to create with generated email to avoid db unique issues
            ru.email = `unknown+${Date.now()}@local.invalid`;
          }
          const existingByEmail = await prisma.user.findUnique({ where: { email: ru.email } });
          if (existingByEmail) {
            // update if remote newer
            const remoteUpdated = ru.updatedAt ? new Date(ru.updatedAt).getTime() : 0;
            const localUpdated = (existingByEmail.updatedAt ?? existingByEmail.createdAt).getTime();
            if (remoteUpdated > localUpdated) {
              await prisma.user.update({
                where: { email: ru.email },
                data: {
                  name: ru.name ?? existingByEmail.name,
                  role: ru.role ?? existingByEmail.role,
                  syncStatus: ru.syncStatus ?? existingByEmail.syncStatus,
                  password: ru.password ? ru.password : existingByEmail.password,
                },
              });
              applied++;
            }
          } else {
            await prisma.user.create({
              data: {
                name: ru.name ?? 'Unnamed',
                email: ru.email,
                password: ru.password ?? '', // be careful with plaintext passwords
                role: (ru.role as 'User' | 'Admin' | 'Super_Admin') ?? 'USER',
                tenantId: ru.tenantId,
                syncStatus: ru.syncStatus ?? 'SYNCED',
              },
            });
            applied++;
          }
        }
      }
    }

    return { applied };
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Get user counts by role for dashboard/tenant metrics.
 */
export async function getUserCountsByRole(tenantId: number, actor?: Actor) {
  try {
    if (actor) requireTenantMatch(actor, tenantId);

    // group by role
    const roles = await prisma.user.groupBy({
      by: ['role'],
      where: { tenantId },
      _count: { role: true },
    });

    const result: Record<string, number> = {};
    roles.forEach((r: any) => (result[r.role] = r._count.role));
    return result;
  } catch (err) {
    prismaErrorHandler(err);
  }
}

/**
 * Set sync status of a user (explicit).
 */
export async function setUserSyncStatus(
  id: number,
  status: 'PENDING' | 'SYNCED' | 'FAILED',
  actor?: Actor
) {
  try {
    const u = await prisma.user.findUnique({ where: { id } });
    if (!u) throw new Error('User not found.');
    if (actor) requireTenantMatch(actor, u.tenantId);

    const updated = await prisma.user.update({ where: { id }, data: { syncStatus: status } });
    const { password, ...safe } = updated as any;
    return safe;
  } catch (err) {
    prismaErrorHandler(err);
  }
}
