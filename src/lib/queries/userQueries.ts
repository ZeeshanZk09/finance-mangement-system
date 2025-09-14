// lib/queries/tenantQueries.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createUser as apiCreateUser,
  getUserById as apiGetUserById,
  getAllUsers as apiGetAllUsers,
  updateUser as apiUpdateUser,
  deleteUser as apiDeleteUser,
  getTenantsUpdatedSince as apiGetTenantsUpdatedSince,
  exportTenantData as apiExportTenantData,
  tenantSanityCheck as apiTenantSanityCheck,
} from '@/lib/server_actions/userActions';
import type { Tenant, CreateTenantDto, UpdateTenantDto } from '@/types/tenantTypes';
// import { Data } from 'ws';

export const USERS_QUERY_KEY = ['user'];
export const userKey = (id: string | undefined) => (id ? ['user', id] : ['user', 'unknown']);

/** useTenants: paginated + filterable list */
export function useUsers(params?: {
  page?: number;
  pageSize?: number;
  q?: string;
  active?: boolean | null;
}) {
  return useQuery({
    queryKey: [...USERS_QUERY_KEY, params ?? {}],
    queryFn: async () => {
      const res = await apiGetAllUsers(params ?? {});
      // Expect apiGetAllTenants to return { items: Tenant[], total: number, page, pageSize }
      return res;
    },
    // keepPreviousData: true,
    staleTime: 1000 * 60 * 1, // 1 minute
    // onError: (err) => {
    //   console.error('Failed fetching tenants', err);
    // },
  });
}

/** useTenant: single tenant */
export function useTenant(id?: number) {
  return useQuery({
    queryKey: tenantKey(String(id)),
    queryFn: async () => {
      if (!id) throw new Error('No tenant id provided');
      return (await apiGetTenantById(id)) as Tenant;
    },
    enabled: !!id,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

/** useCreateTenant: optimistic update + rollback */
export function useCreateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (dto: CreateTenantDto) => {
      return (await apiCreateTenant(dto)) as Tenant;
    },
    onMutate: async (newTenant) => {
      await qc.cancelQueries({ queryKey: TENANTS_QUERY_KEY });
      const previous = qc.getQueryData<any>(TENANTS_QUERY_KEY);
      // Optimistically add item to cached list
      qc.setQueryData(TENANTS_QUERY_KEY, (old: any) => {
        if (!old) return { items: [newTenant], total: 1 };
        return {
          ...old,
          items: [newTenant as any, ...(old.items ?? [])],
          total: (old.total ?? 0) + 1,
        };
      });
      return { previous };
    },
    onError: (err, variables, context: any) => {
      // rollback
      if (context?.previous) qc.setQueryData(TENANTS_QUERY_KEY, context.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: TENANTS_QUERY_KEY });
    },
  });
}

/** useUpdateTenant: optimistic */
export function useUpdateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, dto }: { id: string; dto: UpdateTenantDto }) => {
      return (await apiUpdateTenant(+id, dto)) as Tenant;
    },
    onMutate: async ({ id, dto }) => {
      await qc.cancelQueries({ queryKey: TENANTS_QUERY_KEY });
      const prevList = qc.getQueryData<any>(TENANTS_QUERY_KEY);
      const prevSingle = qc.getQueryData<any>(tenantKey(id));
      // optimistic updates
      qc.setQueryData(TENANTS_QUERY_KEY, (old: any) => {
        if (!old) return old;
        return {
          ...old,
          items: (old.items ?? []).map((t: Tenant) => (t.id === id ? { ...t, ...dto } : t)),
        };
      });
      qc.setQueryData(tenantKey(id), (old: any) => (old ? { ...old, ...dto } : old));
      return { prevList, prevSingle };
    },
    onError: (err, vars, context: any) => {
      if (context?.prevList) qc.setQueryData(TENANTS_QUERY_KEY, context.prevList);
      if (context?.prevSingle) qc.setQueryData(tenantKey((vars as any).id), context.prevSingle);
    },
    onSettled: (data, error, vars) => {
      qc.invalidateQueries({ queryKey: TENANTS_QUERY_KEY });
      qc.invalidateQueries({ queryKey: tenantKey((vars as any).id) });
    },
  });
}

/** useDeleteTenant: optimistic removal */
export function useDeleteTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return await apiDeleteTenant(+id);
    },
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: TENANTS_QUERY_KEY });
      const previous = qc.getQueryData<any>(TENANTS_QUERY_KEY);
      qc.setQueryData(TENANTS_QUERY_KEY, (old: any) => {
        if (!old) return old;
        return {
          ...old,
          items: (old.items ?? []).filter((t: Tenant) => t.id !== id),
          total: (old.total ?? 1) - 1,
        };
      });
      qc.removeQueries({ queryKey: tenantKey(id) });
      return { previous };
    },
    onError: (err, id, context: any) => {
      if (context?.previous) qc.setQueryData(TENANTS_QUERY_KEY, context.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: TENANTS_QUERY_KEY }),
  });
}

/** useExportTenantData: returns url / file */
export function useExportTenantData() {
  return useMutation({
    mutationFn: async (id: string) => {
      // api should return e.g. { downloadUrl: string } or file blob
      return await apiExportTenantData(+id);
    },
  });
}

/** useTenantSanityCheck */
export function useTenantSanityCheck() {
  return useMutation({
    mutationFn: async (id: string) => {
      return await apiTenantSanityCheck(+id);
    },
  });
}

/** useSyncTenants: get updates since lastSync and merge into cache */
export function useSyncTenants() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (since?: Date) => {
      // apiGetTenantsUpdatedSince expects a Date, so provide a default if since is undefined
      const validSince = since ?? new Date(0); // epoch as fallback
      return await apiGetTenantsUpdatedSince(validSince);
    },
    onSuccess: (payload: { items: Tenant[]; lastSyncAt?: string }) => {
      // Merge server changes into cached list (simple merging strategy)
      const cached = qc.getQueryData<any>(TENANTS_QUERY_KEY) as { items: Tenant[] } | undefined;
      const incoming = payload?.items ?? [];
      if (!incoming.length) {
        if (payload.lastSyncAt) {
          // set lastSync key in some cache or via a redux action
        }
        return;
      }

      const map = new Map<string, Tenant>();
      (cached?.items ?? []).forEach((t) => map.set(t.id, t));
      incoming.forEach((t) => map.set(t.id, t)); // overwrite with server copy

      const merged = Array.from(map.values()).sort((a, b) =>
        (a.name ?? '').localeCompare(b.name ?? '')
      );
      qc.setQueryData(TENANTS_QUERY_KEY, { items: merged, total: merged.length });
      // optionally set lastSyncAt somewhere (e.g. redux)
      if (payload.lastSyncAt) {
        // you can dispatch redux action setLastSyncAt(payload.lastSyncAt)
      }
    },
    onError: (err) => console.error('Sync tenants failed', err),
  });
}
