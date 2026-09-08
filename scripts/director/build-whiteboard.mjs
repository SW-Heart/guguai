// Rebuild the exact engine used by the reference application, without its shell/runtime.
// Usage: node scripts/director/build-whiteboard.mjs /path/to/reference/apps/desktop-global
import { createRequire } from 'node:module';
import path from 'node:path';
const reference=path.resolve(process.argv[2]||'.');
const require=createRequire(path.join(reference,'package.json'));
const esbuild=require('esbuild');
await esbuild.build({entryPoints:['scripts/director/whiteboard-entry.js'],bundle:true,format:'esm',minify:true,outfile:'public/vendor/director/whiteboard.js',nodePaths:[path.join(reference,'node_modules')],define:{'process.env.NODE_ENV':'"production"'},legalComments:'eof'});
