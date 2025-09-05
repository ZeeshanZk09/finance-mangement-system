import { z } from 'zod';

const createTenantSchema = z.object({
  name: z.string().min(2).max(200),
});

const updateTenantSchema = z.object({
  name: z.string().min(2).max(200).optional(),
});

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.string().min(1),
  tenantId: z.number().int().positive(),
});

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  password: z.string().min(6).optional(),
  role: z.string().optional(),
  syncStatus: z.enum(['PENDING', 'SYNCED', 'FAILED']).optional(),
});

export { createTenantSchema, updateTenantSchema, createUserSchema, updateUserSchema };
