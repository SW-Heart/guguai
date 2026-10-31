import { textModelName, textModelLogoMarkup } from '../assistant/text-models.js?v=2';
export async function loadTextModels({root,api,esc,toast,pageHead,showAdminDialog}) {
  root.innerHTML=pageHead('textModelsTitle','文本模型','配置对话模型、名称、Token 单价与展示顺序','<button class="btn" data-text-check-all type="button">检查全部</button><button class="btn" data-text-refresh type="button">刷新</button><button class="btn btn-primary" data-text-add type="button">新增模型</button>')+'<section class="panel" data-text-table>正在加载…</section>';
  let catalog;
  const load=async()=>{
    catalog=await api('/api/admin/text-models');
    render();
  };
  const render=()=>{
    root.querySelector('[data-text-table]').innerHTML=catalog.items.length?`<div class="table-wrap"><table aria-label="文本模型"><thead><tr><th>排序</th><th>模型名称 / ID</th><th>状态</th><th>上下文</th><th>输入单价</th><th>输出单价</th><th>缓存读取</th><th>缓存写入</th><th>操作</th></tr></thead><tbody>${catalog.items.map(item=>`<tr><td>${item.sortOrder}</td><td>${textModelLogoMarkup(item.id,item.label)} <b>${esc(item.label)}</b><br><small>${esc(item.id)}</small></td><td>${!item.enabled?'停用':item.testedAt?'可用':'待测试'}</td><td>${item.contextWindow.toLocaleString()}</td>${['inputYuanPerMillion','outputYuanPerMillion','cacheReadYuanPerMillion','cacheCreationYuanPerMillion'].map(key=>`<td>¥${item[key]}</td>`).join('')}<td><button type="button" class="btn btn-sm" data-text-test="${esc(item.id)}">测试</button><button type="button" class="btn btn-sm" data-text-edit="${esc(item.id)}">编辑</button><button type="button" class="btn btn-sm" data-text-delete="${esc(item.id)}">删除</button></td></tr>`).join('')}</tbody></table></div><p class="text-muted">价格单位：元 / 百万 Token。排序数值越小越靠前，启用的模型测试成功后自动展示。修改模型 ID 后需重新测试。首个可用模型作为默认模型。</p>`:'<div class="empty-state">暂无文本模型，请新增模型。</div>';
  };
  const save=async items=>{await api('/api/admin/text-models',{method:'PUT',body:JSON.stringify({items,expectedVersion:catalog.version})});toast('文本模型已保存');await load();};
  const edit=async item=>{
    const number=(name,label,value)=>({name,label,type:'number',value,min:0,step:'any',required:true});
    await showAdminDialog({title:item?'编辑文本模型':'新增文本模型',submit:'保存',fields:[
      {name:'id',label:'模型 ID',value:item?.id||'',required:true,help:'填写接口支持的完整模型 ID。'},
      {name:'label',label:'展示名称',value:item?.label||'',placeholder:'例如 DeepSeek V4 Pro；留空自动生成'},
      number('inputYuanPerMillion','输入单价（元 / 百万 Token）',item?.inputYuanPerMillion??3),
      number('outputYuanPerMillion','输出单价（元 / 百万 Token）',item?.outputYuanPerMillion??6),
      number('cacheReadYuanPerMillion','缓存读取单价（元 / 百万 Token）',item?.cacheReadYuanPerMillion??3),
      number('cacheCreationYuanPerMillion','缓存写入单价（元 / 百万 Token）',item?.cacheCreationYuanPerMillion??3),
      {...number('contextWindow','上下文长度（Token）',item?.contextWindow??256000),min:8192,step:1},
      {...number('sortOrder','展示顺序',item?.sortOrder??(catalog.items.length*10)),step:1},
      {name:'enabled',label:'启用模型',type:'checkbox',checked:item?.enabled??true},
    ],onSubmit:async values=>{const next={...values,label:values.label.trim()||textModelName(values.id)};for(const key of ['inputYuanPerMillion','outputYuanPerMillion','cacheReadYuanPerMillion','cacheCreationYuanPerMillion','contextWindow','sortOrder'])next[key]=Number(values[key]);await save(item?catalog.items.map(row=>row.id===item.id?next:row):[...catalog.items,next]);}});
  };
  let testing=false;
  const runTests=async ids=>{
    if(testing||!ids.length)return;
    testing=true;
    let passed=0,failed=0;
    const disable=()=>root.querySelectorAll('button').forEach(button=>button.disabled=true);
    const allButton=root.querySelector('[data-text-check-all]');
    disable();
    try{
      for(const [index,modelId] of ids.entries()){
        allButton.textContent=`正在检查 ${index+1}/${ids.length}`;
        const rowButton=[...root.querySelectorAll('[data-text-test]')].find(button=>button.dataset.textTest===modelId);
        if(rowButton)rowButton.textContent='正在测试…';
        try{
          const result=await api('/api/admin/text-models/test',{method:'POST',timeout:75000,body:JSON.stringify({id:modelId,expectedVersion:catalog.version})});
          catalog=result;
          if(result.passed)passed++;else failed++;
          if(ids.length===1)toast(result.message);
        }catch(error){
          failed++;
          if(ids.length===1)toast(error.message);
          // Refresh the version before checking the next model after a conflict
          // or a lost response, without automatically repeating a paid request.
          catalog=await api('/api/admin/text-models');
        }
        render();disable();
      }
      if(ids.length>1)toast(`检查完成：${passed} 个成功，${failed} 个失败`);
    }catch(error){toast(`检查已停止：${error.message}`);}
    finally{
      testing=false;
      allButton.textContent='检查全部';
      try{await load();}catch(error){toast(error.message);}
      root.querySelectorAll('button').forEach(button=>button.disabled=false);
    }
  };
  root.querySelector('[data-text-check-all]').onclick=()=>void runTests(catalog?.items.map(item=>item.id)||[]);
  root.querySelector('[data-text-add]').onclick=()=>void edit().catch(e=>toast(e.message));
  root.querySelector('[data-text-refresh]').onclick=()=>void load().catch(e=>toast(e.message));
  root.querySelector('[data-text-table]').onclick=event=>{
    const actionButton=event.target.closest('[data-text-test]');
    if(actionButton){void runTests([actionButton.dataset.textTest]);return;}
    const editId=event.target.closest('[data-text-edit]')?.dataset.textEdit,deleteId=event.target.closest('[data-text-delete]')?.dataset.textDelete;
    if(editId)void edit(catalog.items.find(i=>i.id===editId)).catch(e=>toast(e.message));
    if(deleteId)void showAdminDialog({title:'删除文本模型',description:'删除后，用户将无法继续选择此模型。已有对话内容会保留。',submit:'删除',fields:[],onSubmit:()=>save(catalog.items.filter(i=>i.id!==deleteId))}).catch(e=>toast(e.message));
  };
  try{await load();}catch(error){root.querySelector('[data-text-table]').textContent=`加载失败：${error.message}`;toast(error.message);}
}
