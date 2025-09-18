import prisma from '@/lib/prisma';
import { ApiError } from '../NextApiError';
import { requireActor } from './userHelpers';
import { Actor } from '@/types/userTypes';

/**
 * Ensure tenant exists and return it.
 */
export async function ensureTenantExists(id: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id },
    select: { id: true, name: true, slug: true },
  });
  if (!tenant) throw new ApiError(404, `Tenant not found: ${id}`);
  return tenant;
}

/**
 * Require that actor belongs to the tenant, unless Admin.
 */
export function requireTenantMatch(actor: Actor, tenantId: string) {
  requireActor(actor);
  if (actor.role === 'Admin') return;
  if (actor.tenantId !== tenantId) {
    throw new ApiError(403, 'Tenant mismatch. Access denied.');
  }
}

/**
 * Require user is owner of a record, or Admin.
 */
export function requireOwnershipOrAdmin(actor: Actor, ownerId: string) {
  requireActor(actor);
  if (actor.role === 'Admin') return;
  if (actor.id !== ownerId) throw new ApiError(403, 'Access denied: not the owner.');
}

/**
 * Extract tenant from request host (subdomain-based tenancy)
 * Example: shop1.myapp.com => slug = "shop1"
 */
export async function getTenantFromHost(host?: string) {
  if (!host) throw new ApiError(400, 'Host header missing');

  // strip port if present (localhost:3000)
  const cleanHost = host.split(':')[0];

  // handle localhost and custom domains
  const parts = cleanHost.split('.');
  let slug: string | null = null;

  // Example: subdomain.myapp.com => ["subdomain", "myapp", "com"]
  if (parts.length > 2) {
    slug = parts[0];
  }

  if (!slug) {
    throw new ApiError(400, 'Tenant slug not found in host');
  }

  const tenant = await prisma.tenant.findUnique({
    where: { slug },
  });

  if (!tenant) {
    throw new ApiError(404, `Tenant not found for slug "${slug}"`);
  }

  return tenant;
}

/**
 * Extract tenant from request path (path-based tenancy)
 * Example: /shop1/dashboard => slug = "shop1"
 */
export async function getTenantFromPath(path?: string) {
  if (!path) throw new ApiError(400, 'Path missing');

  // Normalize (remove query string/fragment if passed accidentally)
  const normalized = path.split('?')[0].split('#')[0];

  // Extract first path segment
  const parts = normalized.split('/').filter(Boolean); // filter removes empty
  const slug = parts.length > 0 ? parts[0] : null;

  if (!slug) {
    throw new ApiError(400, 'Tenant slug not found in path');
  }

  const tenant = await prisma.tenant.findUnique({
    where: { slug },
  });

  if (!tenant) {
    throw new ApiError(404, `Tenant not found for slug "${slug}"`);
  }

  return tenant;
}
