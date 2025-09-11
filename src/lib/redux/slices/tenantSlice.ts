// lib/redux/slices/tenantSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface TenantUIState {
  selectedTenantId: string | null;
  lastSyncAt: string | null; // ISO string
  isOffline: boolean;
  listFilter: {
    q?: string; // search text
    active?: boolean | null;
    page?: number;
    pageSize?: number;
  };
  isSyncing: boolean;
}

const initialState: TenantUIState = {
  selectedTenantId: null,
  lastSyncAt: null,
  isOffline: false,
  listFilter: {
    q: undefined,
    active: null,
    page: 1,
    pageSize: 20,
  },
  isSyncing: false,
};

const tenantSlice = createSlice({
  name: 'tenant',
  initialState,
  reducers: {
    setSelectedTenantId(state, action: PayloadAction<string | null>) {
      state.selectedTenantId = action.payload;
    },
    setLastSyncAt(state, action: PayloadAction<string | null>) {
      state.lastSyncAt = action.payload;
    },
    setOffline(state, action: PayloadAction<boolean>) {
      state.isOffline = action.payload;
    },
    setListFilter(state, action: PayloadAction<Partial<TenantUIState['listFilter']>>) {
      state.listFilter = { ...state.listFilter, ...action.payload };
    },
    setIsSyncing(state, action: PayloadAction<boolean>) {
      state.isSyncing = action.payload;
    },
    resetTenantUI(state) {
      state.selectedTenantId = null;
      state.lastSyncAt = null;
      state.isOffline = false;
      state.listFilter = initialState.listFilter;
      state.isSyncing = false;
    },
  },
});

export const {
  setSelectedTenantId,
  setLastSyncAt,
  setOffline,
  setListFilter,
  setIsSyncing,
  resetTenantUI,
} = tenantSlice.actions;

export default tenantSlice.reducer;
