#!/usr/bin/env node
/**
 * 自动更新 beatmaps.json
 * 根据 beatmaps/ 文件夹的内容自动生成 public/beatmaps/beatmaps.json
 * 原文件会生成备份（带时间戳）
 *
 * 若专辑/曲目目录内存在 cover.jpg，会自动提取封面的 Vibrant 主题色写入 accentColor。
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

      // 查找谱面文件（数字.json）
      const chartFiles = songFiles
        .filter(f => /^\d+\.json$/.test(f))
        .sort((a, b) => parseInt(a) - parseInt(b));

      if (chartFiles.length === 0) continue;

      // 读取第一个谱面获取歌曲信息
      let firstChart = null;
      try {
        firstChart = JSON.parse(fs.readFileSync(path.join(songPath, chartFiles[0]), 'utf-8'));
      } catch (e) {
        console.warn(`  警告: 无法读取 ${songName}/${chartFiles[0]}: ${e.message}`);
        continue;
      }

      const meta = firstChart.metadata || {};

      // 查找音频文件
      let audioFile = '';
      const audioExts = ['base.mp3', 'audio.mp3', 'song.mp3'];
      for (const ext of audioExts) {
        if (songFiles.includes(ext)) {
          audioFile = path.join(albumName, songName, ext).replace(/\\/g, '/');
          break;
        }
      }
      // 找任意 mp3 文件
      if (!audioFile) {
        const mp3Files = songFiles.filter(f => f.endsWith('.mp3'));
        if (mp3Files.length > 0) {
          audioFile = path.join(albumName, songName, mp3Files[0]).replace(/\\/g, '/');
        }
      }

      // 查找封面
      const songCoverAbsPath = songFiles.includes('cover.jpg')
        ? path.join(songPath, 'cover.jpg')
        : '';
      const coverFile = songCoverAbsPath
        ? path.join(albumName, songName, 'cover.jpg').replace(/\\/g, '/')
        : '';

      // accentColor 优先级：
      //   1) 歌曲 cover 取色（封面主题色最贴近视觉）
      //   2) metadata.bgScheme.accentColor（谱面内手工指定的强调色，作为封面缺失时的补充）
      //   3) 专辑 accentColor（上面已经由封面取色或默认色）
      //   4) 兜底 #f43f5e
      let songAccent = songCoverAbsPath ? await extractAccentColorFromCover(songCoverAbsPath) : null;
      if (!songAccent) {
        songAccent = (meta.bgScheme && meta.bgScheme.accentColor) || null;
      }
      if (!songAccent) {
        songAccent = album.accentColor || '#f43f5e';
      }

      const song = {
        type: 'song',
        id: songName.toLowerCase().replace(/[^a-z0-9]/g, '_'),
        title: meta.title || songName,
        artist: meta.artist || 'Unknown',
        bpm: meta.bpm || 140,
        cover: coverFile,
        accentColor: songAccent,
        audio: audioFile,
        basePath: path.join(albumName, songName).replace(/\\/g, '/'),
        difficulties: [],
      };

      // 解析所有难度
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
          chartFile: path.join(albumName, songName, chartFile).replace(/\\/g, '/'),
        });
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
