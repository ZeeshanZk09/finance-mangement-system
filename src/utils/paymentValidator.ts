import { z } from 'zod';

const createPaymentSchema = z.object({
  invoiceId: z.number().int().positive(),
  reference: z.string().min(1),
  paidDate: z.preprocess((v) => (typeof v === 'string' ? new Date(v) : v), z.date()),
  tenantId: z.number().int().positive(),
  date: z.preprocess((v) => (typeof v === 'string' ? new Date(v) : v), z.date()),
  amount: z.number().positive(),
  method: z.string().min(1),
  syncStatus: z.enum(['PENDING', 'SYNCED', 'FAILED']).optional(),
});

const updatePaymentSchema = z.object({
  reference: z.string().min(1).optional(),
  paidDate: z.preprocess((v) => (typeof v === 'string' ? new Date(v) : v), z.date()).optional(),
  date: z.preprocess((v) => (typeof v === 'string' ? new Date(v) : v), z.date()).optional(),
  amount: z.number().positive().optional(),
  method: z.string().optional(),
  syncStatus: z.enum(['PENDING', 'SYNCED', 'FAILED']).optional(),
});

export { createPaymentSchema, updatePaymentSchema };
