// lib/types/tenant.ts
export interface Tenant {
  id: string;
  name: string;
  ownerId?: string;
  plan?: 'free' | 'basic' | 'premium' | 'pro';
  metadata?: Record<string, any>;
  createdAt?: string;
  updatedAt?: string;
  // add fields as you need (address, contact, customFields, etc.)
}

export interface CreateTenantDto {
  name: string;
  plan?: Tenant['plan'];
  metadata?: Record<string, any>;
}

export interface UpdateTenantDto {
  name?: string;
  plan?: Tenant['plan'];
  metadata?: Record<string, any>;
}
