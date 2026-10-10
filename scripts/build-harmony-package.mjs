import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const output = resolve(root, 'dist/ohpm');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

// Keep dynamic TS/JS implementation details on the JS side of the ArkTS boundary.
// Downlevel syntax without claiming to polyfill runtime APIs such as AggregateError.
const result = await build({
  absWorkingDir: root,
  entryPoints: {
    'core/index': 'src/core/index.ts',
    'harmony/index': 'src/harmony/index.ts',
  },
  outdir: output,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2017',
  chunkNames: 'shared/[name]-[hash]',
  sourcemap: true,
  metafile: true,
});

// A local OHPM install must not need npm's optional framework peers.
for (const artifact of Object.values(result.metafile.outputs)) {
  for (const dependency of artifact.imports) {
    if (dependency.external) {
      throw new Error(`Unexpected external dependency in OHPM package: ${dependency.path}`);
    }
  }
}

for (const module of ['core', 'harmony']) {
  await cp(resolve(root, `dist/types/${module}`), resolve(output, `types/${module}`), {
    recursive: true,
  });
}
await cp(resolve(root, 'LICENSE'), resolve(output, 'LICENSE'));
await cp(resolve(root, 'docs'), resolve(output, 'docs'), { recursive: true });
await cp(resolve(root, 'examples/harmony-counter'), resolve(output, 'examples/harmony-counter'), {
  recursive: true,
});

await writeFile(
  resolve(output, 'oh-package.json5'),
  `${JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      description:
        'ViewModel core and an explicit callback/lifecycle bridge for HarmonyOS ArkUI hosts.',
      main: './harmony/index.js',
      types: './types/harmony/index.d.ts',
      license: manifest.license,
      dependencies: {},
    },
    null,
    2,
  )}\n`,
);
await writeFile(
  resolve(output, 'README.md'),
  `# view_model for HarmonyOS\n\n` +
    `Local OHPM package generated from @lwjlol/view_model ${manifest.version}.\n\n` +
    `The package root exports the core API and the Harmony callback/lifecycle adapter. ` +
    `It contains ESM JavaScript with ES2017 syntax, TypeScript declarations, and no framework dependencies. ` +
    `Runtime built-ins still need validation on the selected HarmonyOS SDK/device.\n\n` +
    `- [Integration guide](./docs/harmony.md)\n` +
    `- [中文集成文档](./docs/zh/harmony.md)\n` +
    `- [ArkUI counter example](./examples/harmony-counter/README.md)\n\n` +
    `This is a source/JavaScript OHPM package, not a DevEco-built HAR. ` +
    `Node package tests do not validate the ArkTS compiler or device runtime.\n`,
);
console.log('Harmony OHPM package: dist/ohpm');
