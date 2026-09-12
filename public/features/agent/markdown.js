// HTML is always escaped; links accept only explicit web/mail protocols.
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function inline(text) {
  const tokens=[];
  const hold=html=>`\u0000${tokens.push(html)-1}\u0000`;
  let value=escape(text.replace(/\u0000/g,''));
  value=value.replace(/`([^`]+)`/g,(_,code)=>hold(`<code>${code}</code>`));
  value=value.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g,(_,label,url)=>hold(/^(https?:\/\/|mailto:)/i.test(url)?`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`:label));
  value=value.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/__(.+?)__/g,'<strong>$1</strong>').replace(/~~(.+?)~~/g,'<del>$1</del>').replace(/\*([^*\n]+)\*/g,'<em>$1</em>');
  return value.replace(/\u0000(\d+)\u0000/g,(_,i)=>tokens[Number(i)]);
}
export function renderMarkdown(source) {
  const lines=String(source??'').replace(/\r\n?/g,'\n').split('\n'), out=[];
  for(let i=0;i<lines.length;) {
    const line=lines[i];
    if(!line.trim()){i++;continue;}
    const fence=line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if(fence){const code=[];i++;while(i<lines.length&&!lines[i].trim().startsWith(fence[1]))code.push(lines[i++]);i++;out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);continue;}
    const heading=line.match(/^(#{1,6})\s+(.+)$/);
    if(heading){out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);i++;continue;}
    if(/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)){out.push('<hr>');i++;continue;}
    if(/^>\s?/.test(line)){const quote=[];while(i<lines.length&&/^>\s?/.test(lines[i]))quote.push(lines[i++].replace(/^>\s?/,''));out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);continue;}
    const list=line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);
    if(list){const tag=list[2]?'ol':'ul';const rows=[];while(i<lines.length){const item=lines[i].match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);if(!item||Boolean(item[2])!==Boolean(list[2]))break;rows.push(`<li>${inline(item[3])}</li>`);i++;}out.push(`<${tag}${list[2]?` start="${Number(list[2])}"`:''}>${rows.join('')}</${tag}>`);continue;}
    if(line.includes('|')&&/^\s*\|?\s*:?-{3,}/.test(lines[i+1]||'')) {const cells=row=>row.trim().replace(/^\||\|$/g,'').split('|').map(x=>inline(x.trim()));const head=cells(line);i+=2;const rows=[];while(i<lines.length&&lines[i].includes('|'))rows.push(`<tr>${cells(lines[i++]).map(x=>`<td>${x}</td>`).join('')}</tr>`);out.push(`<div class="dw-table-scroll"><table><thead><tr>${head.map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);continue;}
    const paragraph=[inline(line)];i++;
    while(i<lines.length&&lines[i].trim()&&!/^(#{1,6}\s|>|\s*[-+*]\s|\s*\d+\.\s|\s*`{3}|\s*~{3})/.test(lines[i])&&!(lines[i].includes('|')&&/^\s*\|?\s*:?-{3,}/.test(lines[i+1]||'')))paragraph.push(inline(lines[i++]));
    out.push(`<p>${paragraph.join('<br>')}</p>`);
  }
  return out.join('');
}
