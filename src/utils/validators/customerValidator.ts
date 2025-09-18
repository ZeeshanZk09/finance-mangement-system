import { z } from 'zod';

const createCustomerSchema = z.object({
  tenantId: z.string(),
  name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  syncStatus: z.enum(['PENDING', 'SYNCED', 'FAILED']).optional(),
});

const updateCustomerSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  syncStatus: z.enum(['PENDING', 'SYNCED', 'FAILED']).optional(),
});

export { createCustomerSchema, updateCustomerSchema };
