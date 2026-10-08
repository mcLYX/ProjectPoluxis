#!/usr/bin/env node
/**
 * 自动更新 beatmaps.json
 * 根据 beatmaps/ 文件夹的内容自动生成 public/beatmaps/beatmaps.json
 * 原文件会生成备份（带时间戳）
 *
 * 约定命名（歌曲目录内）：
 *   音频 base.mp3 · 封面 cover.jpg · 谱面 0.json/1.json/…（0 起编号）
 *   视频背景 bga.mp4 · 图片背景 bg.jpg · 故事板 story.js
 * 若歌曲目录内有 info.json（格式与 beatmaps.json 的 "type":"song" 条目类似，
 * 路径相对歌曲目录），则其字段优先，未提供的字段回落到约定命名扫描。
 * 若专辑/曲目目录内存在封面，会自动提取 Vibrant 主题色写入 accentColor。
 * 提取失败或没有封面时，保留原来的默认值 / metadata.bgScheme.accentColor。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const BEATMAPS_SRC = path.join(ROOT, 'beatmaps');
const BEATMAPS_PUBLIC = path.join(ROOT, 'public', 'beatmaps');
const OUTPUT_FILE = path.join(BEATMAPS_PUBLIC, 'beatmaps.json');

// 难度名称映射（按文件名数字排序）
const DIFFICULTY_NAMES = ['Easy', 'Normal', 'Hard', 'Insane', 'Another'];

// 约定命名（歌曲目录内）。info.json 未覆盖的字段按这里找。
const CONV_AUDIO = 'base.mp3';
const CONV_COVER = 'cover.jpg';
const CONV_BG_IMAGE = 'bg.jpg';
const CONV_BG_VIDEO = 'bga.mp4';
const CONV_STORYBOARD = 'story.js';
const CONV_CHART_RE = /^\d+\.json$/;

/** info.json 里的相对路径 → 相对 beatmaps 根的路径（拼上歌曲目录）。绝对地址原样保留。 */
function songRel(albumName, songName, p) {
  if (typeof p !== 'string' || !p) return '';
  if (/^https?:\/\//i.test(p) || p.startsWith('/')) return p;
  return path.join(albumName, songName, p).replace(/\\/g, '/');
}

// 懒加载 Vibrant。就算没装 node-vibrant，脚本也能跑，只是不会自动取色。
let _VibrantPromise = null;
async function getVibrant() {
  if (_VibrantPromise === null) {
    _VibrantPromise = (async () => {
      try {
        const mod = await import('node-vibrant/node');
        return mod.Vibrant;
      } catch (e) {
        console.warn('[warn] 未安装或无法加载 node-vibrant，将跳过封面主题色提取。');
        return null;
      }
    })();
  }
  return _VibrantPromise;
}

// 从谱面文件提取难度等级
function extractLevel(difficultyStr) {
  if (!difficultyStr) return 0;
  const match = String(difficultyStr).match(/Lv\.?\s*(\d+)/i);
  if (match) return parseInt(match[1]);
  return 0;
}

// 从封面图片提取最适合当 accent 的主题色（#rrggbb）。失败返回 null。
// 优先级: Vibrant > LightVibrant > DarkVibrant > Muted > DarkMuted > LightMuted
async function extractAccentColorFromCover(coverFilePath) {
  if (!coverFilePath) return null;
  if (!fs.existsSync(coverFilePath)) return null;
  const Vibrant = await getVibrant();
  if (!Vibrant) return null;

  try {
    // quality=3（比默认 5 稍清晰）、maxDimension=256，足够取色且速度快。
    const palette = await Vibrant.from(coverFilePath)
      .quality(3)
      .maxDimension(256)
      .getPalette();

    const preferKeys = ['Vibrant', 'LightVibrant', 'DarkVibrant', 'Muted', 'DarkMuted', 'LightMuted'];
    for (const key of preferKeys) {
      const swatch = palette && palette[key];
      if (swatch && swatch.hex) {
        const hex = String(swatch.hex).trim();
        if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
      }
    }
    return null;
  } catch (e) {
    console.warn(`  警告: 封面取色失败 ${path.relative(ROOT, coverFilePath)}: ${e.message}`);
    return null;
  }
}

// 扫描专辑目录（注意：此函数现在是 async，以支持每张图取色）
async function scanAlbums() {
  const albums = [];
  const albumDirs = fs.readdirSync(BEATMAPS_SRC, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const albumName of albumDirs) {
    const albumPath = path.join(BEATMAPS_SRC, albumName);
    const albumFiles = fs.readdirSync(albumPath, { withFileTypes: true });

    const albumCoverAbsPath = fs.existsSync(path.join(albumPath, 'cover.jpg'))
      ? path.join(albumPath, 'cover.jpg')
      : '';

    const album = {
      type: 'album',
      id: albumName.toLowerCase().replace(/[^a-z0-9]/g, '_'),
      title: albumName.replace(/_/g, ' '),
      artist: 'Various Artists',
      cover: albumCoverAbsPath
        ? path.join(albumName, 'cover.jpg').replace(/\\/g, '/')
        : '',
      accentColor: '#0ea5e9', // 默认色，下面若能取到会覆盖
      basePath: albumName,
      songs: [],
    };

    if (albumCoverAbsPath) {
      const hex = await extractAccentColorFromCover(albumCoverAbsPath);
      if (hex) album.accentColor = hex;
    }

    // 扫描歌曲目录
    const songDirs = albumFiles
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const songName of songDirs) {
      const songPath = path.join(albumPath, songName);
      const songFiles = fs.readdirSync(songPath);
      const songRelPath = (f) => path.join(albumName, songName, f).replace(/\\/g, '/');

      // info.json 优先：格式与 beatmaps.json 的 "type":"song" 条目类似，路径相对歌曲目录。
      // 未提供的字段回落到约定命名扫描。
      let info = null;
      if (songFiles.includes('info.json')) {
        try {
          info = JSON.parse(fs.readFileSync(path.join(songPath, 'info.json'), 'utf-8'));
        } catch (e) {
          console.warn(`  警告: 无法读取 ${songName}/info.json: ${e.message}，回落约定命名`);
        }
      }

      // 谱面：info.difficulties 优先，否则约定命名 N.json（0 起编号，按数字排序）。
      const chartFiles = songFiles
        .filter(f => CONV_CHART_RE.test(f))
        .sort((a, b) => parseInt(a) - parseInt(b));
      const infoDiffs = info && Array.isArray(info.difficulties) ? info.difficulties : null;
      if (!infoDiffs && chartFiles.length === 0) continue;

      // 读取第一个谱面获取歌曲信息（title/artist/bpm 兜底）
      let firstChart = null;
      if (chartFiles.length > 0) {
        try {
          firstChart = JSON.parse(fs.readFileSync(path.join(songPath, chartFiles[0]), 'utf-8'));
        } catch (e) {
          console.warn(`  警告: 无法读取 ${songName}/${chartFiles[0]}: ${e.message}`);
        }
      }
      const meta = (firstChart && firstChart.metadata) || {};

      // 音频 / 封面 / 背景 / 故事板：info 字段优先，否则约定命名。
      const audioFile = songRel(albumName, songName, info && info.audio)
        || (songFiles.includes(CONV_AUDIO) ? songRelPath(CONV_AUDIO) : '');
      const infoCoverRel = songRel(albumName, songName, info && info.cover);
      const coverFile = infoCoverRel
        || (songFiles.includes(CONV_COVER) ? songRelPath(CONV_COVER) : '');
      // 用于取色的本地封面绝对路径（info 指向远程地址时取不了色）。
      const coverAbs = info && info.cover && infoCoverRel && !/^https?:\/\//i.test(infoCoverRel)
        ? path.join(songPath, info.cover)
        : (songFiles.includes(CONV_COVER) ? path.join(songPath, CONV_COVER) : '');
      const bgImage = songRel(albumName, songName, info && info.bgImage)
        || (songFiles.includes(CONV_BG_IMAGE) ? songRelPath(CONV_BG_IMAGE) : '');
      const bgVideo = songRel(albumName, songName, info && info.bgVideo)
        || (songFiles.includes(CONV_BG_VIDEO) ? songRelPath(CONV_BG_VIDEO) : '');
      const storyboard = songRel(albumName, songName, info && info.storyboard)
        || (songFiles.includes(CONV_STORYBOARD) ? songRelPath(CONV_STORYBOARD) : '');

      // accentColor 优先级：
      //   1) 歌曲 cover 取色（封面主题色最贴近视觉）
      //   2) info.accentColor / metadata.bgScheme.accentColor
      //   3) 专辑 accentColor（上面已经由封面取色或默认色）
      //   4) 兜底 #f43f5e
      let songAccent = coverAbs ? await extractAccentColorFromCover(coverAbs) : null;
      if (!songAccent) {
        songAccent = (info && info.accentColor) || (meta.bgScheme && meta.bgScheme.accentColor) || null;
      }
      if (!songAccent) {
        songAccent = album.accentColor || '#f43f5e';
      }

      const song = {
        type: 'song',
        id: songName.toLowerCase().replace(/[^a-z0-9]/g, '_'),
        title: (info && info.title) || meta.title || songName,
        artist: (info && info.artist) || meta.artist || 'Unknown',
        bpm: (info && info.bpm) || meta.bpm || 140,
        cover: coverFile,
        accentColor: songAccent,
        audio: audioFile,
        basePath: songRelPath(''),
        difficulties: [],
      };
      if (bgImage) song.bgImage = bgImage;
      if (bgVideo) song.bgVideo = bgVideo;
      if (storyboard) song.storyboard = storyboard;
      // 故事板外部资源（"约定之外"的文件）：
      // info.json 的 `assets: [...]` **显式声明为准**（未声明时由宿主回落到
      // "story.js 同目录"拼 URL 读取）。这里转成 相对路径 → 相对 beatmaps 根 的映射，
      // 与 zip 导入的 `assets` 形态一致，于是 api.assets 可以直接命中而不用猜。
      if (info && Array.isArray(info.assets) && info.assets.length) {
        const assetMap = {};
        for (const rel of info.assets) {
          if (typeof rel !== 'string' || !rel) continue;
          const p = songRel(albumName, songName, rel);
          if (p) assetMap[rel.replace(/^\.\//, '')] = p;
        }
        if (Object.keys(assetMap).length) song.assets = assetMap;
      }

      // 解析所有难度
      if (infoDiffs) {
        for (let i = 0; i < infoDiffs.length; i++) {
          const d = infoDiffs[i] || {};
          const chartFile = songRel(albumName, songName, d.chartFile);
          if (!chartFile) continue;
          let level = typeof d.level === 'number' ? d.level : undefined;
          if (level === undefined) {
            // 尝试从本地谱面读取 metadata.difficulty 的 Lv.x
            const absChart = path.join(songPath, path.basename(String(d.chartFile || '')));
            if (fs.existsSync(absChart)) {
              try {
                const cd = JSON.parse(fs.readFileSync(absChart, 'utf-8'));
                const lv = extractLevel(cd.metadata && cd.metadata.difficulty);
                if (lv) level = lv;
              } catch (e) { /* 读取失败不影响导入 */ }
            }
          }
          // 与"约定命名"分支保持一致：名字里自带 "Lv.N" 时剥掉，
          // 否则 level 再拼一次会显示成 "Viewing Lv.7 Lv.7"。
          const rawName = d.name || DIFFICULTY_NAMES[i] || `D${i + 1}`;
          const cleanName = rawName.replace(/\s*Lv\.?\s*\d+\s*/i, '').trim() || rawName;
          song.difficulties.push({
            name: cleanName,
            level: level,
            chartFile: chartFile,
          });
        }
      } else {
        for (let i = 0; i < chartFiles.length; i++) {
          const chartFile = chartFiles[i];
          const chartPath = path.join(songPath, chartFile);
          let chartData = null;
          try {
            chartData = JSON.parse(fs.readFileSync(chartPath, 'utf-8'));
          } catch (e) {
            console.warn(`  警告: 无法读取 ${songName}/${chartFile}: ${e.message}`);
            continue;
          }

          const chartMeta = chartData.metadata || {};
          const level = extractLevel(chartMeta.difficulty) || (i + 1) * 3;
          const diffName = chartMeta.difficulty && chartMeta.difficulty.replace(/\s*Lv\.?\s*\d+\s*/i, '').trim()
            ? chartMeta.difficulty.replace(/\s*Lv\.?\s*\d+\s*/i, '').trim()
            : DIFFICULTY_NAMES[i] || `D${i + 1}`;

          song.difficulties.push({
            name: diffName,
            level: level,
            chartFile: songRelPath(chartFile),
          });
        }
      }

      if (song.difficulties.length > 0) {
        album.songs.push(song);
      }
    }

    albums.push(album);
  }

  return albums;
}

async function main() {
  console.log('扫描 beatmaps/ 目录...\n');

  const albums = await scanAlbums();

  const result = {
    version: 1,
    items: albums,
  };

  // 统计
  let totalSongs = 0;
  let totalDiffs = 0;
  for (const album of albums) {
    totalSongs += album.songs.length;
    for (const song of album.songs) {
      totalDiffs += song.difficulties.length;
    }
  }
  console.log(`找到 ${albums.length} 个专辑, ${totalSongs} 首歌曲, ${totalDiffs} 个难度\n`);

  for (const album of albums) {
    console.log(`专辑: ${album.title} (${album.songs.length} 首)  accent=${album.accentColor}${album.cover ? ' (封面取色)' : ''}`);
    for (const song of album.songs) {
      const diffs = song.difficulties.map(d => `${d.name} Lv.${d.level}`).join(', ');
      console.log(`  - ${song.title} / ${song.artist}  accent=${song.accentColor}${song.cover ? ' (封面取色)' : ''}  [${diffs}]`);
    }
    console.log('');
  }

  // 备份原文件
  if (fs.existsSync(OUTPUT_FILE)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = path.join(BEATMAPS_PUBLIC, `beatmaps.backup_${timestamp}.json`);
    fs.copyFileSync(OUTPUT_FILE, backupFile);
    console.log(`已备份原文件到: ${path.relative(ROOT, backupFile)}`);
  }

  // 确保 public/beatmaps 目录存在
  if (!fs.existsSync(BEATMAPS_PUBLIC)) {
    fs.mkdirSync(BEATMAPS_PUBLIC, { recursive: true });
  }

  // 写入新文件
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`\n已生成: ${path.relative(ROOT, OUTPUT_FILE)}`);
}

main().catch(e => {
  console.error('脚本执行失败:', e);
  process.exit(1);
});
