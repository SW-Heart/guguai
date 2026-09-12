// Bundle the reference project's Canvas React island without copying its shell.
// The Canvas source itself remains in reference-canvas; only application services
// are resolved through the local adapter shims.
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'

const repo = path.resolve(new URL('..', import.meta.url).pathname, '..')
const reference = path.resolve(process.argv[2] || '/Users/sunshuwen/Documents/ChatGPT/desktop-wujieai-global/wujie-ai')
const pnpmRoot = path.join(reference, 'node_modules', '.pnpm')
const packageRoots = existsSync(pnpmRoot)
  ? readdirSync(pnpmRoot).map(name => path.join(pnpmRoot, name, 'node_modules')).filter(existsSync)
  : []
const esbuildPackage = packageRoots.map(root => path.join(root, 'esbuild')).find(dir => existsSync(path.join(dir, 'package.json')))
if (!esbuildPackage) throw new Error(`Cannot find esbuild in ${reference}`)
const require = createRequire(path.join(esbuildPackage, 'package.json'))
const esbuild = require('esbuild')

const shims = path.join(repo, 'scripts/director/reference-canvas-shims')
const aliasPlugin = {
  name: 'director-reference-aliases',
  setup(build) {
    build.onResolve({ filter: /^react-i18next$/ }, () => ({ path: path.join(shims, 'react-i18next.ts') }))
    build.onResolve({ filter: /^@\// }, args => {
      const relative = args.path.slice(2)
      const direct = path.join(shims, relative)
      const candidates = [
        direct,
        `${direct}.tsx`,
        `${direct}.ts`,
        `${direct}.jsx`,
        `${direct}.js`,
        path.join(direct, 'index.tsx'),
        path.join(direct, 'index.ts'),
        path.join(direct, 'index.js'),
      ]
      const resolved = candidates.find(candidate => {
        try { return statSync(candidate).isFile() } catch { return false }
      })
      return resolved ? { path: resolved } : { path: direct }
    })
    build.onLoad({ filter: /\.(css)$/ }, () => ({ contents: 'export default ""', loader: 'js' }))
  },
}

const bundledCanvasJs = path.join(repo, 'public/vendor/director/reference-canvas.js')

await esbuild.build({
  entryPoints: [path.join(repo, 'scripts/director/reference-canvas-entry.tsx')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  outfile: bundledCanvasJs,
  nodePaths: packageRoots,
  plugins: [aliasPlugin],
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'eof',
  jsx: 'automatic',
  absWorkingDir: repo,
})

// The reference BubbleMenu hides itself when the ProseMirror selection is
// empty. In this editor, selecting a canvas text node is already the user's
// intent to edit it, so keep the formatting bar visible while that editor is
// active and let its controls work on the current cursor/selection.
const bundledJs = readFileSync(bundledCanvasJs, 'utf8')
const bubbleMenuProps =
  'className:"rich-text-bubble-menu bubble-menu",editor:n,appendTo:()=>document.getElementById("rich-text-html-element"),'
if (!bundledJs.includes(bubbleMenuProps)) {
  throw new Error('Unable to locate the reference rich-text BubbleMenu props')
}
writeFileSync(
  bundledCanvasJs,
  bundledJs.replace(
    bubbleMenuProps,
    'className:"rich-text-bubble-menu bubble-menu",editor:n,shouldShow:()=>!0,appendTo:()=>document.getElementById("rich-text-html-element"),',
  ),
)

const cleanCss = file => readFileSync(file, 'utf8')
  .replace(/^@import[^;]+;\s*/gm, '')
  .replace(/^@tailwind[^;]+;\s*/gm, '')

// The reference app's compiled stylesheet contains Tailwind's document-level
// reset (`html`, `body`, `:root`, `button`, etc.). This Canvas is mounted into
// the main GuGu page, so leaving those selectors global changes the typography
// and controls of every route. Scope normal rules to the Canvas host while
// keeping font-face/keyframe definitions global as inert resources.
const canvasScope = '.reference-canvas-host'
const splitSelectors = selectorList => {
  const selectors = []
  let start = 0
  let parenDepth = 0
  let bracketDepth = 0
  let quote = ''
  for (let i = 0; i < selectorList.length; i += 1) {
    const char = selectorList[i]
    if (quote) {
      if (char === quote && selectorList[i - 1] !== '\\') quote = ''
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '(') { parenDepth += 1; continue }
    if (char === ')') { parenDepth = Math.max(0, parenDepth - 1); continue }
    if (char === '[') { bracketDepth += 1; continue }
    if (char === ']') { bracketDepth = Math.max(0, bracketDepth - 1); continue }
    if (char === ',' && parenDepth === 0 && bracketDepth === 0) {
      selectors.push(selectorList.slice(start, i))
      start = i + 1
    }
  }
  selectors.push(selectorList.slice(start))
  return selectors
}

const scopeSelector = selector => {
  const leading = selector.match(/^\s*/)?.[0] || ''
  const trailing = selector.match(/\s*$/)?.[0] || ''
  let value = selector.trim()
    .replace(/\bhtml\b/g, canvasScope)
    .replace(/:host\b/g, canvasScope)
    .replace(/\bbody\b/g, canvasScope)
    .replace(/:root\b/g, canvasScope)
  if (value === canvasScope || value.startsWith(`${canvasScope}:`) || value.startsWith(`${canvasScope} `)) {
    return `${leading}${value}${trailing}`
  }
  return `${leading}${value.startsWith(':') ? canvasScope : `${canvasScope} `}${value}${trailing}`
}

const findBlockEnd = (css, openIndex) => {
  let depth = 1
  let quote = ''
  let comment = false
  for (let i = openIndex + 1; i < css.length; i += 1) {
    const char = css[i]
    const next = css[i + 1]
    if (comment) {
      if (char === '*' && next === '/') { comment = false; i += 1 }
      continue
    }
    if (quote) {
      if (char === quote && css[i - 1] !== '\\') quote = ''
      continue
    }
    if (char === '/' && next === '*') { comment = true; i += 1; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '{') depth += 1
    if (char === '}' && --depth === 0) return i
  }
  throw new Error('Unclosed CSS block in reference Canvas stylesheet')
}

const scopeCanvasCss = css => {
  let output = ''
  let cursor = 0
  while (cursor < css.length) {
    const open = css.indexOf('{', cursor)
    if (open === -1) { output += css.slice(cursor); break }
    const prelude = css.slice(cursor, open)
    const close = findBlockEnd(css, open)
    const body = css.slice(open + 1, close)
    const trimmedPrelude = prelude.trimStart()
    if (/^@(media|supports|container|layer|scope)\b/i.test(trimmedPrelude)) {
      output += `${prelude}{${scopeCanvasCss(body)}}`
    } else if (/^@/i.test(trimmedPrelude)) {
      output += `${prelude}{${body}}`
    } else {
      output += `${splitSelectors(prelude).map(scopeSelector).join(',')}{${body}}`
    }
    cursor = close + 1
  }
  return output
}

const compiledCanvasCss = existsSync(path.join(reference, 'apps/desktop-global/dist/assets'))
  ? readdirSync(path.join(reference, 'apps/desktop-global/dist/assets')).find(name => /^preview-canvas-.*\.css$/.test(name))
  : null
const rawCss = compiledCanvasCss
  ? readFileSync(path.join(reference, 'apps/desktop-global/dist/assets', compiledCanvasCss), 'utf8')
  : `${cleanCss(path.join(repo, 'scripts/director/reference-canvas/index.css'))}\n${cleanCss(path.join(repo, 'scripts/director/reference-canvas/whiteboard.css'))}`
const css = scopeCanvasCss(rawCss).replace(
  /\.reference-canvas-host \.rich-text-bubble-menu button\[aria-label=Italic\],\.reference-canvas-host \.rich-text-bubble-menu button\[aria-label=Strike\],\.reference-canvas-host \.rich-text-bubble-menu button\[aria-label=Underline\],\.reference-canvas-host \.rich-text-bubble-menu button\[aria-label=Highlight\],\.reference-canvas-host \.rich-text-bubble-menu>\.font-family-select:not\(\.canvas-font-family-select\)\{display:none\}/g,
  '.reference-canvas-host .rich-text-bubble-menu>.font-family-select:not(.canvas-font-family-select){display:none}',
).replace(
  /font-family:[^;}]*ui-sans-serif[^;}]*(?=[;}])/g,
  'font-family:var(--sans)',
)
mkdirSync(path.join(repo, 'public/vendor/director'), { recursive: true })
writeFileSync(path.join(repo, 'public/vendor/director/reference-canvas.css'), css)

console.log('Bundled reference Canvas into public/vendor/director/reference-canvas.js')
