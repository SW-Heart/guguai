// A narrow backstop for explicit media-status claims, not an intent classifier.
// Only server records can establish submission/completion; assistant prose cannot.
export function generationReplyIssue(message, doc, jobs = []) {
  if (typeof message?.content !== 'string') return '';
  const latestUser = doc.messages.findLastIndex(item => item.role === 'user');
  const recent = doc.messages.slice(Math.max(0, latestUser - 2), latestUser + 1)
    .filter(item => item.role !== 'tool').map(item => item.content || '').join('\n');
  const media = /图像|图片|视频|三视图|参考图|做图|出图|image|video/i;
  if (!media.test(recent) && !jobs.length && !Object.keys(doc.prepared || {}).length) return '';
  const text = message.content.replace(/```[\s\S]*?```/g, '').replace(/^\s*>.*$/gm, '');
  const sentences = text.split(/[\n。！？!?]/).filter(line =>
    !/(?:没有|尚未|未能|无法|不能|不会|并未|还没|并没有|不要|不应|不代表|如果|当.*(?:完成|成功)时|待.*完成后|等到|才能|将会|即将|将要|预计|计划|之后|后再|完成后|完成时|成功后|例如|比如|声称|宣称|回复说|说了)/.test(line));
  const completed = sentences.some(line => /(?:已(?:经)?(?:全部|成功)?生成(?:完成|好)?|生成(?:已(?:经)?)?(?:全部)?(?:完成|完毕|成功|好了))/i.test(line));
  if (completed && !jobs.some(job => job.status === 'completed' && job.assetId)) return 'unverified_generation_completion';
  const underway = sentences.some(line => /正在(?:为你)?生成|(?:已(?:经)?(?:开始|提交|启动)|开始了)(?:[^，,：:]{0,20})(?:生成|出图)|等待生成(?:中|完成)|生成中/.test(line));
  if (underway && !jobs.some(job => ['queued', 'running', 'completed'].includes(job.status))) return 'unverified_generation_submission';
  return '';
}

export const generationEvidenceRecovery = '上一条回复声称已提交或完成媒体生成，但真实任务记录不支持该说法，该回复未作为有效结果保存。请依据当前 generationEvidence 核对：没有任务就尚未提交，预检不等于提交，只有 completed 且存在 assetId 才已完成。需要生成时实际调用模型查询、media_prepare、media_submit，再用 jobs_wait 获取结果；沿用已有 preparedRequestId 和成功任务，不重复扣费。若不能执行，如实说明原因，不模拟预检、等待或完成，也不要编造画面观察。';
