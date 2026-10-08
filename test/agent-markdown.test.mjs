import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMarkdown,renderStreamingMarkdownBlocks,closeStreamingMarkdown} from '../public/features/agent/markdown.js';
test('Markdown renders headings, lists, tables and unfinished streaming code fences',()=>{
 const html=renderMarkdown('# 标题\n\n**重点**\n\n1. 第一项\n2. 第二项\n\n| A | B |\n| --- | --- |\n| 一 | 二 |\n\n```js\nconst a = 1;');
 for(const part of ['<h1>标题</h1>','<strong>重点</strong>','<ol start="1">','<table>','<td>二</td>','data-code-copy','<code>const a = 1;</code></pre>'])assert.ok(html.includes(part),part);
});
test('each fenced file has an escaped label and a copy button around its unchanged source',()=>{
 const source='```markdown title="说明.md"\n# 标题\n\n- 第一项\n  - 第二项\n```\n\n~~~html filename="<img src=x>.html"\n<div title="hello">&文字</div>\n~~~\n\n```\n无语言\n```';
 const html=renderMarkdown(source);
 assert.equal((html.match(/data-code-copy/g)||[]).length,3);
 assert.ok(html.includes('说明.md'));
 assert.ok(html.includes('&lt;img src=x&gt;.html'));
 assert.ok(!html.includes('<img'));
 assert.ok(html.includes('<code># 标题\n\n- 第一项\n  - 第二项</code>'));
 assert.ok(html.includes('<code>&lt;div title=&quot;hello&quot;&gt;&amp;文字&lt;/div&gt;</code>'));
 assert.equal((html.match(/data-state="complete"/g)||[]).length,3);
 assert.ok(html.includes('aria-label="复制代码"'));
});
test('streaming code distinguishes closed files and respects the opening fence length and character',()=>{
 const source='```js\nconst done = true;\n```\n\n````markdown\n# 文稿\n```\n~~~\n```still content\n**未完成';
 const blocks=renderStreamingMarkdownBlocks(source);
 assert.ok(blocks[0].includes('data-state="complete"'));
 assert.ok(blocks[1].includes('data-state="streaming"'));
 assert.ok(blocks[1].includes('<code># 文稿\n```\n~~~\n```still content\n**未完成</code>'));
 assert.equal(closeStreamingMarkdown(source),source);
 const completed=renderStreamingMarkdownBlocks(source+'\n````\n\n正文');
 assert.ok(completed[1].includes('data-state="complete"'));
 assert.equal(completed[2],'<p>正文</p>');
 assert.ok(renderMarkdown('`inline`').includes('<code>inline</code>'));
 assert.ok(!renderMarkdown('`inline`').includes('data-code-copy'));
});
test('Markdown escapes HTML and disallows unsafe link protocols',()=>{
 const html=renderMarkdown('<img src=x onerror=alert(1)>\n[x](javascript:alert)\n[x](data:text/html,test)\n[安全](https://example.com)\n`<script>`');
 assert.ok(!html.includes('<img'));assert.ok(!html.includes('href="javascript:'));assert.ok(!html.includes('href="data:'));
 assert.ok(html.includes('rel="noopener noreferrer"'));assert.ok(html.includes('<code>&lt;script&gt;</code>'));
});
test('conversation assets use the updated cache chain',async()=>{
 const {readFile}=await import('node:fs/promises');
 const entries=[['public/features/agent/markdown.js',['./code-block.js?v=1']],['public/index.html',['/app.js?v=491','/styles.css?v=366']],['public/app.js',['./drama-studio.js?v=226','./features/agent/workspace.js?v=90']],['public/drama-studio.js',['./features/drama/director-workspace.js?v=126','./features/drama/local-snapshot.js?v=1']],['public/features/agent/workspace.js',['../drama/director-workspace.js?v=126','./project-loading.js?v=1','./default-title.js?v=1']],['public/features/drama/director-workspace.js',["./director-actions.js?v=11", "./canvas-generation.js?v=11", "./local-snapshot.js?v=1", "../agent/client.js?v=13", "../agent/project-loading.js?v=1", "../agent/markdown.js?v=3", "../agent/code-block.js?v=1", "../agent/stream-pacer.js?v=1", "../agent/reasoning-text.js?v=4", "../agent/message-scroller.js?v=2", "../agent/image-bounds.js?v=1", "../agent/frames.js?v=3", "../../vendor/director/reference-canvas.js?v=32"]]];
 for(const [path,urls] of entries){const source=await readFile(new URL(`../${path}`,import.meta.url),'utf8');for(const url of urls)assert.ok(source.includes(url),`${path}: ${url}`);}
});
