import { expect, describe, it } from 'vitest';
import { sanitizeCssColor } from './sanitize-css-color';

describe('sanitizeCssColor', () => {
  it('passes through valid 6-digit hex colors', () => {
    expect(sanitizeCssColor('#EC2027')).toBe('#EC2027');
    expect(sanitizeCssColor('#1861A3')).toBe('#1861A3');
    expect(sanitizeCssColor('#FF00FF')).toBe('#FF00FF');
  });

  it('passes through valid 3-digit hex colors', () => {
    expect(sanitizeCssColor('#FFF')).toBe('#FFF');
    expect(sanitizeCssColor('#000')).toBe('#000');
  });

  it('is case-insensitive', () => {
    expect(sanitizeCssColor('#ec2027')).toBe('#ec2027');
    expect(sanitizeCssColor('#EC2027')).toBe('#EC2027');
  });

  it('strips whitespace and newlines from valid colors', () => {
    expect(sanitizeCssColor(' #EC2027 ')).toBe('#EC2027');
    expect(sanitizeCssColor('\n#EC2027')).toBe('#EC2027');
    expect(sanitizeCssColor('#EC2027\n')).toBe('#EC2027');
    expect(sanitizeCssColor('\t#EC2027\t')).toBe('#EC2027');
  });

  it('strips embedded newlines from multi-line CSV values (CIZ2B case)', () => {
    // Simulates the CSV value for CIZ2B: newline embedded in quoted field
    expect(sanitizeCssColor('\n#ff9e00')).toBe('#ff9e00');
    expect(sanitizeCssColor('#ff9e00\n')).toBe('#ff9e00');
    expect(sanitizeCssColor('\n#ff9e00\n')).toBe('#ff9e00');
  });

  it('returns fallback for empty string', () => {
    expect(sanitizeCssColor('')).toBe('#999999');
    expect(sanitizeCssColor('   ')).toBe('#999999');
    expect(sanitizeCssColor('\n')).toBe('#999999');
  });

  it('returns fallback for null/undefined', () => {
    expect(sanitizeCssColor(null as unknown as string)).toBe('#999999');
    expect(sanitizeCssColor(undefined as unknown as string)).toBe('#999999');
  });

  it('returns fallback for invalid hex colors', () => {
    expect(sanitizeCssColor('red')).toBe('#999999');
    expect(sanitizeCssColor('rgb(255, 0, 0)')).toBe('#999999');
    expect(sanitizeCssColor('#GGGGGG')).toBe('#999999');
    expect(sanitizeCssColor('#12345')).toBe('#999999'); // 5 digits
    expect(sanitizeCssColor('#1234567')).toBe('#999999'); // 7 digits
    expect(sanitizeCssColor('#12')).toBe('#999999'); // 2 digits
  });

  it('uses custom fallback when provided', () => {
    expect(sanitizeCssColor('', '#000000')).toBe('#000000');
    expect(sanitizeCssColor('invalid', '#FF0000')).toBe('#FF0000');
  });
});
