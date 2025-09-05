import { z } from 'zod';
const createItemSchema = z.object({
  tenantId: z.number().int().positive(),
  name: z.string().min(1),
  sku: z.string().optional(),
  description: z.string().optional(),
  unitPrice: z.number().nonnegative(),
  quantity: z.number().nonnegative().optional(),
  syncStatus: z.enum(['PENDING', 'SYNCED', 'FAILED']).optional(),
});

const updateItemSchema = z.object({
  name: z.string().min(1).optional(),
  sku: z.string().optional(),
  description: z.string().optional(),
  unitPrice: z.number().nonnegative().optional(),
  quantity: z.number().optional(),
  syncStatus: z.enum(['PENDING', 'SYNCED', 'FAILED']).optional(),
});

const adjustStockSchema = z.object({
  delta: z.number(),
  reason: z.string().optional(),
  actorId: z.number().optional(),
});

export { createItemSchema, updateItemSchema, adjustStockSchema };
