// 应用路径与目录约定。运行产物写入用户数据目录，不写源码树；
// catalog/ 与 templates/ 是版本控制内的生成依据，与本模块相对定位，不依赖启动目录。

import { accessSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 向上定位同时包含 catalog/ 与 templates/ 的应用根目录（即仓库/发布包根）。 */
export function findAppRoot(startDir: string = here): string {
  let dir = resolve(startDir);
  for (;;) {
    const parent = dirname(dir);
    const hasFootprint =
      isReadable(join(dir, 'catalog')) && isReadable(join(dir, 'templates'));
    if (hasFootprint) return dir;
    if (dir === parent) break;
    dir = parent;
  }
  // 兜底：返回当前工作目录，调用方会在读取失败时显式报错。
  return process.cwd();
}

function isReadable(p: string): boolean {
  try {
    accessSync(p, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export const appRoot = findAppRoot();

export function catalogDir(): string {
  return join(appRoot, 'catalog');
}

export function templatesDir(): string {
  return join(appRoot, 'templates');
}

/** 用户数据目录；可用 ASCEND_ENV_DATA_DIR 覆盖（测试隔离用）。 */
export function dataDir(): string {
  if (process.env.ASCEND_ENV_DATA_DIR) return resolve(process.env.ASCEND_ENV_DATA_DIR);
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'ascend-env');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? home, 'ascend-env');
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'ascend-env');
}

export function logsDir(): string {
  return join(dataDir(), 'logs');
}

export function cacheDir(): string {
  return join(dataDir(), 'cache');
}

export function jobsDir(): string {
  return join(dataDir(), 'jobs');
}

export interface DataPaths {
  appRoot: string;
  dataDir: string;
  logsDir: string;
  cacheDir: string;
  jobsDir: string;
  catalogDir: string;
  templatesDir: string;
}

export function getDataPaths(): DataPaths {
  return {
    appRoot,
    dataDir: dataDir(),
    logsDir: logsDir(),
    cacheDir: cacheDir(),
    jobsDir: jobsDir(),
    catalogDir: catalogDir(),
    templatesDir: templatesDir(),
  };
}