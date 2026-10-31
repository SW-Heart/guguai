import { agentLogoMarkup } from '../agent/welcome.js?v=1';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Lucide icon paths, matching the product's existing linear icon set.
const paths = {
  panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  compose: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M16 3a2.1 2.1 0 0 1 3 3l-9 9-4 1 1-4Z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  pencil: '<path d="m16 3 5 5M4 16 16 4a2.1 2.1 0 0 1 3 3L7 19l-4 1Z"/>',
  trash: '<path d="M3 6h18M19 6l-1 14H6L5 6M9 6V3h6v3M10 10v7M14 10v7"/>',
  send: '<path d="M12 19V5m-7 7 7-7 7 7"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  down: '<path d="M12 5v14m7-7-7 7-7-7"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  attach: '<path d="m21.4 11.6-9.2 9.2a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.7l-10 10a2 2 0 0 1-2.8-2.8l9.2-9.2"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
};
export const assistantIcon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;

export function filterAssistantHistory(items, query) {
  const term=String(query||'').trim().toLocaleLowerCase();
  return term ? items.filter(item=>String(item.title||'').toLocaleLowerCase().includes(term)) : items;
}

export function renderAssistantHistory(items, activeId, query='') {
  const filtered=filterAssistantHistory(items,query);
  if(!filtered.length)return `<p class="assistant-history-empty">${query.trim()?'没有找到相关对话':'对话会保存在这里'}</p>`;
  return filtered.map(item=>`<div class="assistant-history-row${item.id===activeId?' is-current':''}"><button type="button" data-session="${escape(item.id)}" title="${escape(item.title||'新对话')}" ${item.id===activeId?'aria-current="page"':''}><span>${escape(item.title||'新对话')}</span></button><button type="button" class="assistant-history-more" data-history-more="${escape(item.id)}" popovertarget="assistantConversationMenu" aria-haspopup="menu" aria-label="${escape(item.title||'新对话')}的操作" title="对话操作">${assistantIcon('more')}</button></div>`).join('');
}

export const renderAssistantWelcome = () => `<div class="assistant-welcome">${agentLogoMarkup}<h1>有什么可以帮你？</h1></div>`;

// ChatApp's sidebar/content composition and PromptInput's compact action row,
// adapted from beui.dev/r/chat-app.json for the existing native Agent renderer.
export function renderAssistantShell() {
  return `<section class="assistant-workspace">
    <aside id="assistantHistory" class="assistant-history" aria-label="历史对话" inert>
      <div class="assistant-history-head"><span>对话</span><button type="button" data-sidebar-close class="assistant-icon-button" aria-label="收起历史对话" title="收起历史对话">${assistantIcon('panel')}</button></div>
      <button type="button" data-new class="assistant-new">${assistantIcon('compose')}<span>新对话</span></button>
      <label class="assistant-history-search">${assistantIcon('search')}<input data-history-search type="search" placeholder="搜索对话" aria-label="搜索历史对话" autocomplete="off"></label>
      <div class="assistant-history-caption">最近对话</div>
      <nav data-history aria-label="选择对话"></nav>
    </aside>
    <button type="button" class="assistant-sidebar-overlay" data-sidebar-close tabindex="-1" aria-label="关闭历史对话" hidden></button>
    <section class="assistant-chat is-empty" aria-label="与 GuGu 对话">
      <header class="assistant-chat-header">
        <button type="button" data-sidebar-toggle class="assistant-icon-button" aria-label="展开历史对话" aria-controls="assistantHistory" aria-expanded="false" title="历史对话">${assistantIcon('panel')}</button>
        <button type="button" data-new class="assistant-icon-button assistant-quick-new" aria-label="新对话" title="新对话">${assistantIcon('compose')}</button>
        <span class="assistant-chat-title" data-conversation-title>新对话</span>
        <button type="button" data-more class="assistant-icon-button" aria-haspopup="menu" popovertarget="assistantConversationMenu" aria-label="更多对话操作" title="更多">${assistantIcon('more')}</button>
      </header>
      <div class="dw-message-scroller assistant-message-scroller">
        <div class="dw-messages" role="log" aria-label="对话内容" aria-live="polite" tabindex="0">
          <div class="dw-message-history">${renderAssistantWelcome()}</div>
          <div class="dw-message-draft dw-message assistant" hidden></div>
          <div class="dw-turn-activity assistant-status"><p data-status role="status">正在连接…</p><button type="button" data-reconnect hidden>重新连接</button><button data-resume type="button" hidden>继续回复</button></div>
        </div>
        <nav class="dw-message-rail" aria-label="消息导航" hidden></nav>
        <button type="button" class="dw-message-jump" data-message-jump aria-label="回到最新消息" title="回到最新消息" inert>${assistantIcon('down')}</button>
      </div>
      <div class="assistant-composer-wrap">
        <form class="assistant-composer">
          <label for="assistantMessage" class="dw-sr-only">输入消息</label>
          <input data-file-input type="file" accept=".png,.jpg,.jpeg,.webp,.txt,.md,.csv,.json,.pdf,.docx" multiple hidden>
          <div data-attachments class="assistant-attachments attachment-strip" aria-label="已添加的文件" hidden></div>
          <p data-file-status class="assistant-file-status" role="status" hidden></p>
          <div data-selected-skill class="assistant-selected-skill" hidden><span data-skill-label></span><button type="button" data-remove-skill aria-label="移除所选技能" title="移除技能">${assistantIcon('close')}</button></div>
          <textarea id="assistantMessage" placeholder="输入 / 选择技能，或直接提问…" maxlength="30000" rows="2"></textarea>
          <div class="assistant-composer-actions">
            <button type="button" data-upload class="assistant-icon-button" aria-label="添加图片或文档" title="添加图片或文档">${assistantIcon('attach')}</button>
            <div class="assistant-composer-right">
            <button type="button" class="assistant-model-trigger" data-model-trigger popovertarget="assistantModelMenu" aria-label="切换对话模型" aria-haspopup="listbox" aria-controls="assistantModelList" aria-expanded="false" disabled><span class="assistant-text-model-logo" data-model-logo>${assistantIcon('layers')}</span><span data-model-label>正在加载模型…</span>${assistantIcon('chevron')}</button>
            <button data-stop class="assistant-submit" type="button" aria-label="停止回复" title="停止回复" hidden>${assistantIcon('stop')}</button>
            <button data-send class="assistant-submit" type="submit" aria-label="发送消息" title="发送消息" disabled>${assistantIcon('send')}</button>
            </div>
          </div>
        </form>
        <div data-suggestions class="assistant-suggestions" role="group" aria-label="快捷输入需求" hidden></div>
      </div>
    </section>
    <div id="assistantConversationMenu" class="assistant-conversation-menu" popover role="menu" aria-label="对话操作">
      <button type="button" data-rename role="menuitem">${assistantIcon('pencil')}重命名</button>
      <button type="button" data-delete role="menuitem">${assistantIcon('trash')}删除对话</button>
    </div>
    <div class="assistant-skill-menu" data-skill-menu popover="manual"><div class="assistant-skill-heading" id="assistantSkillHeading">选择技能</div><div id="assistantSkillList" data-skill-list role="listbox" aria-labelledby="assistantSkillHeading"></div></div>
    <div id="assistantModelMenu" class="assistant-model-menu" data-model-menu popover>
      <div class="assistant-model-menu-heading" id="assistantModelHeading">选择对话模型</div>
      <label class="assistant-model-search">${assistantIcon('search')}<input type="search" data-model-search placeholder="搜索模型" aria-label="搜索模型" autocomplete="off"></label>
      <div id="assistantModelList" class="assistant-model-list" data-model-list role="listbox" aria-labelledby="assistantModelHeading"></div>
    </div>
    <dialog data-title-dialog class="form-dialog assistant-dialog" aria-labelledby="assistantTitleHeading">
      <form data-title-form class="form-dialog-card"><div class="dialog-head"><h2 id="assistantTitleHeading">重命名对话</h2><button type="button" data-cancel-title class="assistant-icon-button" aria-label="关闭">${assistantIcon('close')}</button></div><div class="form-dialog-body"><label class="dialog-field">对话名称<input data-title maxlength="80" required autocomplete="off"></label></div><footer class="dialog-footer"><button type="button" data-cancel-title class="secondary-button">取消</button><button type="submit" class="gradient-button">保存</button></footer></form>
    </dialog>
    <dialog data-delete-dialog class="form-dialog assistant-dialog" aria-labelledby="assistantDeleteHeading"><form method="dialog" class="form-dialog-card"><div class="form-dialog-body"><h2 id="assistantDeleteHeading">删除这段对话？</h2><p data-delete-name class="assistant-delete-name"></p><p>删除后无法恢复。</p></div><footer class="dialog-footer"><button value="cancel" class="secondary-button">取消</button><button value="delete" class="gradient-button">删除对话</button></footer></form></dialog>
  </section>`;
}
