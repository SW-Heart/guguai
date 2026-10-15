import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { sharedReactRuntime, assertSharedReactBundle } from '../shared/react-runtime.mjs';

const runtime = await sharedReactRuntime();

const result = await build({
  absWorkingDir: fileURLToPath(new URL('../../', import.meta.url)),
  entryPoints: ['scripts/ui/create-project-entry.jsx'],
  outfile: 'public/vendor/ui/create-project.js',
  metafile: true, plugins: [runtime.plugin],
  bundle: true, format: 'esm', platform: 'browser', target: ['es2020'],
  jsx: 'automatic', minify: true, legalComments: 'eof',
  define: { 'process.env.NODE_ENV': '"production"' },
});

assertSharedReactBundle(result, runtime.url);
