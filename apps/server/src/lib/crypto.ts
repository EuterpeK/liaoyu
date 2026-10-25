import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';

export function encryptField(keyB64: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, Buffer.from(keyB64, 'base64'), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptField(keyB64: string, payload: string): string {
  const [version, iv, tag, data] = payload.split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('密文格式错误');
  const decipher = createDecipheriv(ALGO, Buffer.from(keyB64, 'base64'), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
