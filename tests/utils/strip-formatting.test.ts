import { describe, expect, it } from 'vitest';

import { stripFormatting } from '../../src/utils/strip-formatting';

describe('stripFormatting', () => {
  it('removes bold', () => {
    expect(stripFormatting('\x02bold\x02')).toBe('bold');
  });

  it('removes color with code', () => {
    expect(stripFormatting('\x0304red text\x03')).toBe('red text');
  });

  it('removes color with fg,bg codes', () => {
    expect(stripFormatting('\x0304,12red on blue\x03')).toBe('red on blue');
  });

  it('removes bare color reset', () => {
    expect(stripFormatting('\x03text')).toBe('text');
  });

  it('removes italic', () => {
    expect(stripFormatting('\x1Ditalic\x1D')).toBe('italic');
  });

  it('removes underline', () => {
    expect(stripFormatting('\x1Funderline\x1F')).toBe('underline');
  });

  it('removes strikethrough', () => {
    expect(stripFormatting('\x1Estrike\x1E')).toBe('strike');
  });

  it('removes monospace', () => {
    expect(stripFormatting('\x11mono\x11')).toBe('mono');
  });

  it('removes reset', () => {
    expect(stripFormatting('text\x0F')).toBe('text');
  });

  it('removes reverse', () => {
    expect(stripFormatting('\x16reverse\x16')).toBe('reverse');
  });

  it('leaves plain text unchanged', () => {
    expect(stripFormatting('hello world')).toBe('hello world');
  });

  it('removes multiple mixed codes', () => {
    expect(stripFormatting('\x02\x0304bold red\x03\x02 plain')).toBe('bold red plain');
  });

  it('does not remove \r\n (that is sanitize territory)', () => {
    expect(stripFormatting('line1\nline2')).toBe('line1\nline2');
  });

  it('handles empty string', () => {
    expect(stripFormatting('')).toBe('');
  });

  it('handles nick with embedded color code', () => {
    // Typical attack: attacker nicks contain control codes to disguise messages
    const maliciousNick = 'admin\x0304\x03';
    expect(stripFormatting(maliciousNick)).toBe('admin');
  });
});
