import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const text = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const absent = (value, fragments, label) => {
  for (const fragment of fragments) assert.equal(value.includes(fragment), false, `${label} must not contain ${fragment}`);
};
const absentPattern = (value, pattern, label) => {
  assert.equal(pattern.test(value), false, `${label} must not match ${pattern}`);
};
const present = (value, fragments, label) => {
  for (const fragment of fragments) assert.equal(value.includes(fragment), true, `${label} must contain ${fragment}`);
};

test('service env examples expose only SMS-specific credentials and R2 media settings', async () => {
  for (const file of ['.env.example', '.env.production.example']) {
    const value = await text(file);
    absent(value, ['ALIYUN_ACCESS_KEY_', 'ALIYUN_OSS_', 'MEDIA_STORAGE_PROVIDER', 'MEDIA_STORAGE_PREFIX', 'DIRECT_OSS_UPLOAD_ENABLED', 'DESKTOP_UPDATE_OSS_'], file);
    present(value, ['SMS_ACCESS_KEY_ID=', 'SMS_ACCESS_KEY_SECRET=', 'MEDIA_OBJECT_PREFIX=', 'DIRECT_UPLOAD_ENABLED=', 'R2_MODEL_INPUT_URL_EXPIRES_SECONDS='], file);
  }
});

test('desktop release env is isolated from business media and SMS configuration', async () => {
  const value = await text('.env.desktop-release.example');
  present(value, ['DESKTOP_API_BASE=', 'DESKTOP_UPDATE_PUBLIC_URL=', 'DESKTOP_UPDATE_OSS_ACCESS_KEY_ID=', 'DESKTOP_UPDATE_OSS_ACCESS_KEY_SECRET=', 'DESKTOP_UPDATE_OSS_ENDPOINT=', 'DESKTOP_UPDATE_OSS_BUCKET=', 'DESKTOP_UPDATE_OSS_PREFIX=', 'DESKTOP_UPDATE_OSS_TIMEOUT_MS='], '.env.desktop-release.example');
  absent(value, ['R2_ACCESS_KEY_ID', 'SMS_ACCESS_KEY_ID', 'MEDIA_OBJECT_PREFIX'], '.env.desktop-release.example');
});

test('runtime, documentation, and CI preserve the R2-only boundary', async () => {
  const archivedSpecUrl = new URL('../.kiro/specs/sqlite-metadata-store/requirements.md', import.meta.url);
  const [server, cleanup, release, readme, spec, ci, backup] = await Promise.all([
    text('server.mjs'), text('scripts/cleanup-local-media.mjs'), text('scripts/desktop-release.mjs'),
    text('README.md'), existsSync(archivedSpecUrl) ? readFile(archivedSpecUrl, 'utf8') : Promise.resolve(''), text('.github/workflows/ci.yml'),
    text('scripts/db-backup.mjs'),
  ]);
  absent(server, ["from 'ali-oss'", 'MEDIA_STORAGE_PROVIDER', 'ossKey'], 'server.mjs');
  absentPattern(server, /['"]\/api\/files\/upload['"]/, 'server.mjs');
  absent(cleanup, ['ali-oss', 'MEDIA_STORAGE_PROVIDER', 'ossKey', 'missingOss'], 'cleanup-local-media.mjs');
  present(release, ["from 'ali-oss'", '.env.desktop-release', 'DESKTOP_UPDATE_OSS_ACCESS_KEY_ID'], 'desktop-release.mjs');
  absent(release, ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_OSS_ENDPOINT'], 'desktop-release.mjs');
  absent(readme, ['MEDIA_STORAGE_PROVIDER', 'DIRECT_OSS_UPLOAD_ENABLED', 'npm run migrate', 'ossKey'], 'README.md');
  if (existsSync(archivedSpecUrl)) absent(spec, ['Migration_Tool SHALL', 'ossKey'], 'archived SQLite spec');
  absent(ci, ['${{ secrets.', 'DESKTOP_UPDATE_OSS_', 'ALIYUN_OSS_'], 'CI workflow');
  present(backup, ["'upload_intents'"], 'db-backup.mjs');
});

test('legacy migration is absent and ali-oss is a pinned release-only dev dependency', async () => {
  const packageJson = JSON.parse(await text('package.json'));
  assert.equal(packageJson.scripts?.migrate, undefined);
  assert.equal(packageJson.dependencies?.['ali-oss'], undefined);
  assert.equal(packageJson.devDependencies?.['ali-oss'], '6.23.0');
  assert.equal(existsSync(new URL('../scripts/migrate.mjs', import.meta.url)), false);
});
