// SHA256 工具：字符串（生成文件）与文件（下载/归档）统一用十六进制小写表示，
// 供下载校验、清单与远端复核复用，避免各处拼凑不一致的哈希实现。

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** 计算字符串/字节的 SHA256，返回小写十六进制。 */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 流式计算文件 SHA256，避免把大安装包整体读入内存。 */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}