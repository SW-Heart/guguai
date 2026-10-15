import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../package.json', import.meta.url));
const modules = {
  react: 'React',
  'react-dom': 'ReactDOM',
  'react-dom/client': 'ReactDOMClient',
  'react/jsx-runtime': 'JSXRuntime',
};

// Both independently built islands use this exact URL and therefore the same
// dispatcher. The content hash also changes when the installed React changes.
export async function sharedReactRuntime() {
  const result = await build({
    absWorkingDir: repo,
    stdin: { contents: Object.entries(modules).map(([id, name]) => `export * as ${name} from ${JSON.stringify(id)};`).join('\n'), resolveDir: repo },
    bundle: true, format: 'esm', platform: 'browser', target: ['es2020'],
    minify: true, write: false, metafile: true, legalComments: 'eof',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const contents = result.outputFiles[0].contents;
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 16);
  const filename = `runtime-${hash}.js`;
  const url = `../react/${filename}?v=${hash}`;
  await mkdir(path.join(repo, 'public/vendor/react'), { recursive: true });
  await writeFile(path.join(repo, 'public/vendor/react', filename), contents);
  return {
    url,
    plugin: {
      name: 'shared-react-runtime',
      setup(builder) {
        builder.onResolve({ filter: /^(?:react|react-dom)(?:\/.*)?$/ }, args => {
          if (!modules[args.path]) throw new Error(`Unsupported shared React entry: ${args.path}`);
          return { path: args.path, namespace: 'shared-react' };
        });
        builder.onLoad({ filter: /.*/, namespace: 'shared-react' }, args => {
          const names = Object.keys(require(args.path)).filter(name => name !== 'default' && name !== '__esModule');
          return { contents: `import { ${modules[args.path]} as runtime } from ${JSON.stringify(url)};\nexport default runtime.default;\n${names.map(name => `export const ${name} = runtime.${name};`).join('\n')}`, loader: 'js' };
        });
        builder.onResolve({ filter: /^\.\.\/react\/runtime-[a-f0-9]+\.js\?v=[a-f0-9]+$/ }, args => ({ path: args.path, external: true }));
      },
    },
  };
}

export function assertSharedReactBundle(result, url) {
  const embedded = Object.keys(result.metafile.inputs).filter(file => /(?:^|\/)node_modules\/(react|react-dom|scheduler)\//.test(file));
  if (embedded.length) throw new Error(`Consumer embedded React runtime: ${embedded.join(', ')}`);
  const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports);
  if (!imports.some(item => item.external && item.path === url)) throw new Error('Consumer is missing the shared React runtime');
}
