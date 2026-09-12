import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMarkdown} from '../public/features/agent/markdown.js';
test('Markdown renders headings, lists, tables and unfinished streaming code fences',()=>{
 const html=renderMarkdown('# 标题\n\n**重点**\n\n1. 第一项\n2. 第二项\n\n| A | B |\n| --- | --- |\n| 一 | 二 |\n\n```js\nconst a = 1;');
 for(const part of ['<h1>标题</h1>','<strong>重点</strong>','<ol start="1">','<table>','<td>二</td>','<pre><code>const a = 1;</code></pre>'])assert.ok(html.includes(part),part);
});
test('Markdown escapes HTML and disallows unsafe link protocols',()=>{
 const html=renderMarkdown('<img src=x onerror=alert(1)>\n[x](javascript:alert)\n[x](data:text/html,test)\n[安全](https://example.com)\n`<script>`');
 assert.ok(!html.includes('<img'));assert.ok(!html.includes('href="javascript:'));assert.ok(!html.includes('href="data:'));
 assert.ok(html.includes('rel="noopener noreferrer"'));assert.ok(html.includes('<code>&lt;script&gt;</code>'));
});
test('conversation assets use the updated cache chain',async()=>{
 const {readFile}=await import('node:fs/promises');
 const entries=[['public/index.html',['/app.js?v=329','/styles.css?v=263']],['public/app.js',['./drama-studio.js?v=138']],['public/drama-studio.js',['./features/drama/director-workspace.js?v=43']],['public/features/drama/director-workspace.js',["./director-actions.js?v=8", "../agent/markdown.js?v=1", "../agent/image-bounds.js?v=1", "../../vendor/director/reference-canvas.js?v=28"]]];
 for(const [path,urls] of entries){const source=await readFile(new URL(`../${path}`,import.meta.url),'utf8');for(const url of urls)assert.ok(source.includes(url),`${path}: ${url}`);}
});
