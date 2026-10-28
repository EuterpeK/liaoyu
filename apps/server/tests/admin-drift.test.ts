import { describe, expect, test } from 'vitest';
import { ACTIONS } from '../../admin/src/permissions.ts';
import { MATRIX } from './admin-matrix.ts';

describe('前后端权限表一致', () => {
  test('动作集合相同', () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(Object.keys(MATRIX).sort());
  });
  test('每个动作的角色集合相同（super 恒在内）', () => {
    for (const [action, row] of Object.entries(MATRIX)) {
      const front = [...ACTIONS[action as keyof typeof ACTIONS]].sort();
      expect(front, action).toEqual([...row.roles].sort());
    }
  });
});
