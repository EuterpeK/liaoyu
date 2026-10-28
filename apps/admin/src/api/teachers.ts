import { request } from './http.ts';

export type TeacherStatus = 'pending' | 'active' | 'rejected' | 'disabled';

export interface TeacherRow {
  userId: number;
  displayName: string;
  realName: string;
  intro: string;
  directions: string[];
  credentials: string[];
  level: number;
  status: TeacherStatus;
  createdAt: string;
  reviewedAt: string | null;
}

export const listTeachers = (status?: TeacherStatus) => request<TeacherRow[]>('/teachers', { query: { status } });

export const reviewTeacher = (userId: number, body: { approve: true; level: number } | { approve: false }) =>
  request(`/teachers/${userId}/review`, { method: 'POST', body });
