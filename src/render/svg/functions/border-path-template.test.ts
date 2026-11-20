import path from 'path';
import { expect, describe, it } from 'vitest';
import { TextTemplate } from '../../../common';

/**
 * Guards the production border-path template contract.
 *
 * `border-path.svg.tpl` must honor BOTH `style` ({{STYLE}}) and `meta`
 * ({{META}}). A prior edit dropped {{STYLE}}, which silently discarded every
 * inline `style:` substitution — including the `fill: none` that keeps
 * stranded open chains stroke-only and the neutral layer's invisibility —
 * because TextTemplate removes unset tokens without warning.
 */
describe('border-path.svg.tpl', () => {
  for (const theme of ['dark', 'light'] as const) {
    it(`preserves style and meta substitutions (${theme})`, () => {
      const templatePath = path.join(__dirname, '../templates/', theme);
      const edgeTemplate = new TextTemplate('border-path.svg.tpl', templatePath);
      const out = edgeTemplate.replace({
        d: 'M0,0 L10,0 L10,10 Z',
        style: 'fill: none',
        meta: 'data-test="1"',
      });
      expect(out).toContain('style="fill: none"');
      expect(out).toContain('data-test="1"');
      expect(out).toContain('M0,0 L10,0 L10,10 Z');
      expect(out).not.toContain('{{');
    });

    it(`drops no tokens when style is empty (${theme})`, () => {
      const templatePath = path.join(__dirname, '../templates/', theme);
      const edgeTemplate = new TextTemplate('border-path.svg.tpl', templatePath);
      const out = edgeTemplate.replace({ d: 'M0,0 L1,1', style: '' });
      expect(out).not.toContain('{{');
      expect(out).toContain('<path');
    });
  }
});
