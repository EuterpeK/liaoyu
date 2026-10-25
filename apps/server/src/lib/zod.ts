import { z } from 'zod';

export const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
export const IdParam = z.coerce.number().int().positive();
