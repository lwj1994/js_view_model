import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'view-model-ohpm-'));
try {
  const installed = join(temporary, 'installed');
  await cp(resolve(root, 'dist/ohpm'), installed, { recursive: true });
  // This is a Node test harness, not metadata required by OHPM.
  await writeFile(join(temporary, 'package.json'), '{"type":"module"}\n');
  const ohPackage = JSON.parse(await readFile(join(installed, 'oh-package.json5'), 'utf8'));
  assert.equal(ohPackage.name, manifest.name);
  assert.equal(ohPackage.version, manifest.version);
  assert.deepEqual(ohPackage.dependencies, {});
  assert.ok((await readFile(resolve(installed, ohPackage.types), 'utf8')).includes('ViewModel'));

  // Import outside the repository so missing artifacts cannot resolve from its node_modules.
  const harmony = await import(pathToFileURL(resolve(installed, ohPackage.main)).href);
  const core = await import(pathToFileURL(join(installed, 'core/index.js')).href);
  assert.equal(harmony.ViewModel, core.ViewModel, 'OHPM entries must share one core instance');
  const runtime = new core.ViewModelRuntime();
  class Counter extends core.ViewModel {
    count = 0;
    increment() {
      this.count += 1;
      this.notifyListeners();
    }
  }
  const spec = core.viewModelSpec(Counter, () => new Counter());
  const published = [];
  const scope = harmony.createViewModelHarmonyScope({
    runtime,
    onUpdate: () => published.push(scope.watch(spec).count),
  });
  const first = scope.watch(spec);
  first.increment();
  assert.deepEqual(published, [1]);
  runtime.recycle(spec);
  assert.deepEqual(published, [1, 0]);
  assert.notEqual(scope.read(spec), first);
  scope.dispose();
  assert.equal(runtime.isDisposed, false);
  runtime.dispose();

  // Compile the actual TS facade against the installed package, without rewriting imports.
  const example = join(temporary, 'counter.mjs');
  await build({
    entryPoints: [
      resolve(root, 'examples/harmony-counter/src/main/ets/viewmodel/CounterFacade.ts'),
    ],
    outfile: example,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2017',
    alias: { '@lwjlol/view_model': resolve(installed, ohPackage.main) },
  });
  const { CounterFacade } = await import(pathToFileURL(example).href);
  const snapshots = [];
  const facade = new CounterFacade((snapshot) => snapshots.push(snapshot.count));
  assert.equal(facade.getSnapshot().count, 0);
  facade.increment();
  assert.equal(facade.getSnapshot().count, 1);
  facade.recycle();
  assert.equal(facade.getSnapshot().count, 0);
  assert.deepEqual(snapshots, [1, 0]);
  facade.dispose();
  assert.equal(facade.isDisposed, true);
  facade.dispose();
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log('OHPM artifact and TS facade: ok (ArkTS SDK/device validation is separate)');
