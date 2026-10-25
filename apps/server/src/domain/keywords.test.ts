import { describe, expect, test } from 'vitest';
import { scanText } from './keywords.ts';

describe('关键词扫描', () => {
  test('危机词、私下交易词与手机号', () => {
    expect(scanText('我真的不想活了')).toEqual({ crisis: '不想活', privateTrade: null });
    expect(scanText('加我微信吧')).toEqual({ crisis: null, privateTrade: '微信' });
    expect(scanText('打我电话13812345678')).toEqual({ crisis: null, privateTrade: '13812345678' });
    expect(scanText('加个VX')).toEqual({ crisis: null, privateTrade: 'vx' });
    expect(scanText('今天心情不错')).toEqual({ crisis: null, privateTrade: null });
  });
});
