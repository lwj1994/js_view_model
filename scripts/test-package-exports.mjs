import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
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

console.log('package exports: ok');
