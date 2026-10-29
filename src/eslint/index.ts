import type { ESLint, Linter, Rule } from 'eslint';

import { RULE_KINDS, type RuleKind } from './analysis.js';
import { RULE_DEFINITIONS, createRule } from './rules.js';

export type ViewModelLintRule = RuleKind;

export interface ViewModelLintPlugin extends ESLint.Plugin {
  readonly meta: { readonly name: string; readonly version: string };
  readonly rules: Readonly<Record<ViewModelLintRule, Rule.RuleModule>>;
  readonly configs: {
    /** Every default warning, registered under the `view-model` plugin namespace. */
    readonly recommended: Linter.Config;
  };
}

const rules = Object.fromEntries(RULE_KINDS.map((kind) => [kind, createRule(kind)])) as Record<
  RuleKind,
  Rule.RuleModule
>;

const configs = {} as { recommended: Linter.Config };

/**
 * Type-aware ESLint rules for view_model usage. Every rule needs
 * typescript-eslint type information (`parserOptions.projectService`).
 */
const plugin: ViewModelLintPlugin = {
  meta: { name: '@lwjlol/view_model/eslint', version: '0.3.1' },
  rules,
  configs,
};

configs.recommended = {
  name: 'view-model/recommended',
  // Type-aware rules need typescript-eslint program information.
  files: ['**/*.{ts,tsx,mts,cts}'],
  plugins: { 'view-model': plugin },
  rules: Object.fromEntries(
    RULE_KINDS.filter((kind) => RULE_DEFINITIONS[kind].recommended).map((kind) => [
      `view-model/${kind}`,
      'warn',
    ]),
  ),
};

export default plugin;
