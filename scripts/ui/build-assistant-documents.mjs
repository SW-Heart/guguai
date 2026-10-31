import { build } from 'esbuild';
import { mkdir, copyFile, cp, writeFile } from 'node:fs/promises';
await mkdir('public/vendor/documents', {recursive:true});
await build({stdin:{contents:"import mammoth from 'mammoth/mammoth.browser.js'; export const extractRawText = mammoth.extractRawText;",resolveDir:process.cwd()},outfile:'public/vendor/documents/word.js',bundle:true,format:'esm',platform:'browser',minify:true,legalComments:'eof'});
await copyFile('node_modules/pdfjs-dist/legacy/build/pdf.min.mjs','public/vendor/documents/pdf.js');
await copyFile('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs','public/vendor/documents/pdf.worker.js');

await cp('node_modules/pdfjs-dist/cmaps','public/vendor/documents/cmaps',{recursive:true});
await cp('node_modules/pdfjs-dist/standard_fonts','public/vendor/documents/standard_fonts',{recursive:true});
await copyFile('node_modules/pdfjs-dist/LICENSE','public/vendor/documents/LICENSE.pdfjs');
await copyFile('node_modules/mammoth/LICENSE','public/vendor/documents/LICENSE.mammoth');

await writeFile('public/vendor/documents/word.worker.js', `import { extractRawText } from './word.js?v=1';
self.onmessage=async event=>{
  try{self.postMessage({result:await extractRawText({arrayBuffer:event.data})});}
  catch{self.postMessage({error:true});}
};
`);
