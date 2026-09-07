import { randomUUID } from 'node:crypto';
import { sql, tx } from './db.mjs';

const PUBLIC_STATUSES = new Set(['published']);
const ADMIN_STATUSES = new Set(['draft', 'published', 'archived']);
const MAX_CONTENT_LENGTH = 500_000;
const now = () => new Date().toISOString();

const ALLOWED_TAGS = new Set(['p', 'div', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'h2', 'h3', 'blockquote', 'ul', 'ol', 'li', 'a', 'img']);
const VOID_TAGS = new Set(['br', 'img']);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
}

function safeUrl(value, { image = false } = {}) {
  const url = String(value || '').trim();
  if (image && /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(url) && url.length <= 450_000) return url;
  if (/^(?:https?:\/\/|\/|#|mailto:)/i.test(url) && !/[\u0000-\u001f]/.test(url)) return url;
  return '';
}

function sanitizeAttributes(tag, rawAttributes) {
  const attributes = [];
  const pattern = /([a-z][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/gi;
  let match;
  while ((match = pattern.exec(rawAttributes || ''))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (tag === 'img' && name === 'src') {
      const url = safeUrl(value, { image:true });
      if (url) attributes.push(`src="${escapeHtml(url)}"`);
    } else if (tag === 'img' && name === 'alt') {
      attributes.push(`alt="${escapeHtml(value).slice(0, 240)}"`);
    } else if (tag === 'a' && name === 'href') {
      const url = safeUrl(value);
      if (url) attributes.push(`href="${escapeHtml(url)}"`);
    } else if (tag === 'a' && name === 'title') {
      attributes.push(`title="${escapeHtml(value).slice(0, 240)}"`);
    }
  }
  if (tag === 'img' && !attributes.some(attribute => attribute.startsWith('src='))) return '';
  if (tag === 'a' && attributes.some(attribute => attribute.startsWith('href='))) attributes.push('target="_blank"', 'rel="noopener noreferrer"');
  return attributes.length ? ` ${attributes.join(' ')}` : '';
}

function decodeBasicEntities(value) {
  return String(value || '').replace(/&(?:amp|lt|gt|quot|#39|nbsp);/gi, entity => ({ '&amp;':'&', '&lt;':'<', '&gt;':'>', '&quot;':'"', '&#39;':"'", '&nbsp;':' ' }[entity.toLowerCase()] || entity));
}

function stripAnnouncementMarkup(value) {
  return decodeBasicEntities(String(value || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|h2|h3|blockquote|li)>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeAnnouncementHtml(value) {
  const source = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (!source) throw Object.assign(new Error('公告内容不能为空'), { statusCode: 400 });
  if (!/<\/?[a-z][^>]*>/i.test(source)) return escapeHtml(source).replace(/\n/g, '<br>');
  const sanitized = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\s*(\/?)\s*([a-z][\w:-]*)([^>]*)>/gi, (match, closing, rawTag, rawAttributes) => {
      const tag = rawTag.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return '';
      if (closing) return VOID_TAGS.has(tag) ? '' : `</${tag}>`;
      const attributes = sanitizeAttributes(tag, rawAttributes);
      if (tag === 'img' && !attributes) return '';
      return `<${tag}${attributes}>`;
    });
  if (!stripAnnouncementMarkup(sanitized).trim()) throw Object.assign(new Error('公告内容不能为空'), { statusCode: 400 });
  if (Array.from(sanitized).length > MAX_CONTENT_LENGTH) throw Object.assign(new Error(`公告内容不能超过 ${MAX_CONTENT_LENGTH} 个字符`), { statusCode: 400 });
  return sanitized;
}

function contentFields(value) {
  const contentHtml = sanitizeAnnouncementHtml(value);
  return { content:contentHtml, contentHtml, contentText:stripAnnouncementMarkup(contentHtml) };
}

function announcementFromRow(row) {
  if (!row) return null;
  const fields = contentFields(row.content);
  return {
    id: row.id,
    title: row.title,
    ...fields,
    status: row.status,
    publishedAt: row.published_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function normalizeText(value, label, maxLength) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) throw Object.assign(new Error(`${label}不能为空`), { statusCode: 400 });
  if (Array.from(text).length > maxLength) throw Object.assign(new Error(`${label}不能超过 ${maxLength} 个字符`), { statusCode: 400 });
  return text;
}

function normalizeStatus(value, fallback = 'draft') {
  const status = value === undefined || value === null || value === '' ? fallback : String(value);
  if (!ADMIN_STATUSES.has(status)) throw Object.assign(new Error('公告状态无效'), { statusCode: 400 });
  return status;
}

function publicWhere() {
  return `a.status = 'published' AND (a.published_at IS NULL OR a.published_at <= :now)`;
}

export function listAdminAnnouncements({ status = '' } = {}) {
  const params = {};
  const where = [];
  if (status) {
    if (!ADMIN_STATUSES.has(status)) throw Object.assign(new Error('公告状态无效'), { statusCode: 400 });
    where.push('status = :status');
    params.status = status;
  }
  const rows = sql(`SELECT id, title, content, status, published_at, created_by, updated_by,
                           created_at, updated_at, version
                    FROM announcements
                    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                    ORDER BY updated_at DESC, id ASC`).all(params);
  return rows.map(announcementFromRow);
}

export function listNotifications(userId, { limit = 200 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 200));
  const params = { userId, now: now(), limit: safeLimit };
  const items = sql(`SELECT a.id, a.title, a.content, a.published_at, a.created_at, a.updated_at,
                            CASE WHEN r.announcement_id IS NULL THEN 0 ELSE 1 END AS is_read
                     FROM announcements a
                     LEFT JOIN announcement_reads r
                       ON r.announcement_id = a.id AND r.user_id = :userId
                     WHERE ${publicWhere()}
                     ORDER BY COALESCE(a.published_at, a.created_at) DESC, a.id ASC
                     LIMIT :limit`).all(params).map(row => {
    const fields = contentFields(row.content);
    return {
      id: row.id,
      title: row.title,
      ...fields,
      publishedAt: row.published_at || row.created_at,
      updatedAt: row.updated_at,
      isRead: Boolean(row.is_read),
    };
  });
  const unreadCount = sql(`SELECT COUNT(*) AS count
                           FROM announcements a
                           LEFT JOIN announcement_reads r
                             ON r.announcement_id = a.id AND r.user_id = :userId
                           WHERE ${publicWhere()} AND r.announcement_id IS NULL`).get({ userId, now: params.now }).count;
  return { items, unreadCount };
}

export function createAnnouncement({ title, content, status = 'draft' }, { actorUserId = null, createdAt = now() } = {}) {
  const normalizedTitle = normalizeText(title, '公告标题', 120);
  const normalizedContent = contentFields(content);
  const normalizedStatus = normalizeStatus(status);
  const id = randomUUID();
  const publishedAt = normalizedStatus === 'published' ? createdAt : null;
  const doc = { id, title: normalizedTitle, ...normalizedContent, status: normalizedStatus, publishedAt, createdBy: actorUserId, updatedBy: actorUserId, createdAt, updatedAt: createdAt, version: 1 };
  tx(() => {
    sql(`INSERT INTO announcements(id, title, content, status, published_at, created_by, updated_by, created_at, updated_at, version, doc_json)
         VALUES(:id, :title, :content, :status, :publishedAt, :createdBy, :updatedBy, :createdAt, :updatedAt, 1, :docJson)`).run({
      id, title: normalizedTitle, content: normalizedContent.content, status: normalizedStatus, publishedAt, createdBy: actorUserId, updatedBy: actorUserId, createdAt, updatedAt: createdAt, docJson: JSON.stringify(doc),
    });
  });
  return doc;
}

export function updateAnnouncement(id, input = {}, { actorUserId = null, expectedVersion } = {}) {
  const row = sql('SELECT * FROM announcements WHERE id = :id').get({ id });
  if (!row) throw Object.assign(new Error('公告不存在'), { statusCode: 404 });
  if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== row.version) {
    throw Object.assign(new Error('公告已被其他操作更新，请刷新后重试'), { statusCode: 409 });
  }
  const title = input.title === undefined ? row.title : normalizeText(input.title, '公告标题', 120);
  const content = input.content === undefined ? contentFields(row.content) : contentFields(input.content);
  const status = normalizeStatus(input.status, row.status);
  const updatedAt = now();
  const publishedAt = status === 'published' ? (row.published_at || updatedAt) : null;
  const version = row.version + 1;
  const doc = { id: row.id, title, ...content, status, publishedAt, createdBy: row.created_by, updatedBy: actorUserId, createdAt: row.created_at, updatedAt, version };
  tx(() => {
    const result = sql(`UPDATE announcements
         SET title = :title, content = :content, status = :status, published_at = :publishedAt,
             updated_by = :updatedBy, updated_at = :updatedAt, version = :version, doc_json = :docJson
         WHERE id = :id AND version = :expectedVersion`).run({
      id: row.id, title, content:content.content, status, publishedAt, updatedBy: actorUserId, updatedAt, version, expectedVersion: row.version, docJson: JSON.stringify(doc),
    });
    if (result.changes !== 1) throw Object.assign(new Error('公告已被其他操作更新，请刷新后重试'), { statusCode: 409 });
  });
  return doc;
}

export function markNotificationRead(userId, announcementId, readAt = now()) {
  const result = tx(() => {
    const exists = sql(`SELECT 1 AS found FROM announcements a WHERE a.id = :announcementId AND ${publicWhere()}`).get({ announcementId, now: readAt });
    if (!exists) throw Object.assign(new Error('消息不存在'), { statusCode: 404 });
    sql(`INSERT INTO announcement_reads(announcement_id, user_id, read_at)
         VALUES(:announcementId, :userId, :readAt)
         ON CONFLICT(announcement_id, user_id) DO UPDATE SET read_at = excluded.read_at`).run({ announcementId, userId, readAt });
    return { ok: true };
  });
  return result;
}

export function markAllNotificationsRead(userId, readAt = now()) {
  return tx(() => sql(`INSERT INTO announcement_reads(announcement_id, user_id, read_at)
                       SELECT a.id, :userId, :readAt
                       FROM announcements a
                       LEFT JOIN announcement_reads r
                         ON r.announcement_id = a.id AND r.user_id = :userId
                       WHERE ${publicWhere()} AND r.announcement_id IS NULL`).run({ userId, readAt, now: readAt }).changes);
}

export const __test = { announcementFromRow, contentFields, normalizeText, normalizeStatus, publicWhere, PUBLIC_STATUSES, sanitizeAnnouncementHtml, stripAnnouncementMarkup };
