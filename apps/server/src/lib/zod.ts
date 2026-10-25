import { z } from 'zod';

export const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
export const IdParam = z.coerce.number().int().positive();

export const HhMm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, '时间格式应为 HH:MM');
