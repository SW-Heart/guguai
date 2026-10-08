// Maps a failed generation to a stable failure code. The order of the checks
// matters: user-input problems (content review, references, prompt, ratio)
// are matched before generic service failures so an upstream 4xx/5xx wrapper
// around a moderation message is still treated as a content problem.
export function generationFailureCode(task) {
  if (task.creditStatus === 'refund_failed') return 'REFUND_PENDING';
  const raw = String(task.error || '').toLowerCase();
  if (task.sourceUrl && (task.providerTaskId || task.archivePending)) return 'ARCHIVE_FAILED';
  if (/服务重启|任务.*中断|interrupted|cancelled|canceled/.test(raw)) return 'INTERRUPTED';
  if (/模型无响应|未获得上游任务\s*id|未返回上游任务编号/.test(raw)) return 'MODEL_UNRESPONSIVE';
  if (/insufficient[_ -]?credits|insufficient balance|insufficient funds|account balance|余额不足|账户余额|余额不够/.test(raw)) return 'UPSTREAM_BILLING';
  if (/may contain real person|real person|肖像保护|本人肖像/.test(raw)) return 'PORTRAIT_RESTRICTED';
  if (/content[_ ]policy|content review|moderation|safety|policy|unsafe|nsfw|审核|违规|敏感|涉政|色情/.test(raw)) return 'CONTENT_REJECTED';
  if (/requires?\s+\d+\s+to\s+\d+\s+reference images?|reference images?\s+(?:is|are)?\s*required|参考图.*必需|必须.*参考图/.test(raw)) return 'REFERENCE_REQUIRED';
  if (/image upload failed|upload failed.*image|图片上传失败/.test(raw)) return 'REFERENCE_UPLOAD_FAILED';
  if (/参考图片准备失败/.test(raw)) return 'REFERENCE_PREPARATION_FAILED';
  if (/(?:reference|参考).*(?:\b(?:404|403)\b|链接.*(?:过期|失效)|download.*failed)|(?:\b(?:404|403)\b).*(?:reference|参考图|图片)/.test(raw)) return 'REFERENCE_UNAVAILABLE';
  if (/unmarshal.*images|image.*\[\]string|参考图|参考素材.*(本地|同步|读取|云端|源地址)|文件本地缓存缺失|没有可用的云端归档|reference image|image[_ ]url|图片.*(格式|大小|尺寸|数量)|unsupported image/.test(raw)) return 'INVALID_REFERENCE';
  if (/prompt length exceeds|prompt.*(?:too long|maximum allowed length)|提示词.*过长|创作描述.*过长/.test(raw)) return 'PROMPT_TOO_LONG';
  if (/aspect ratio.*(?:not supported|unsupported)|不支持画幅|画幅.*不支持/.test(raw)) return 'UNSUPPORTED_ASPECT_RATIO';
  if (/模型不存在|模型.*未开放|model.*(?:does not exist|not found|not available|not enabled|not open)/.test(raw)) return 'MODEL_UNAVAILABLE';
  if (/\bupstream[_ -]?rejected\b/.test(raw)) return 'UPSTREAM_REJECTED';
  if (/\b429\b|rate.?limit|too many requests|overloaded|capacity|繁忙|请求过多|频率/.test(raw)) return 'RATE_LIMITED';
  if (/timeout|timed out|超时|等待超时/.test(raw)) return 'TIMEOUT';
  if (/没有返回任务 id|没有返回结果|没有返回.*url|missing.*(task|result|url)|invalid response|结果地址/.test(raw)) return 'RESULT_INVALID';
  if (/服务.*(尚未配置|未配置)|尚未配置/.test(raw)) return 'SERVICE_NOT_CONFIGURED';
  if (/service(?:\s+is)?\s+unavailable|服务.*不可用/.test(raw)) return 'SERVICE_UNAVAILABLE';
  if (/fetch failed|network|econn|socket/.test(raw)) return 'NETWORK_ERROR';
  if (/\b400\b|\b409\b|\b422\b|invalid (parameter|argument|request)|bad request|参数|不支持.*(画幅|时长|模式)/.test(raw)) return 'INVALID_REQUEST';
  if (/\b(401|403|404|500|502|503|504)\b|fetch failed|network|econn|socket|service unavailable|服务.*(未配置|不可用)|任务没有返回任务 id/.test(raw)) return 'SERVICE_UNAVAILABLE';
  return 'UNKNOWN';
}

// Which side of a content-review rejection the upstream pointed at. Only
// 'input_text' rejections say anything about the words of a prompt, so the
// precheck lexicon is calibrated against those alone.
export function contentRejectionSource(error) {
  const raw = String(error || '').toLowerCase();
  if (/inputtext(?:sensitivecontentdetected|riskdetection)|input text|输入文本|输入的?(?:提示词|文字)/.test(raw)) return 'input_text';
  if (/output(?:image|video)?sensitive|generated (?:images?|videos?)|生成结果|输出(?:图片|视频|内容)|视频内容审核|图像内容审核/.test(raw)) return 'output';
  if (/肖像保护|real person|inputimage(?:sensitive|risk)|(?:input image|reference|参考图|参考素材|参考视频|输入图片|素材图片).{0,40}(?:审核|违规|版权|侵权|敏感|sensitive|moderation|policy|unsafe)/.test(raw)) return 'reference';
  // Seedance's 710082022 names no side, but on GuGu it has followed the prompt text;
  // transient repeats of an unchanged prompt that later passed are filtered out by the calibration.
  if (/710082022|疑似包含侵权\/违规内容/.test(raw)) return 'input_text';
  if (/提示词有问题|违禁词|敏感词|禁用词|(?:banned|prohibited|sensitive) (?:words?|keywords?)|(?:prompt|提示词|画面描述).{0,60}(?:sensitive|violat|block|reject|unsafe|moderation|违禁|违规|敏感|拦截|审核)/.test(raw)) return 'input_text';
  if (/content[_ ]policy|content review|moderation|safety|policy|unsafe|nsfw|审核|违规|敏感|涉政|色情/.test(raw)) return 'unknown';
  return '';
}
