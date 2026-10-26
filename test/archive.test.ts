// 归档生成与解包的往返测试，验证条目名安全与内容一致。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extract } from 'tar-stream';
import { createArchive } from '../src/server/bundle/archive.js';

async function listEntries(tarPath: string): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    const ext = extract();
    ext.on('entry', (_header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c) => chunks.push(c as Buffer));
      stream.on('end', () => {
        entries.set(_header.name, Buffer.concat(chunks));
        next();
      });
    });
    ext.on('finish', resolve);
    ext.on('error', reject);
    createReadStream(tarPath).pipe(ext);
  });
  return entries;
}

test('createArchive 打包目录、字符串与文件并正确解出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-archive-'));
  const tarPath = join(dir, 'bundle.tar');
  const localFile = join(dir, 'sample.txt');
  writeFileSync(localFile, 'hello tar');

  const total = await createArchive(tarPath, {
    strings: [
      { path: 'manifest.json', content: '{"a":1}' },
      { path: 'build/Dockerfile', content: 'FROM scratch\n' },
    ],
    files: [{ path: 'build/packages/toolkit.run', localPath: localFile, size: 9 }],
  });

  assert.ok(total > 0);
  const entries = await listEntries(tarPath);
  assert.ok(entries.has('build/'));
  assert.ok(entries.has('build/packages/'));
  assert.ok(entries.has('deploy/'));
  assert.equal(entries.get('manifest.json')?.toString(), '{"a":1}');
  assert.equal(entries.get('build/packages/toolkit.run')?.toString(), 'hello tar');
});

test('createArchive 拒绝绝对路径与逃逸条目', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-archive-'));
  const tarPath = join(dir, 'bad.tar');
  await assert.rejects(
    () => createArchive(tarPath, { strings: [{ path: '/etc/passwd', content: 'x' }], files: [] }),
    /路径不合法/,
  );
  await assert.rejects(
    () => createArchive(tarPath, { strings: [{ path: '../evil', content: 'x' }], files: [] }),
    /路径不合法/,
  );
});