// 客户端更新弹窗展示的新版亮点，按新版本号查找。弹窗由旧客户端打开、页面来自线上，
// 所以发版前在这里补上新版本的内容即可让所有旧客户端看到；没有记录的版本不展示。
const RELEASE_NOTES = Object.freeze({
  '0.8.6': Object.freeze([
    Object.freeze({ title: '通用助手上线', text: '写文案、改稿子、读文档，直接找 GuGu 帮忙' }),
    Object.freeze({ title: '新增图像模型', text: 'Nano Banana 2.1 和 Seedream 5.0，最高支持 4K' }),
    Object.freeze({ title: '兑换码领积分', text: '在积分页面输入兑换码即可领取' }),
    Object.freeze({ title: '体验优化', text: '修复了一些问题，使用更稳定' }),
  ]),
});

export function releaseNotesFor(version) {
  return RELEASE_NOTES[String(version || '').trim().replace(/^v/i, '')] || [];
}
