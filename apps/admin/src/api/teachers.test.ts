import { afterEach, describe, expect, test, vi } from 'vitest';
import { listTeachers, reviewTeacher } from './teachers.ts';

afterEach(() => vi.unstubAllGlobals());

const stub = () => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]')));
const call = (i = 0) => (fetch as ReturnType<typeof vi.fn>).mock.calls[i];

describe('teachers api', () => {
  test('批准带等级，驳回不带', async () => {
    stub();
    await reviewTeacher(7, { approve: true, level: 3 });
    await reviewTeacher(8, { approve: false });
    expect(call(0)[0]).toBe('/api/admin/teachers/7/review');
    expect(call(0)[1].method).toBe('POST');
    expect(call(0)[1].body).toBe('{"approve":true,"level":3}');
    expect(call(1)[1].body).toBe('{"approve":false}');
  });

  test('listTeachers 可按状态过滤', async () => {
    stub();
    await listTeachers('pending');
    expect(call(0)[0]).toBe('/api/admin/teachers?status=pending');
    stub();
    await listTeachers();
    expect(call(0)[0]).toBe('/api/admin/teachers');
  });
});
