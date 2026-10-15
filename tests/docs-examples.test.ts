import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it.each(['docs/dependency-injection.md', 'docs/zh/dependency-injection.md'])(
  '%s selector listener example typechecks',
  (path) => {
    const markdown = readFileSync(resolve(path), 'utf8');
    const example = markdown.match(
      /```ts\n(protected override onCreate\(\): void \{[\s\S]*?\n\})\n```/,
    )?.[1];
    expect(example).toContain('listenStateSelect');
    const file = resolve('tests/documentation-example.ts');
    const source = `
    import { StateViewModel, ViewModel, viewModelSpec } from '../src/core/index.js';
    class Connectivity extends StateViewModel<{ online: boolean }> {
      constructor() { super({ online: false }); }
    }
    const connectivitySpec = viewModelSpec(Connectivity, () => new Connectivity());
    class Parent extends ViewModel {
      ${example}
      private reconcileConnectivity(_previous: boolean, _current: boolean): void {}
    }
  `;
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    };
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
      name === file
        ? ts.createSourceFile(name, source, languageVersion, true)
        : original(name, languageVersion, onError, shouldCreateNewSourceFile);
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([file], options, host));
    expect(
      diagnostics.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, '\n')),
    ).toEqual([]);
  },
);
