import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const manifest = require('../package.json');
assert.equal(
  Object.keys(manifest.dependencies ?? {}).length,
  0,
  'Core must have no required framework dependencies',
);
for (const peer of ['react', 'react-native', 'electron', 'vue', '@tarojs/taro']) {
  assert.equal(manifest.peerDependenciesMeta[peer].optional, true, `${peer} must remain opt-in`);
}
const esmCore = await import('../dist/core/index.js');
const esmElectron = await import('../dist/electron/index.js');
const cjsCore = require('../dist/core/index.cjs');
const cjsElectron = require('../dist/electron/index.cjs');

assert.equal(esmCore.ViewModel, esmElectron.ViewModel, 'ESM 平台入口必须复用 ESM core');
assert.equal(cjsCore.ViewModel, cjsElectron.ViewModel, 'CJS 平台入口必须复用 CJS core');

class CjsViewModel extends cjsCore.ViewModel {}
const cjsSpec = cjsCore.viewModelSpec(() => new CjsViewModel());
const esmRuntime = new esmCore.ViewModelRuntime();
const esmBinding = esmRuntime.createBinding();
assert.ok(
  esmBinding.read(cjsSpec) instanceof CjsViewModel,
  'ESM Runtime 必须能解析 CJS ViewModelSpec',
);
esmRuntime.dispose();

class EsmViewModel extends esmCore.ViewModel {}
const esmSpec = esmCore.viewModelSpec(() => new EsmViewModel());
const cjsRuntime = new cjsCore.ViewModelRuntime();
const cjsBinding = cjsRuntime.createBinding();
assert.ok(
  cjsBinding.read(esmSpec) instanceof EsmViewModel,
  'CJS Runtime 必须能解析 ESM ViewModelSpec',
);
cjsRuntime.dispose();

class CrossConditionViewModel extends esmCore.ViewModel {}
const esmTypedSpec = esmCore.viewModelSpec(
  CrossConditionViewModel,
  () => new CrossConditionViewModel(),
  { key: 'cross-condition-type' },
);
const cjsTypedSpec = cjsCore.viewModelSpec(
  CrossConditionViewModel,
  () => new CrossConditionViewModel(),
  { key: 'cross-condition-type' },
);
const crossConditionRuntime = new esmCore.ViewModelRuntime();
const firstTypedBinding = crossConditionRuntime.createBinding();
const secondTypedBinding = crossConditionRuntime.createBinding();
assert.equal(
  firstTypedBinding.read(esmTypedSpec),
  secondTypedBinding.read(cjsTypedSpec),
  'ESM/CJS Specs 必须按相同显式 type + key 共享 generation',
);
crossConditionRuntime.dispose();

const esmVue = await import('@lwjlol/view_model/vue');
const cjsVue = require('@lwjlol/view_model/vue');
assert.equal(esmVue.ViewModel, esmCore.ViewModel);
assert.equal(cjsVue.ViewModel, cjsCore.ViewModel);

// Stub only the optional host hooks; preserve the actual built Vue/core imports.
const temporary = await mkdtemp(join(tmpdir(), 'view-model-exports-'));
try {
  for (const [format, extension, vue] of [
    ['esm', '.js', esmVue],
    ['cjs', '.cjs', cjsVue],
  ]) {
    const output = join(temporary, format === 'esm' ? 'taro.mjs' : 'taro.cjs');
    await build({
      entryPoints: [resolve(`dist/taro-vue/index${extension}`)],
      outfile: output,
      bundle: true,
      platform: 'node',
      format,
      plugins: [
        {
          name: 'optional-taro-host',
          setup(builder) {
            builder.onResolve({ filter: /^@tarojs\/taro$/ }, () => ({
              path: 'hooks',
              namespace: 'host',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'host' }, () => ({
              contents:
                'export const useDidShow = () => {}; export const useDidHide = () => {}; export const useUnload = () => {};',
            }));
            builder.onResolve({ filter: /^(vue|\.\.\/(vue|core)\/index\.(js|cjs))$/ }, (args) => ({
              path:
                args.path === 'vue' ? require.resolve('vue') : resolve(args.resolveDir, args.path),
              external: true,
            }));
          },
        },
      ],
    });
    const taro = format === 'esm' ? await import(pathToFileURL(output).href) : require(output);
    assert.equal(taro.ViewModel, vue.ViewModel, `${format} Taro must reuse core`);
    assert.equal(
      taro.useViewModelScope,
      vue.useViewModelScope,
      `${format} Taro must reuse Vue context`,
    );
    assert.equal(typeof taro.useTaroViewModelScope, 'function');
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log('package exports: ok');
