import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processMedia, probeVideo } from './agent-video-analysis.mjs';
import { resolveVideoEditPlan } from '../lib/agent/video-edit-plan.mjs';

const fontFile = fileURLToPath(new URL('../resources/fonts/NotoSansCJKsc-Regular.otf', import.meta.url));
const even = value => Math.max(2, Math.round(value / 2) * 2);
const time = seconds => {
  const n = Math.round(seconds * 100);
  return `${Math.floor(n / 360000)}:${String(Math.floor(n / 6000) % 60).padStart(2, '0')}:${String(Math.floor(n / 100) % 60).padStart(2, '0')}.${String(n % 100).padStart(2, '0')}`;
};
function wrappedText(text, width, height, fontSize) {
  const lines = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = '', used = 0;
    for (const character of paragraph) {
      const size = /[\u0000-\u001f]/.test(character) ? 0 : /[\x20-\x7e]/.test(character) ? fontSize * 0.65 : fontSize;
      if (!size) continue;
      if (used + size > width && line) { lines.push(line); line = ''; used = 0; }
      line += character; used += size;
    }
    lines.push(line);
  }
  // Leave headroom for font ascenders/descenders; do not silently crop important wording.
  if (lines.length * fontSize * 1.5 > height || width < fontSize) throw new Error('文字区域不足，请增大区域、减小字号或缩短文字');
  return lines.map(line => line.replace(/\\/g, '／').replace(/\{/g, '｛').replace(/\}/g, '｝')).join('\\N');
}
function textAss(layer, width, height, canvasHeight) {
  const fontSize = Math.round(canvasHeight * (layer.fontSize ?? 0.045));
  const color = (layer.color || '#FFFFFF').slice(1);
  const bgr = color.slice(4, 6) + color.slice(2, 4) + color.slice(0, 2);
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Noto Sans CJK SC,${fontSize},&H00${bgr},&H00${bgr},&H00000000,&HFF000000,-1,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,${time(layer.endSeconds - layer.startSeconds)},Default,,0,0,0,,${wrappedText(layer.text, width, height, fontSize)}\n`;
}

export async function editVideoLayers(file, layers) {
  const metadata = await probeVideo(file);
  // Revalidate at the renderer boundary. Semantic anchors were resolved by the scoped Agent tool.
  const checked = resolveVideoEditPlan({ layers: layers.map(layer => ({ ...layer, start: { seconds: layer.startSeconds }, end: { seconds: layer.endSeconds } })) }, metadata);
  const factor = Math.min(1, 1920 / Math.max(metadata.width, metadata.height), Math.sqrt(2073600 / (metadata.width * metadata.height)));
  const width = even(metadata.width * factor), height = even(metadata.height * factor);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gugu-agent-edit-'));
  try {
    const inputs = ['-i', file], filters = [`[0:v:0]setpts=PTS-STARTPTS,scale=${width}:${height},setsar=1,fps=30[base]`];
    let inputIndex = 1, current = 'base';
    if (checked.some(layer => layer.kind === 'text')) {
      await fs.mkdir(path.join(directory, 'fonts'));
      await fs.copyFile(fontFile, path.join(directory, 'fonts/NotoSansCJKsc-Regular.otf'));
    }
    for (const [index, layer] of checked.entries()) {
      const w = even(layer.width * width), h = even(layer.height * height);
      const duration = layer.endSeconds - layer.startSeconds;
      let preparation;
      if (['text', 'rectangle'].includes(layer.kind)) {
        const color = layer.kind === 'text' ? 'black@0' : layer.color || '#FFFFFF';
        inputs.push('-f', 'lavfi', '-i', `color=c=${color}:s=${w}x${h}:r=30:d=${duration},format=rgba`);
        preparation = 'format=rgba';
        if (layer.kind === 'text') {
          await fs.writeFile(path.join(directory, `text-${index}.ass`), textAss(layer, w, h, height));
          preparation += `,ass=filename=text-${index}.ass:fontsdir=fonts:alpha=1`;
        }
      } else {
        if (typeof layer.file !== 'string' || !path.isAbsolute(layer.file)) throw new Error('画面素材尚未准备好');
        if (layer.kind === 'video') {
          const source = await probeVideo(layer.file);
          if (source.durationSeconds === null || (layer.sourceStartSeconds || 0) + duration > source.durationSeconds + 0.01) throw new Error('叠加视频长度不足，请缩短展示时间或换一段素材');
          inputs.push('-ss', String(layer.sourceStartSeconds || 0), '-t', String(duration), '-i', layer.file);
        } else inputs.push('-loop', '1', '-framerate', '30', '-t', String(duration), '-i', layer.file);
        preparation = `setpts=PTS-STARTPTS,fps=30,format=rgba,scale=${w}:${h}:force_original_aspect_ratio=${layer.fit === 'cover' ? 'increase' : 'decrease'}`;
        preparation += layer.fit === 'cover' ? `,crop=${w}:${h}` : `,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0`;
        preparation += ',setsar=1';
      }
      const from = layer.scaleFrom ?? 1, to = layer.scaleTo ?? 1;
      if (from !== 1 || to !== 1) {
        const scale = `${from}+${to - from}*clip(t/${duration},0,1)`;
        preparation += `,scale=w='max(2,trunc(iw*(${scale})/2)*2)':h='max(2,trunc(ih*(${scale})/2)*2)':eval=frame`;
      }
      preparation += `,colorchannelmixer=aa=${layer.opacity}`;
      if (layer.fadeInSeconds) preparation += `,fade=t=in:st=0:d=${layer.fadeInSeconds}:alpha=1`;
      if (layer.fadeOutSeconds) preparation += `,fade=t=out:st=${duration - layer.fadeOutSeconds}:d=${layer.fadeOutSeconds}:alpha=1`;
      filters.push(`[${inputIndex++}:v:0]${preparation},setpts=PTS-STARTPTS+${layer.startSeconds}/TB[layer${index}]`);
      const position = (axis, size) => {
        const start = layer[axis] * size;
        return layer.moveTo ? `${start}+${(layer.moveTo[axis] - layer[axis]) * size}*clip((t-${layer.startSeconds})/${duration},0,1)` : String(start);
      };
      filters.push(`[${current}][layer${index}]overlay=x='${position('x', width)}':y='${position('y', height)}':eof_action=pass:repeatlast=0:enable='gte(t,${layer.startSeconds})*lt(t,${layer.endSeconds})'[view${index}]`);
      current = `view${index}`;
    }
    filters.push(`[${current}]format=yuv420p[finished]`);
    await fs.writeFile(path.join(directory, 'filters.txt'), filters.join(';\n'));
    const output = path.join(directory, 'finished.mp4');
    await processMedia(['-loglevel', 'error', ...inputs, '-filter_complex_threads', '1', '-filter_complex_script', 'filters.txt', '-map', '[finished]', '-map', '0:a:0?', '-t', String(metadata.durationSeconds), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', '2', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', output], Math.min(600000, 60000 + metadata.durationSeconds * 1500), 12000, directory);
    const stat = await fs.stat(output);
    if (!stat.size || stat.size > 200_000_000) throw new Error('成片大小超出限制');
    return { data: await fs.readFile(output), mimeType: 'video/mp4', durationSeconds: metadata.durationSeconds, width, height };
  } finally { await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); }
}
