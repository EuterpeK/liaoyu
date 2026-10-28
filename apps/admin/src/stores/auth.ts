import { defineStore } from 'pinia';
import { request } from '../api/http.ts';
import type { Me, Role } from '../types.ts';

export const useAuth = defineStore('auth', {
  state: () => ({ me: null as Me | null, loaded: false }),
  getters: {
    role: (s): Role | null => s.me?.role ?? null,
  },
  actions: {
    async load() {
      try {
        this.me = await request<Me>('/me', { silent: true });
      } catch {
        this.me = null;
      }
      this.loaded = true;
    },
    async login(username: string, password: string) {
      this.me = await request<Me>('/login', { method: 'POST', body: { username, password }, silent: true });
      this.loaded = true;
    },
    async logout() {
      await request('/logout', { method: 'POST', silent: true }).catch(() => {});
      this.me = null;
    },
    clear() {
      this.me = null;
    },
  },
});
