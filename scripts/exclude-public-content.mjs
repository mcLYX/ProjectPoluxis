// scripts/exclude-public-content.mjs
//
// 部署者私有内容（谱面 public/beatmaps/、音效 public/sounds/，以及谱面索引
// public/beatmaps.json）不随构建产物分发。该插件在构建时（vite build）把这些
// 内容从 dist 中剔除，改由部署者在其服务器上提供：
//   - 作为「在线谱面服务器」（设置 → 网络，填入 beatmaps 目录 URL），或
//   - 直接放在部署站点根目录的 /beatmaps、/sounds 下（「本机服务器」默认指向）。
//
// 注意：
//   - apply: 'build'，仅作用于构建；npm run dev 下 public/ 仍由 dev server 正常托管，
//     方便部署者本地测试自己的谱面 / 音效。
//   - 游戏内置的示范谱面（硬编码于 src/shared/demoCharts.ts）与合成器音效始终可用，
//     不会被本插件移除。

import { promises as fsp } from 'node:fs';
import path from 'node:path';

// public/ 下需要被剔除的目录（含其全部子内容）。
const EXCLUDE_DIRS = ['beatmaps', 'sounds'];
// public/ 根目录下需要被剔除的文件（谱面索引，指向上述私有内容）。
const EXCLUDE_FILES = ['beatmaps.json'];

export function excludePublicContent() {
  let outDir = 'dist';
  return {
    name: 'exclude-public-content',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    // 在产物写入磁盘前，从 bundle 中删除这些条目，避免写入大体积私有内容。
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        const norm = fileName.split('\\').join('/');
        const top = norm.split('/')[0];
        if (EXCLUDE_DIRS.includes(top) || EXCLUDE_FILES.includes(norm)) {
          delete bundle[fileName];
        }
      }
    },
    // 兜底：确保磁盘上的 dist 中也不残留这些目录 / 文件（兼容不同 Vite 版本的 public 拷贝时机）。
    async closeBundle() {
      const abs = path.isAbsolute(outDir)
        ? outDir
        : path.resolve(process.cwd(), outDir);
      const targets = [...EXCLUDE_DIRS, ...EXCLUDE_FILES].map((t) =>
        path.join(abs, t)
      );
      for (const t of targets) {
        await fsp.rm(t, { recursive: true, force: true });
      }
    },
  };
}
