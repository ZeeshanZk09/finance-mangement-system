// src/utils/authzHelpers.ts
import type { Actor } from '@/types/userTypes';
import prisma from '@/lib/prisma';
import { ApiError } from '@/utils/NextApiError';
// import type { NextApiRequest } from 'next';
import { NextApiRequest } from 'next';
import { headers } from 'next/headers';

/**
 * Ensure an actor (logged-in user context) exists.
 */
function requireActor(actor: Actor): asserts actor is Actor {
  if (!actor) {
    throw new ApiError(401, 'Authentication required.');
  }
}

/**
 * Require actor has one of allowed roles.
 */
function requireRole(actor: Actor, roles: string[]) {
  requireActor(actor);
  if (!roles.includes(actor.role)) {
    throw new ApiError(403, `Requires one of roles: ${roles.join(', ')}`);
  }
}

/**
 * Ensure actor is Admin.
 */
function requireAdmin(actor: Actor): asserts actor is Actor {
  requireActor(actor);
  if (actor.role !== 'Admin') {
    throw new ApiError(403, 'Operation requires Admin privileges.');
  }
}

/**
 * Ensure actor is Approver.
 */
function requireApprover(actor: Actor): asserts actor is Actor {
  requireActor(actor);
  if (actor.role !== 'Approver') {
    throw new ApiError(403, 'Operation requires Approver privileges.');
  }
}

async function getIpAddress(): Promise<string | undefined> {
  const h = await headers().then((h) => {
    const forwarded = h.get('x-forwarded-for');
    if (forwarded) {
      return forwarded.split(',')[0]?.trim();
    }
    return h.get('x-real-ip') ?? undefined;
  });
  return h;
}

export { requireRole, requireActor, requireAdmin, requireApprover, getIpAddress };
