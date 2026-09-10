import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio:['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) return resolve();
      reject(new Error(`Midjourney 图片拆分失败${stderr.trim() ? `：${stderr.trim().slice(0, 500)}` : ''}`));
    });
  });
}

const crops = Object.freeze([
  'crop=iw/2:ih/2:0:0',
  'crop=iw/2:ih/2:iw/2:0',
  'crop=iw/2:ih/2:0:ih/2',
  'crop=iw/2:ih/2:iw/2:ih/2',
]);

export function createMidjourneyGridService({ executable = ffmpegPath, run = runProcess } = {}) {
  async function splitImage(sourceFile, outputFiles) {
    if (!sourceFile || !Array.isArray(outputFiles) || outputFiles.length !== 4) {
      throw new TypeError('Midjourney 图片拆分需要一个源文件和四个输出文件');
    }
    if (!executable) throw new Error('当前环境未安装图片处理组件');
    for (const [index, outputFile] of outputFiles.entries()) {
      await run(executable, [
        '-hide_banner', '-loglevel', 'error', '-i', sourceFile,
        '-vf', crops[index], '-frames:v', '1', '-an', '-y', outputFile,
      ]);
    }
    return outputFiles;
  }

  return Object.freeze({ splitImage });
}

