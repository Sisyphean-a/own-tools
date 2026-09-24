import esbuild from 'esbuild';
import { resolve } from 'node:path';

await esbuild.build({
  entryPoints: ['test/selection-lock.test.ts', 'test/ai.test.ts'],
  outdir: '../../.tmp',
  entryNames: 'obsidian-ai-rewrite-[name].test',
  outExtension: { '.js': '.mjs' },
  platform: 'node',
  format: 'esm',
  bundle: true,
  plugins: [{
    name: 'mock-obsidian',
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: resolve('test/obsidian-stub.ts') }));
    },
  }],
});
