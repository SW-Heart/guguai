export function createDramaStyleDialog({ api, esc, toast, onCreate, onChange, isCurrent }) {
  let catalog = [], selected = null, context = null, token = 0, busy = false;
  let picker, custom;
  function mount() {
    if(picker)return;
    picker=document.createElement('dialog');picker.className='drama-style-dialog';picker.setAttribute('aria-labelledby','dramaStyleHeading');
    custom=document.createElement('dialog');custom.className='drama-custom-style-dialog';custom.setAttribute('aria-labelledby','dramaCustomStyleHeading');
    document.body.append(picker,custom);
    picker.addEventListener('cancel',event=>{if(busy)event.preventDefault();else close();});
  }
  function render() {
    picker.innerHTML = `<header class="dialog-head"><div><h2 id="dramaStyleHeading">${context.edit ? '修改画面风格' : '选择短剧风格'}</h2><p>${context.edit ? '用于之后生成的画面，已生成内容保持原样。' : '选一种适合故事的画面风格。'}</p></div><button type="button" data-close aria-label="关闭"><span class="gugu-lucide gugu-lucide-x" aria-hidden="true"></span></button></header><div class="drama-style-grid">${catalog.map(item=>`<button type="button" class="drama-style-card ${selected?.id===item.id?'is-selected':''}" data-style="${esc(item.id)}" aria-pressed="${selected?.id===item.id}"><img src="${esc(item.coverUrl)}" alt="${esc(item.name)}风格示例" loading="lazy"><div><b>${esc(item.name)}</b><p>${esc(item.description)}</p></div></button>`).join('')}<button type="button" class="drama-style-card drama-style-custom ${selected?.id==='custom'?'is-selected':''}" data-custom aria-pressed="${selected?.id==='custom'}"><div class="drama-style-custom-art" aria-hidden="true">＋</div><div><b>${selected?.id==='custom'?esc(selected.name):'自定义风格'}</b><p>${selected?.id==='custom'?esc(selected.description):'用自己的文字描述喜欢的画面。'}</p></div></button></div><footer><span data-selection>${selected ? `已选择：${esc(selected.name)}` : '请选择一种风格'}</span><div><button type="button" class="secondary-button" data-close>取消</button>${context.edit ? '' : '<button type="button" class="secondary-button" data-skip>暂不选择直接进入</button>'}<button type="button" class="gradient-button" data-submit ${!selected?'disabled':''}>${context.edit?'保存风格':'创建项目'}</button></div></footer>`;
    picker.querySelectorAll('[data-close]').forEach(button=>button.onclick=close);
    picker.querySelectorAll('[data-style]').forEach(button=>button.onclick=()=>{
      selected=catalog.find(item=>item.id===button.dataset.style);
      picker.querySelectorAll('[aria-pressed]').forEach(card=>{const active=card===button;card.classList.toggle('is-selected',active);card.setAttribute('aria-pressed',String(active));});
      picker.querySelector('[data-selection]').textContent=`已选择：${selected.name}`;
      picker.querySelector('[data-submit]').disabled=false;
    });
    picker.querySelector('[data-custom]').onclick=openCustom;
    picker.querySelector('[data-submit]').onclick=()=>submit();
    const skipButton=picker.querySelector('[data-skip]');
    if(skipButton)skipButton.onclick=()=>submit({skipStyle:true});
  }
  function openCustom() {
    const value=selected?.id==='custom'?selected:null;
    custom.innerHTML=`<form><header class="dialog-head"><h2 id="dramaCustomStyleHeading">自定义风格</h2><button type="button" data-close-custom aria-label="关闭"><span class="gugu-lucide gugu-lucide-x" aria-hidden="true"></span></button></header><div class="drama-custom-style-fields"><label>风格名称<input name="name" maxlength="40" required placeholder="例如：温柔水彩" value="${esc(value?.name||'')}"></label><label>画面描述<textarea name="description" maxlength="1200" required rows="7" placeholder="描述画面质感、色彩、线条和光影。例如：手绘水彩，柔和暖色，轻盈笔触，细腻纸张质感。">${esc(value?.description||'')}</textarea></label><p>这里描述画面风格，故事人物和情节在项目中填写。</p></div><footer><button type="button" class="secondary-button" data-close-custom>取消</button><button type="submit" class="gradient-button">使用此风格</button></footer></form>`;
    custom.querySelectorAll('[data-close-custom]').forEach(button=>button.onclick=()=>custom.close());
    custom.querySelector('form').onsubmit=event=>{
      event.preventDefault();
      const data=new FormData(event.currentTarget), name=String(data.get('name')||'').trim(), description=String(data.get('description')||'').trim();
      if(!name||!description){toast('请填写风格名称和画面描述');return;}
      selected={id:'custom',name,description};custom.close();render();picker.querySelector('[data-custom]').focus();
    };
    custom.showModal();
  }
  async function submit({ skipStyle=false } = {}) {
    if(busy||(skipStyle ? context.edit : !selected)||!isCurrent(context.request))return;
    const style=skipStyle ? null : selected;
    busy=true;const currentToken=token, current=context;
    picker.querySelectorAll('button').forEach(button=>button.disabled=true);
    picker.querySelector(skipStyle?'[data-skip]':'[data-submit]').textContent=current.edit?'正在保存…':'正在创建…';
    try {
      const ok=await (current.edit?onChange(style,current.request):onCreate(style,current.request));
      if(currentToken!==token)return;
      busy=false;
      if(ok)close();else render();
    } catch(error) { if(currentToken===token){busy=false;toast(error.message);render();} }
  }
  async function open({ style=null, edit=false, request }) {
    if(picker?.open||busy)return;
    const currentToken=++token;
    try {
      if(!catalog.length)catalog=(await api('/api/drama/styles')).styles;
      if(currentToken!==token||!isCurrent(request))return;
      mount();context={edit,request};selected=style||catalog[0]||null;render();picker.showModal();
    } catch(error) { if(currentToken===token&&isCurrent(request))toast(error.message); }
  }
  function close() { token++;busy=false;if(custom?.open)custom.close();if(picker?.open)picker.close(); }
  return { open, close };
}
