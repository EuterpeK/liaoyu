import { request } from './http.ts';

export type SettlementStatus = 'pending' | 'paid';

export interface SettlementRow {
  id: number;
  teacherId: number;
  teacherName: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  commissionBps: number;
  commissionCents: number;
  netCents: number;
  status: SettlementStatus;
  proof: string | null;
  paidAt: string | null;
  createdAt: string;
}

export const listSettlements = (status?: SettlementStatus) =>
  request<SettlementRow[]>('/settlements', { query: { status } });

export const generateSettlements = (body: { periodStart: string; periodEnd: string }) =>
  request<SettlementRow[]>('/settlements/generate', { method: 'POST', body });

export const paySettlement = (id: number, proof: string) =>
  request<SettlementRow>(`/settlements/${id}/pay`, { method: 'POST', body: { proof: proof.trim() } });

export const getCommissionBps = async (): Promise<number> =>
  (await request<{ bps: number }>('/settings/commission-bps')).bps;

export const setCommissionBps = (bps: number) => request('/settings/commission-bps', { method: 'PUT', body: { bps } });
