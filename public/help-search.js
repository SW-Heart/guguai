export const escapeHelpHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('zh-CN');
const tableText = section => section.table ? [section.table.caption || '', ...section.table.columns, ...section.table.rows.flat()] : [];
export function articleText(article) {
  return [article.title, article.intro, ...(article.tags || []), ...article.sections.flatMap(section => [section.title, ...(section.paragraphs || []), ...(section.steps || []), ...(section.bullets || []), ...tableText(section), section.note || '', section.example || ''])].join(' ');
}
export function searchHelp(articles, query) {
  const tokens = normalize(query).trim().slice(0, 200).split(/\s+/).filter(Boolean).slice(0, 12);
  if (!tokens.length) return [];
  return articles.map((article, order) => {
    const title = normalize(article.title);
    const tags = normalize((article.tags || []).join(' '));
    const body = normalize(articleText(article));
    if (!tokens.every(token => body.includes(token))) return null;
    const score = tokens.reduce((total, token) => total + (title.includes(token) ? 6 : 0) + (tags.includes(token) ? 3 : 0) + (normalize(article.intro).includes(token) ? 2 : 0), 0);
    const candidates = [article.intro, ...article.sections.flatMap(s => [...(s.paragraphs || []), ...(s.steps || []), ...(s.bullets || []), ...tableText(s), s.note || '', s.example || ''])];
    const snippet = candidates.find(text => tokens.some(token => normalize(text).includes(token))) || article.intro;
    return { article, score, order, snippet };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.order - b.order);
}
export function highlightHelp(text, query) {
  const tokens = String(query).trim().slice(0, 200).split(/\s+/).filter(Boolean).slice(0, 12);
  if (!tokens.length) return escapeHelpHtml(text);
  const pattern = tokens.map(token => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|');
  const expression = new RegExp(`(${pattern})`, 'giu');
  return String(text).split(expression).map((part, index) => index % 2 ? `<mark>${escapeHelpHtml(part)}</mark>` : escapeHelpHtml(part)).join('');
}
export function resolveHelpLocation(articles, hash) {
  let value;
  try { value = decodeURIComponent(String(hash || '').replace(/^#/, '')); } catch { value = ''; }
  const [id, section] = value.split('--');
  const article = articles.find(item => item.id === id) || articles[0];
  const validSection = article.id === id && /^\d+$/.test(section || '') && Number(section) < article.sections.length;
  return { article, target: validSection ? `${id}--${Number(section)}` : article.id };
}
