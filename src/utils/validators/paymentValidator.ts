import { z } from 'zod';

const createPaymentSchema = z.object({
  invoiceId: z.number().int().positive(),
  reference: z.string().min(1),
  paidDate: z.preprocess((v) => (typeof v === 'string' ? new Date(v) : v), z.date()),
  tenantId: z.string(),
  date: z.preprocess((v) => (typeof v === 'string' ? new Date(v) : v), z.date()),
  amount: z.number().positive(),
  method: z
    .enum(['BANK_TRANSFER', 'CREDIT_CARD', 'DEBIT_CARD', 'CASH', 'CHEQUE', 'ONLINE', 'OTHER'])
    .optional(),
  syncStatus: z.enum(['PENDING', 'SYNCED', 'FAILED']).optional(),
});

const updatePaymentSchema = z.object({
  reference: z.string().min(1).optional(),
  paidDate: z.preprocess((v) => (typeof v === 'string' ? new Date(v) : v), z.date()).optional(),
  date: z.preprocess((v) => (typeof v === 'string' ? new Date(v) : v), z.date()).optional(),
  amount: z.number().positive().optional(),
  method: z
    .enum(['BANK_TRANSFER', 'CREDIT_CARD', 'DEBIT_CARD', 'CASH', 'CHEQUE', 'ONLINE', 'OTHER'])
    .optional(),
  syncStatus: z.enum(['PENDING', 'SYNCED', 'FAILED']).optional(),
});

export { createPaymentSchema, updatePaymentSchema };
