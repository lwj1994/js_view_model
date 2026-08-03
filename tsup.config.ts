import type { Plugin } from 'esbuild';
import { defineConfig, type Options } from 'tsup';

const platformEntries = {
  'react-native/index': 'src/react-native/index.ts',
  'electron/index': 'src/electron/index.ts',
};

const shared: Options = {
  sourcemap: true,
  clean: false,
  splitting: false,
  treeshake: true,
  target: 'es2022',
};

/**
 * Platform entries must reuse the core entry instead of bundling another
 * public ViewModel copy. This preserves constructor identity between the core
 * and platform imports within each module condition.
 */
function externalCore(extension: '.js' | '.cjs'): Plugin {
  return {
    name: `external-view-model-core-${extension}`,
    setup(build) {
      build.onResolve({ filter: /^\.\.\/core\/index\.js$/ }, () => ({
        path: `../core/index${extension}`,
        external: true,
      }));
    },
  };
}

export default defineConfig([
  {
    ...shared,
    entry: { 'core/index': 'src/core/index.ts' },
    format: ['esm', 'cjs'],
    dts: false,
    outExtension({ format }) {
      return { js: format === 'cjs' ? '.cjs' : '.js' };
    },
  },
  {
    ...shared,
    entry: platformEntries,
    format: ['esm'],
    dts: false,
    external: ['electron', 'react', 'react/jsx-runtime', 'react-native'],
    esbuildPlugins: [externalCore('.js')],
  },
  {
    ...shared,
    entry: platformEntries,
    format: ['cjs'],
    dts: false,
    external: ['electron', 'react', 'react/jsx-runtime', 'react-native'],
    esbuildPlugins: [externalCore('.cjs')],
    outExtension: () => ({ js: '.cjs' }),
  },
]);
