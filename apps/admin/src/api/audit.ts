import { request } from './http.ts';

export interface AuditLog {
  id: number;
  adminId: number | null;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export const listAuditLogs = (limit = 200) => request<AuditLog[]>('/audit-logs', { query: { limit } });
