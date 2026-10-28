import type { Role } from '../types.ts';
import { request } from './http.ts';

export interface AdminRow {
  id: number;
  username: string;
  role: Role;
  disabledAt: string | null;
  createdAt: string;
}

export const listAdmins = () => request<AdminRow[]>('/admins');

export const createAdmin = (body: { username: string; password: string; role: Role }) =>
  request<AdminRow>('/admins', { method: 'POST', body });

export const updateAdmin = (id: number, body: { role?: Role; disabled?: boolean }) =>
  request<AdminRow>(`/admins/${id}`, { method: 'PATCH', body });

export const resetAdminPassword = (id: number, password: string) =>
  request(`/admins/${id}/reset-password`, { method: 'POST', body: { password } });
