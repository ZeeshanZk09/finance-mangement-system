import { Actor } from '@/types/userTypes';
import prisma from '@/lib/prisma';
import { JsonValue } from '@prisma/client/runtime/client';
/**
 * Write audit log (multi-tenant aware).
 */
export async function logAudit(actor: Actor, tenantId: string, action: string, meta?: JsonValue) {
  await prisma.auditLog.create({
    data: {
      tenantId,
      userId: actor?.id ?? undefined,
      actor: actor ? `${actor.role}:${actor.id}` : 'system',
      action,
      meta: meta!,
      ipAddress: actor?.ip ?? undefined,
    },
  });
}
