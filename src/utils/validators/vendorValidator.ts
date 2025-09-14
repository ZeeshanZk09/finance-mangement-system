import { z } from 'zod';

const createVendorSchema = z.object({
  tenantId: z.string(),
  name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  taxId: z.string().optional(),
  syncStatus: z.enum(['PENDING', 'SYNCED', 'FAILED']).optional(),
});

const updateVendorSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  taxId: z.string().optional(),
  syncStatus: z.enum(['PENDING', 'SYNCED', 'FAILED']).optional(),
});

export { createVendorSchema, updateVendorSchema };
