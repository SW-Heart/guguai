import { randomBytes, randomUUID, scrypt as scryptCallback } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(projectDir, 'data');
const usersFile = path.join(dataDir, 'users.json');
const username = String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
const password = String(process.env.ADMIN_PASSWORD || '');
const openingCredits = Number(process.env.ADMIN_CREDITS || 10000);
const creditMicroFactor = 1_000_000;

if (!/^[a-z0-9_]{3,24}$/.test(username)) throw new Error('ADMIN_USERNAME 格式无效');
if (password.length < 12 || password.length > 128) throw new Error('ADMIN_PASSWORD 需为 12–128 位');
if (!Number.isSafeInteger(openingCredits) || openingCredits < 0) throw new Error('ADMIN_CREDITS 必须是非负整数');

async function writeJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, file);
}

const users = JSON.parse(await fs.readFile(usersFile, 'utf8').catch(error => error.code === 'ENOENT' ? '[]' : Promise.reject(error)));
if (users.some(user => user.username === username)) throw new Error(`账号 ${username} 已存在，未覆盖现有密码`);
const salt = randomBytes(16).toString('hex');
const derived = await scrypt(password, salt, 64);
const openingMicro = openingCredits * creditMicroFactor;
const user = { id: randomUUID(), username, role: 'admin', credits: openingCredits, creditBalanceMicro: openingMicro, creditHeldMicro: 0, passwordHash: `scrypt:${salt}:${Buffer.from(derived).toString('hex')}`, inviteCode: null, createdAt: new Date().toISOString() };
users.push(user);
await writeJson(usersFile, users);
await Promise.all(['generations', 'assets', 'files', 'credits', 'billing-holds', 'llm-usage', 'drama-projects'].map(name => fs.mkdir(path.join(dataDir, 'users', user.id, name), { recursive: true })));
await writeJson(path.join(dataDir, 'users', user.id, 'credits', 'admin-opening-balance.json'), { id: randomUUID(), userId: user.id, type: 'admin_opening_balance', amount: openingCredits, amountMicro: openingMicro, balanceAfter: openingCredits, balanceAfterMicro: openingMicro, note: '管理员初始测试积分', createdAt: new Date().toISOString() });
console.log(JSON.stringify({ username: user.username, role: user.role, credits: user.credits }));
