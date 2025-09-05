import { z } from 'zod';

const createInvoiceSchema = z.object({
  tenantId: z.number().int().positive(),
  // vendorId is optional depending on schema; if your Prisma model includes it, pass it in the payload.
  // We won't assume vendorId exists in DB schema; we will only check for customerId which is present in the schema above.
  customerId: z.number().int().positive(),
  invoiceNumber: z.string().min(1),
  date: z.preprocess((v) => (typeof v === 'string' ? new Date(v) : v), z.date()).optional(),
  dueDate: z.preprocess((v) => (typeof v === 'string' ? new Date(v) : v), z.date()).optional(),
  currency: z.string().min(1),
  total: z.number().nonnegative().optional(), // computed if missing
  status: z.enum(['DRAFT', 'SENT', 'PAID']).optional(),
  items: z
    .array(
      z.object({
        itemId: z.number().int().positive(),
        quantity: z.number().positive(),
        unitPrice: z.number().nonnegative(),
        description: z.string().optional(),
      })
    )
    .optional(),
  syncStatus: z.enum(['PENDING', 'SYNCED', 'FAILED']).optional(),
});

const updateInvoiceSchema = z.object({
  invoiceNumber: z.string().optional(),
  date: z.preprocess((v) => (typeof v === 'string' ? new Date(v) : v), z.date()).optional(),
  dueDate: z.preprocess((v) => (typeof v === 'string' ? new Date(v) : v), z.date()).optional(),
  currency: z.string().optional(),
  total: z.number().nonnegative().optional(),
  status: z.enum(['DRAFT', 'SENT', 'PAID']).optional(),
  syncStatus: z.enum(['PENDING', 'SYNCED', 'FAILED']).optional(),
});

export { createInvoiceSchema, updateInvoiceSchema };
