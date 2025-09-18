import { z } from 'zod';

const createInvoiceItemSchema = z.object({
  tenantId: z.string(),
  invoiceId: z.number().int().positive(),
  itemId: z.number().int().positive(),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  lineTotal: z.number().nonnegative().optional(), // optional: computed if missing
  description: z.string().optional(),
  syncStatus: z.enum(['PENDING', 'SYNCED', 'FAILED']).optional(),
});

const updateInvoiceItemSchema = z.object({
  quantity: z.number().positive().optional(),
  unitPrice: z.number().nonnegative().optional(),
  lineTotal: z.number().nonnegative().optional(),
  description: z.string().optional(),
  syncStatus: z.enum(['PENDING', 'SYNCED', 'FAILED']).optional(),
});

export { createInvoiceItemSchema, updateInvoiceItemSchema };
