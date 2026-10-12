import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('../../', import.meta.url)),
  entryPoints: ['scripts/ui/create-project-entry.jsx'],
  outfile: 'public/vendor/ui/create-project.js',
  bundle: true, format: 'esm', platform: 'browser', target: ['es2020'],
  jsx: 'automatic', minify: true, legalComments: 'eof',
  define: { 'process.env.NODE_ENV': '"production"' },
});
