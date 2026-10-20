import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDatabase, openDatabase, sql } from '../lib/db.mjs';

// 日志中心默认按时间倒序翻页；缺少时间索引时会整表扫描并把整行 JSON 送进临时排序，
// 数据量上来后刷新明显变慢。这里锁定每类日志的默认查询都能直接走索引。
test('admin log center queries read pages in index order without a full-table sort', () => {
  openDatabase({ file: ':memory:' });
  try {
    const plan = query => sql(`EXPLAIN QUERY PLAN ${query}`).all().map(row => row.detail).join(' | ');
    const pages = {
      generations: 'SELECT id, doc_json FROM generations WHERE 1=1 ORDER BY created_at DESC, id ASC LIMIT 21',
      credit_entries: 'SELECT id, doc_json FROM credit_entries WHERE 1=1 ORDER BY created_at DESC, id ASC LIMIT 21',
      llm_usage: 'SELECT id, doc_json FROM llm_usage WHERE 1=1 ORDER BY created_at DESC, id ASC LIMIT 21',
      audit_events: 'SELECT id, after_json FROM audit_events WHERE 1=1 ORDER BY created_at DESC, id ASC LIMIT 21',
      system_events: 'SELECT id, details_json FROM system_events WHERE 1=1 ORDER BY created_at DESC, id ASC LIMIT 21',
      client_logs: "SELECT id, details_json FROM system_events WHERE category = 'client_log' ORDER BY created_at DESC, id ASC LIMIT 21",
    };
    for (const [name, query] of Object.entries(pages)) {
      const detail = plan(query);
      assert.match(detail, /USING (COVERING )?INDEX/, `${name}: ${detail}`);
      assert.doesNotMatch(detail, /TEMP B-TREE/, `${name}: ${detail}`);
    }
    assert.match(plan("SELECT id FROM credit_entries WHERE generation_id = 'g1'"), /USING (COVERING )?INDEX idx_credits_generation/);
    assert.match(plan("SELECT id FROM system_events WHERE generation_id = 'g1'"), /USING (COVERING )?INDEX idx_system_events_generation/);
  } finally {
    closeDatabase({ checkpoint: false });
  }
});
