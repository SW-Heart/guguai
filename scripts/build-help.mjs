import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { helpArticles, helpCategories } from '../public/help-content.js';
import { articleText, escapeHelpHtml as escape } from '../public/help-search.js';

// Lucide Copy and Check icons, matching the product's linear icon style.
const copyIcon = '<svg class="example-copy-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const checkIcon = '<svg class="example-copy-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20 6-11 11-5-5"/></svg>';

export function renderHelpTable(table) {
  if (!table || !Array.isArray(table.columns) || !table.columns.length || !Array.isArray(table.rows) || table.rows.some(row => !Array.isArray(row) || row.length !== table.columns.length)) throw new Error('Invalid help comparison table');
  return `<div class="help-table-scroll" tabindex="0" role="region" aria-label="${escape(table.caption || '对比表格')}"><table class="help-table">${table.caption ? `<caption>${escape(table.caption)}</caption>` : ''}<thead><tr>${table.columns.map(column => `<th scope="col">${escape(column)}</th>`).join('')}</tr></thead><tbody>${table.rows.map(row => `<tr>${row.map((cell, index) => `<${index ? 'td' : 'th scope="row"'}>${escape(cell)}</${index ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export function renderHelpBlocks() {
  const groupArticles = category => helpArticles.filter(article => article.category === category.id);
  const nav = helpCategories.map(category => `<div class="help-nav-group"><h2>${escape(category.title)}</h2>${groupArticles(category).map(article => `<a href="#${article.id}">${escape(article.title)}</a>`).join('\n')}</div>`).join('\n');
  const options = helpCategories.map(category => `<optgroup label="${escape(category.title)}">${groupArticles(category).map(article => `<option value="${article.id}">${escape(article.title)}</option>`).join('\n')}</optgroup>`).join('\n');
  const articles = helpArticles.map(article => {
    const minutes = Math.max(2, Math.ceil(articleText(article).length / 350));
    const related = (article.related || []).map(id => {
      const target = helpArticles.find(item => item.id === id);
      if (!target) throw new Error(`Unknown related help article: ${article.id} -> ${id}`);
      return `<li><a class="text-link" href="#${target.id}">${escape(target.title)}</a></li>`;
    });
    return `<article class="help-article" id="${article.id}" aria-labelledby="${article.id}-title">
<h1 id="${article.id}-title" tabindex="-1">${escape(article.title)}</h1><p class="article-intro">${escape(article.intro)}</p><div class="article-meta"><span>约 ${minutes} 分钟阅读</span></div>
${article.screenshot ? `<figure class="article-example preview-panel"><img src="${escape(article.screenshot.src)}" alt="${escape(article.screenshot.alt)}" width="2940" height="1846" loading="lazy" decoding="async"><figcaption>${escape(article.screenshot.caption)}</figcaption></figure>` : ''}
${article.sections.map((section, index) => `<section id="${article.id}--${index}" aria-labelledby="${article.id}-heading-${index}"><h2 id="${article.id}-heading-${index}">${escape(section.title)}</h2>
${(section.paragraphs || []).map(text => `<p>${escape(text)}</p>`).join('\n')}
${section.steps ? `<ol>${section.steps.map(text => `<li>${escape(text)}</li>`).join('\n')}</ol>` : ''}
${section.bullets ? `<ul>${section.bullets.map(text => `<li>${escape(text)}</li>`).join('\n')}</ul>` : ''}
${section.table ? renderHelpTable(section.table) : ''}
${section.example ? `<figure class="article-example example-code-block"><figcaption class="sr-only">${escape(section.exampleTitle || '参考示例')}</figcaption><button class="example-copy" type="button" data-copy-example="${article.id}-example-${index}" aria-label="复制${escape(section.title)}示例" title="复制示例">${copyIcon}${checkIcon}</button><p class="example-copy-status sr-only" role="status" aria-live="polite" aria-atomic="true" data-copy-status></p><pre class="example-content"><code id="${article.id}-example-${index}">${escape(section.example)}</code></pre>${section.example.includes('@') ? '<p class="example-hint">使用前将 @名称 替换为你的实际素材名称；整段放入输入框即可自动引用，无需逐个手动选择。</p>' : section.example.includes('[') ? '<p class="example-hint">使用前请将方括号中的内容替换成自己的需求。</p>' : ''}</figure>` : ''}
${section.note ? `<aside class="article-note"><b>小提示</b>${escape(section.note)}</aside>` : ''}
${section.resources?.length ? `<p class="article-resources">${section.resources.map(resource => { if (!resource.href.startsWith('https://') && !/^\/[\w/#?=-]*$/.test(resource.href)) throw new Error('Invalid help resource link'); return `<a class="text-link" href="${escape(resource.href)}">${escape(resource.title)}</a>`; }).join(' · ')}</p>` : ''}</section>`).join('\n')}
${related.length ? `<div class="article-related"><h2>接下来可以阅读</h2><ul>${related.join('\n')}</ul></div>` : ''}
</article>`;
  }).join('\n');
  return { NAV: nav, OPTIONS: options, ARTICLES: articles };
}
export function buildHelpHtml(template) {
  let html = template;
  for (const [name, content] of Object.entries(renderHelpBlocks())) {
    const start = `<!-- HELP_${name}_START -->`;
    const end = `<!-- HELP_${name}_END -->`;
    if (!html.includes(start) || !html.includes(end)) throw new Error(`Missing help template marker: ${name}`);
    html = html.replace(new RegExp(`${start}[\\s\\S]*?${end}`), () => `${start}\n${content}\n${end}`);
  }
  return html;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = new URL('../public/help.html', import.meta.url);
  await writeFile(file, buildHelpHtml(await readFile(file, 'utf8')));
  console.log(`Built ${helpArticles.length} help articles.`);
}
