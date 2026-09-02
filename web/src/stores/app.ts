import { create } from 'zustand';
import { api, type User } from '../lib/api';

interface AppState {
  authed: boolean | null;
  user: User | null;
  checkAuth: () => Promise<void>;
  setAuthed: (v: boolean) => void;
  logout: () => Promise<void>;
}

export const useApp = create<AppState>((set) => ({
  authed: null,
  user: null,
  checkAuth: async () => {
    try {
      const user = await api.me();
      set({ authed: true, user });
    } catch {
      set({ authed: false, user: null });
    }
  },
  setAuthed: (v) => set({ authed: v, user: null }),
  logout: async () => {
    try { await api.logout(); } catch { /* ignore */ }
    set({ authed: false, user: null });
  },
}));
