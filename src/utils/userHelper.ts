import { Actor } from '@/types/userTypes';
import prisma from '../lib/prisma';

function requireActor(actor?: Actor) {
  if (!actor) throw new Error('Authentication required for this operation.');
}

function requireSuperAdmin(actor?: Actor) {
  requireActor(actor);
  if (actor!.role !== 'Super_Admin') {
    throw new Error('Operation requires Super_Admin privileges.');
  }
}

async function ensureTenantExists(id: number) {
  const t = await prisma.tenant.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
    },
  });
  if (!t) throw new Error('Tenant not found.');
  return t;
}

function prismaErrorHandler(err: any) {
  // Replace with structured logging in production; do not leak DB internals to clients.
  throw new Error(err?.message ?? 'Database operation failed');
}

function requireTenantMatch(actor: Actor, tenantId: number) {
  if (actor && actor.tenantId !== tenantId && actor.role !== 'Super_Admin') {
    throw new Error('Access denied: tenant mismatch.');
  }
}

function requireAdmin(actor: Actor) {
  if (!actor || (actor.role !== 'Admin' && actor.role !== 'Super_Admin')) {
    throw new Error('Admin privileges required.');
  }
}

export {
  requireActor,
  requireSuperAdmin,
  ensureTenantExists,
  prismaErrorHandler,
  requireTenantMatch,
  requireAdmin,
};
