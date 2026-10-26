// 构建前端静态资源：用 esbuild 将 src/web 下的 TypeScript 打包为单一 app.js，
// 并把 HTML/CSS 复制到 dist/web。后端由 tsc 编译到 dist（package.json 的 build 已先执行 tsc）。
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const outDir = resolve(root, 'dist/web');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [resolve(root, 'src/web/app.ts')],
  outfile: resolve(outDir, 'app.js'),
  bundle: true,
  minify: false,
  sourcemap: false,
  platform: 'browser',
  format: 'iife',
  target: ['es2020'],
  logLevel: 'info',
});

for (const name of ['index.html', 'style.css']) {
  cpSync(resolve(root, 'src/web', name), resolve(outDir, name));
}

// xterm.js 的 CSS 由依赖提供，直接复制到静态目录以便页面引用。
const xtermCss = resolve(root, 'node_modules/@xterm/xterm/css/xterm.css');
cpSync(xtermCss, resolve(outDir, 'xterm.css'));

console.log('[build] web assets written to dist/web');