import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import plugin, { type ViewModelLintRule } from '../../src/eslint/index.js';
import { lint } from './lint.js';

interface RuleExamples {
  readonly rule: ViewModelLintRule;
  readonly bad: string;
  readonly good: string;
}

const MARKERS = { bad: ['**Bad**', '**错误示例**'], good: ['**Good**', '**正确示例**'] };

function firstBlockAfter(section: string, markers: readonly string[]): string {
  const start = Math.max(...markers.map((marker) => section.indexOf(marker)));
  const block = section.slice(start).match(/```tsx\n([\s\S]*?)```/)?.[1];
  if (start < 0 || block === undefined) throw new Error(`Missing ${markers[0]} example`);
  return block;
}

/** Shared declarations plus the Bad/Good examples of every rule section. */
function examples(path: string): { shared: string; rules: RuleExamples[] } {
  const markdown = readFileSync(resolve(import.meta.dirname, '../..', path), 'utf8');
  const sections = markdown.split('\n## ');
  const sharedSection = sections.find((section) => /^(Shared declarations|共享声明)/.test(section));
  const shared = sharedSection?.match(/```tsx\n([\s\S]*?)```/)?.[1];
  if (shared === undefined) throw new Error(`${path} has no shared declarations`);
  const rules = sections.flatMap((section) => {
    const rule = section.match(/^`([a-z-]+)`\n/)?.[1] as ViewModelLintRule | undefined;
    if (rule === undefined) return [];
    return [
      {
        rule,
        bad: firstBlockAfter(section, MARKERS.bad),
        good: firstBlockAfter(section, MARKERS.good),
      },
    ];
  });
  return { shared, rules };
}

// Examples import the published entries; tests resolve them to the sources.
function source(shared: string, example: string): string {
  return `${shared}\n${example}`
    .replaceAll("'@lwjlol/view_model/core'", "'../../../src/core/index.js'")
    .replaceAll("'@lwjlol/view_model/react-native'", "'../../../src/react-native/index.js'");
}

describe.each(['docs/lint.md', 'docs/zh/lint.md'])('%s', (path) => {
  const { shared, rules } = examples(path);

  it('documents every rule', () => {
    expect(rules.map((entry) => entry.rule).sort()).toEqual(Object.keys(plugin.rules).sort());
  });

  it.each(rules)('$rule examples', ({ rule, bad, good }) => {
    const badMessages = lint(rule, source(shared, bad), { extension: 'tsx' });
    const goodMessages = lint(rule, source(shared, good), { extension: 'tsx' });
    expect(badMessages.filter((message) => message.fatal)).toEqual([]);
    expect(goodMessages.filter((message) => message.fatal)).toEqual([]);
    expect(badMessages.some((message) => message.ruleId === `view-model/${rule}`)).toBe(true);
    expect(goodMessages.filter((message) => message.ruleId === `view-model/${rule}`)).toEqual([]);
  });
});
