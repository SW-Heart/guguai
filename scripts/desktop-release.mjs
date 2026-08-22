import OSS from 'ali-oss';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const releaseDir = path.join(root, 'release');
const packagePath = path.join(root, 'package.json');
const originalPackageJson = await fs.readFile(packagePath, 'utf8');
const packageJson = JSON.parse(originalPackageJson);
const args = process.argv.slice(2);
const publish = args.includes('--publish');
const skipBuild = args.includes('--skip-build');
const valueArg = name => args.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) || '';
const version = packageJson.version;
const updatePrefix = String(valueArg('--prefix') || process.env.DESKTOP_UPDATE_OSS_PREFIX || `${process.env.ALIYUN_OSS_PREFIX || 'model-studio'}/desktop-updates`).replace(/^\/+|\/+$/g, '');
const publicUrl = String(valueArg('--base-url') || process.env.DESKTOP_UPDATE_PUBLIC_URL || process.env.GUGU_UPDATE_URL || '').trim().replace(/\/$/, '');
const apiBase = String(valueArg('--api-base') || process.env.DESKTOP_API_BASE || process.env.GUGU_API_BASE || packageJson.guguApiBase || '').trim().replace(/\/$/, '');
const mimeTypes = {
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.zip': 'application/zip',
  '.dmg': 'application/x-apple-diskimage',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.nsis.7z': 'application/x-7z-compressed',
  '.7z': 'application/x-7z-compressed',
  '.blockmap': 'application/octet-stream',
  '.AppImage': 'application/octet-stream',
};

function usage() {
  console.log(`GuGu AI 桌面发布工具（当前版本 ${version}）

用法：
  DESKTOP_API_BASE=https://api.example.com DESKTOP_UPDATE_PUBLIC_URL=https://download.example.com/gugu-ai npm run desktop:release
                                                   构建并列出待发布文件
  DESKTOP_API_BASE=https://api.example.com DESKTOP_UPDATE_PUBLIC_URL=https://download.example.com/gugu-ai npm run desktop:release -- --publish
                                                   构建并上传到 OSS
  npm run desktop:release -- --publish --skip-build 已有 release/ 文件时直接上传

可选参数：
  --prefix=...    OSS 更新目录，默认 <ALIYUN_OSS_PREFIX>/desktop-updates
  --base-url=...  用户端 GUGU_UPDATE_URL 对应的公开地址
  --api-base=...   用户端线上创作服务 API 地址（生产包必填）
`);
}

if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: root, stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`)));
  });
}

function isPublishable(name) {
  if (name === 'builder-debug.yml') return false;
  if (name.endsWith('.blockmap')) return name.includes(version);
  if (/^latest(?:-(?:mac|linux|win))?\.yml$/i.test(name)) return true;
  return name.includes(version) && /\.(dmg|zip|exe|7z|AppImage|deb|rpm)$/i.test(name);
}

function contentType(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.nsis.7z')) return mimeTypes['.nsis.7z'];
  return mimeTypes[path.extname(name)] || 'application/octet-stream';
}

function validateUrl(value, label) {
  if (!value) return;
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label}必须是完整的 http:// 或 https:// 地址`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`${label}必须是完整的 http:// 或 https:// 地址`);
}

validateUrl(publicUrl, 'DESKTOP_UPDATE_PUBLIC_URL');
validateUrl(apiBase, 'DESKTOP_API_BASE');

if (!skipBuild) {
  if (publicUrl || apiBase) {
    const buildPackage = {
      ...packageJson,
      ...(publicUrl ? { guguUpdateUrl: publicUrl } : {}),
      ...(apiBase ? { guguApiBase: apiBase } : {}),
    };
    await fs.writeFile(packagePath, `${JSON.stringify(buildPackage, null, 2)}\n`);
  }
  try {
    await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'desktop:dist']);
  } finally {
    if (publicUrl || apiBase) await fs.writeFile(packagePath, originalPackageJson);
  }
}

const files = (await fs.readdir(releaseDir)).filter(isPublishable).sort();
if (!files.length) throw new Error(`release/ 中没有找到版本 ${version} 的桌面发布文件`);
const feedFiles = files.filter(name => /^latest(?:-(?:mac|linux|win))?\.yml$/i.test(name));
if (!feedFiles.length) throw new Error('发布清单缺少 latest-*.yml，客户端无法检查更新');
const differentialPackages = files.filter(name => name.includes(version) && /\.(zip|7z|AppImage)$/i.test(name));
const missingBlockmaps = differentialPackages.filter(name => !files.includes(`${name}.blockmap`));
if (missingBlockmaps.length) throw new Error(`发布清单缺少增量更新 blockmap：${missingBlockmaps.join(', ')}`);
console.log(`\n版本 ${version} 待发布文件（${files.length} 个）：`);
files.forEach(file => console.log(`  - ${file}`));

if (!publish) {
  console.log('\n当前为预览模式，没有上传。确认无误后追加 --publish。');
  process.exit(0);
}

const required = ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'ALIYUN_OSS_ENDPOINT', 'ALIYUN_OSS_BUCKET'];
const missing = required.filter(name => !process.env[name]);
if (missing.length) throw new Error(`缺少 OSS 配置：${missing.join(', ')}`);
if (!publicUrl) throw new Error('发布时必须提供 DESKTOP_UPDATE_PUBLIC_URL 或 GUGU_UPDATE_URL');
if (!apiBase) throw new Error('发布时必须提供 DESKTOP_API_BASE 或 GUGU_API_BASE');

const client = new OSS({
  accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
  accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET,
  endpoint: process.env.ALIYUN_OSS_ENDPOINT,
  bucket: process.env.ALIYUN_OSS_BUCKET,
  secure: true,
});

for (const name of files) {
  const objectKey = `${updatePrefix}/${name}`;
  const cacheControl = name.startsWith('latest-') ? 'no-cache, max-age=0' : 'public, max-age=31536000, immutable';
  await client.put(objectKey, path.join(releaseDir, name), { headers: { 'Content-Type': contentType(name), 'Cache-Control': cacheControl } });
  console.log(`已上传 ${publicUrl}/${name}`);
}

console.log(`\n客户端 API 地址：${apiBase}`);
console.log(`客户端更新地址：${publicUrl}`);
