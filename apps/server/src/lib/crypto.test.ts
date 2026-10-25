import { describe, expect, test } from 'vitest';
import { decryptField, encryptField } from './crypto.ts';

const KEY = Buffer.alloc(32, 9).toString('base64');
const OTHER = Buffer.alloc(32, 8).toString('base64');

describe('字段加密', () => {
  test('加密后可解密，且同一明文每次密文不同', () => {
    const a = encryptField(KEY, '林某');
    const b = encryptField(KEY, '林某');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toContain('林某');
    expect(decryptField(KEY, a)).toBe('林某');
  });

  test('密文被篡改或密钥错误时解密失败', () => {
    const c = encryptField(KEY, '林某');
    const parts = c.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptField(KEY, parts.join(':'))).toThrow();
    expect(() => decryptField(OTHER, c)).toThrow();
  });
});
