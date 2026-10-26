// 可观测性（脱敏、日志存储、命令输出）单元测试。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redactor } from '../src/server/observability/redactor.js';
import { LogStore } from '../src/server/observability/store.js';
import { CommandOutputStore } from '../src/server/observability/command-output.js';

test('Redactor 替换已注册敏感值与签名查询参数', () => {
  const r = new Redactor();
  r.registerSecret('supersecret');
  assert.equal(r.redactString('use supersecret here'), 'use [redacted] here');
  assert.equal(
    r.redactString('GET https://host/path?token=abc123&x=1'),
    'GET https://host/path?token=[redacted]&x=1',
  );
  assert.equal(r.redactString('https://user:pass@host/x'), 'https://[redacted]@host/x');
});

test('Redactor 按字段名脱敏嵌套对象', () => {
  const r = new Redactor();
  const out = r.redactValue({ password: 'x', nested: { token: 'y' }, keep: 1 }) as Record<string, unknown>;
  assert.equal(out.password, '[redacted]');
  assert.equal((out.nested as Record<string, unknown>).token, '[redacted]');
  assert.equal(out.keep, 1);
});

test('LogStore 追加、按游标分页与级别过滤', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-log-'));
  const store = new LogStore({ filePath: join(dir, 'events.jsonl'), idScope: 'job-1' });

  const e1 = store.append({ timestamp: new Date().toISOString(), level: 'INFO', component: 'w', event: 'a', message: 'm1' });
  store.append({ timestamp: new Date().toISOString(), level: 'ERROR', component: 'w', event: 'b', message: 'm2' });

  const all = store.read({});
  assert.equal(all.length, 2);
  assert.equal(all[0].id, e1.id);

  // 游标续接：从第一条之后读取。
  const tail = store.read({ afterId: e1.id });
  assert.equal(tail.length, 1);
  assert.equal(tail[0].event, 'b');

  // 级别过滤：INFO 起应包含两条；ERROR 起只含一条。
  assert.equal(store.read({ level: 'INFO' }).length, 2);
  assert.equal(store.read({ level: 'ERROR' }).length, 1);

  // 订阅者能收到新事件。
  let seen = '';
  store.subscribe((e) => {
    seen = e.event;
  });
  store.append({ timestamp: new Date().toISOString(), level: 'INFO', component: 'w', event: 'c', message: 'm3' });
  assert.equal(seen, 'c');
});

test('LogStore 突破阈值后轮转并保留可续接序号', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-log-'));
  const filePath = join(dir, 'events.jsonl');
  const store = new LogStore({ filePath, idScope: 'job-1', maxBytes: 200, maxSegments: 3 });
  for (let i = 0; i < 50; i++) {
    store.append({ timestamp: new Date().toISOString(), level: 'INFO', component: 'w', event: `e${i}`, message: 'x'.repeat(20) });
  }
  const all = store.read({ limit: 1000 });
  assert.ok(all.length > 0);
  // 序号持续递增且唯一。
  const ids = all.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('CommandOutputStore 脱敏、限量与落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-cmd-'));
  const file = join(dir, 'build.log');
  const r = new Redactor();
  r.registerSecret('pwd123');
  const s = new CommandOutputStore(file, 20, r);

  s.append('line1 ok\n');
  s.append('password=pwd123\n');
  const snap = s.snapshot();
  assert.ok(!snap.includes('pwd123'));
  assert.ok(snap.includes('[redacted]'));

  // 超出容量丢弃最旧内容并置截断标记。
  s.append('A'.repeat(100));
  assert.ok(s.snapshot().includes('A'.repeat(100)));
  assert.ok(!s.snapshot().includes('line1 ok'));
  assert.equal(s.truncated, true);

  s.flush();
  assert.ok(existsSync(file));
});