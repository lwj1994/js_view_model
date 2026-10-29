import { resolve } from 'node:path';

import * as parser from '@typescript-eslint/parser';
import { Linter } from 'eslint';

import plugin, { type ViewModelLintRule } from '../../src/eslint/index.js';

const root = resolve(import.meta.dirname, '../..');

function config(rules: readonly ViewModelLintRule[]): Linter.Config[] {
  return [
    {
      files: ['**/*.ts', '**/*.tsx'],
      languageOptions: {
        parser,
        parserOptions: {
          projectService: {
            allowDefaultProject: [
              'tests/eslint/fixtures/case.ts',
              'tests/eslint/fixtures/case.tsx',
            ],
            defaultProject: 'tests/eslint/tsconfig.json',
          },
          tsconfigRootDir: root,
        },
      },
      plugins: { 'view-model': plugin },
      rules: Object.fromEntries(rules.map((rule) => [`view-model/${rule}`, 'warn'])),
    },
  ];
}

// Cases reuse one in-memory file per extension next to the shared fixtures;
// the project service replaces its contents on every lint.
function filename(extension: 'ts' | 'tsx'): string {
  return resolve(root, `tests/eslint/fixtures/case.${extension}`);
}

export interface LintOptions {
  readonly extension?: 'ts' | 'tsx';
  /** Lint an existing fixture path instead of a fresh in-memory case. */
  readonly file?: string;
}

function target(options: LintOptions): string {
  return options.file === undefined
    ? filename(options.extension ?? 'ts')
    : resolve(root, 'tests/eslint/fixtures', options.file);
}

export function lint(
  rule: ViewModelLintRule,
  code: string,
  options: LintOptions = {},
): Linter.LintMessage[] {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(code, config([rule]), target(options));
}

/** The reported source text of each diagnostic, for compact assertions. */
export function reported(
  rule: ViewModelLintRule,
  code: string,
  options: LintOptions = {},
): string[] {
  const lines = code.split('\n');
  return lint(rule, code, options).map((message) => {
    if (message.ruleId !== `view-model/${rule}`) {
      throw new Error(`Unexpected message: ${message.ruleId ?? 'parser'} ${message.message}`);
    }
    const startLine = message.line - 1;
    const endLine = (message.endLine ?? message.line) - 1;
    if (startLine === endLine) {
      return lines[startLine]!.slice(message.column - 1, (message.endColumn ?? message.column) - 1);
    }
    return [
      lines[startLine]!.slice(message.column - 1),
      ...lines.slice(startLine + 1, endLine),
      lines[endLine]!.slice(0, (message.endColumn ?? 1) - 1),
    ].join('\n');
  });
}

export function fix(rule: ViewModelLintRule, code: string, options: LintOptions = {}): string {
  const linter = new Linter({ configType: 'flat' });
  return linter.verifyAndFix(code, config([rule]), target(options)).output;
}

/** The code after applying the first suggestion of every diagnostic, one at a time. */
export function suggest(rule: ViewModelLintRule, code: string, options: LintOptions = {}): string {
  const messages = lint(rule, code, options);
  const fixes = messages.flatMap((message) => message.suggestions?.[0]?.fix ?? []);
  return fixes
    .sort((left, right) => right.range[0] - left.range[0])
    .reduce(
      (text, fixToApply) =>
        text.slice(0, fixToApply.range[0]) + fixToApply.text + text.slice(fixToApply.range[1]),
      code,
    );
}
