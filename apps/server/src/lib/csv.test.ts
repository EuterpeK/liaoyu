import { describe, expect, test } from 'vitest';
import { csvCell, toCsv } from './csv.ts';

describe('csv', () => {
  test('转义引号/逗号/换行，阻止公式注入，BOM 开头', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('x\ny')).toBe('"x\ny"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    for (const s of ['+1', '-1', '@a']) expect(csvCell(s)).toBe(`'${s}`);
    expect(csvCell(null)).toBe('');
    expect(csvCell(30)).toBe('30');
    expect(toCsv(['a', 'b'], [[1, 'x,y']])).toBe('\ufeffa,b\n1,"x,y"\n');
  });
});
