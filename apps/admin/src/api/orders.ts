import { buildQuery, request } from './http.ts';

export interface OrderFilter {
  userId?: number | string;
  teacherId?: number | string;
  status?: 'pending' | 'paid' | '';
  from?: string;
  to?: string;
}

export interface OrderRow {
  outTradeNo: string;
  userId: number;
  userNickname: string;
  teacherId: number;
  teacherName: string;
  packageTitle: string;
  amountCents: number;
  status: 'pending' | 'paid';
  tradeNo: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface OrderSummary {
  orderCount: number;
  paidCount: number;
  revenueCents: number;
  buyerCount: number;
}

export interface Page {
  page: number;
  pageSize: number;
}

const filterQuery = (f: OrderFilter) => ({
  status: f.status || undefined,
  userId: f.userId === '' ? undefined : f.userId,
  teacherId: f.teacherId === '' ? undefined : f.teacherId,
  from: f.from || undefined,
  to: f.to || undefined,
});

export const listOrders = (f: OrderFilter, p: Page) =>
  request<OrderRow[]>('/orders', {
    query: { ...filterQuery(f), limit: p.pageSize, offset: (p.page - 1) * p.pageSize },
  });

export const countOrders = async (f: OrderFilter): Promise<number> =>
  (await request<{ total: number }>('/orders/count', { query: filterQuery(f) })).total;

export const orderSummary = (f: OrderFilter = {}) =>
  request<OrderSummary>('/orders/summary', { query: filterQuery(f) });

export const exportUrl = (f: OrderFilter): string => `/api/admin/orders.csv${buildQuery(filterQuery(f))}`;
