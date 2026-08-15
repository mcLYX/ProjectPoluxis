import { unzip } from 'fflate';
import type { AlbumItem, SongItem, DifficultyEntry } from '../types/beatmap';
import { storeFileDedup, generateId } from './idb';

const AUDIO_EXT = ['mp3', 'ogg', 'wav', 'm4a', 'flac', 'webm', 'aac'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
const CHART_EXT = ['json', 'chart'];

// ---- Robustness limits ----
const MAX_SONGS_PER_IMPORT = 200;
const MAX_LOOSE_FILES = 50;
const MAX_ZIP_BYTES = 600 * 1024 * 1024; // 600MB
const ALLOWED_LOOSE_EXT = [...CHART_EXT, ...AUDIO_EXT, ...IMAGE_EXT];

type TranslateFn = (key: string, params?: Record<string, string>) => string;

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function mimeFromExt(ext: string): string {
  if (AUDIO_EXT.includes(ext)) return `audio/${ext === 'mp3' ? 'mpeg' : ext}`;
  if (IMAGE_EXT.includes(ext)) return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  if (ext === 'json') return 'application/json';
  if (ext === 'chart') return 'application/json';
  return 'application/octet-stream';
}

function unzipAsync(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(data, (err, files) => (err ? reject(err) : resolve(files)));
  });
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

interface ChartMeta {
  title?: string;
  artist?: string;
  bpm?: number;
  difficulty?: string;
  accentColor?: string;
  noteCount?: number;
}

export function parseChartMeta(text: string): ChartMeta | null {
  try {
    const obj = JSON.parse(text);
    const meta = obj.metadata || {};
    const notes = Array.isArray(obj.notes) ? obj.notes.length : obj.noteCount ?? 0;
    const accentColor = obj.bgScheme?.accentColor || meta.bgScheme?.accentColor || meta.color;
    return {
      title: meta.title,
      artist: meta.artist,
      bpm: meta.bpm,
      difficulty: meta.difficulty,
      accentColor,
      noteCount: notes,
    };
  } catch {
    return null;
  }
}

interface GroupedSong {
  folder: string;
  entries: ZipEntry[];
}

function groupBySong(entries: ZipEntry[]): GroupedSong[] {
  const map = new Map<string, ZipEntry[]>();
  for (const e of entries) {
    const top = e.name.includes('/') ? e.name.split('/')[0] : '';
    if (!map.has(top)) map.set(top, []);
    map.get(top)!.push(e);
  }
  return Array.from(map.entries()).map(([folder, ents]) => ({ folder, entries: ents }));
}

function tailName(group: GroupedSong, fullName: string): string {
  return group.folder ? fullName.slice(group.folder.length + 1) : fullName;
}

function findInGroup(group: GroupedSong, exts: string[]): ZipEntry | undefined {
  return group.entries.find((e) => exts.includes(extOf(tailName(group, e.name))));
}

function groupHasChart(group: GroupedSong): boolean {
  return group.entries.some((e) => CHART_EXT.includes(extOf(tailName(group, e.name))));
}

async function buildSong(group: GroupedSong, fallbackTitle: string): Promise<SongItem> {
  const audio = findInGroup(group, AUDIO_EXT);
  const cover = findInGroup(group, IMAGE_EXT);
  const chartEntries = group.entries.filter((e) => CHART_EXT.includes(extOf(tailName(group, e.name))));

  const difficulties: DifficultyEntry[] = [];
  let firstMeta: ChartMeta | null = null;

  for (const ce of chartEntries) {
    const text = new TextDecoder().decode(ce.data);
    const meta = parseChartMeta(text);
    if (!meta) continue;
    if (!firstMeta) firstMeta = meta;
    const file = new File([ce.data as unknown as BlobPart], 'chart.json', { type: 'application/json' });
    const ref = await storeFileDedup(file);
    const level = typeof meta.difficulty === 'number' ? meta.difficulty : parseInt(String(meta.difficulty), 10) || 1;
    difficulties.push({
      name: meta.difficulty || extOf(ce.name) || 'NORMAL',
      level,
      chartFile: ref,
      noteCount: meta.noteCount,
    });
  }

  const audioRef = audio
    ? await storeFileDedup(new File([audio.data as unknown as BlobPart], audio.name, { type: mimeFromExt(extOf(audio.name)) }))
    : '';
  const coverRef = cover
    ? await storeFileDedup(new File([cover.data as unknown as BlobPart], cover.name, { type: mimeFromExt(extOf(cover.name)) }))
    : '';

  return {
    type: 'song',
    id: generateId('song'),
    title: firstMeta?.title || fallbackTitle,
    artist: firstMeta?.artist || '',
    bpm: firstMeta?.bpm || 120,
    cover: coverRef,
    accentColor: firstMeta?.accentColor || '#22d3ee',
    audio: audioRef,
    basePath: '',
    difficulties,
  };
}

export interface ZipImportResult {
  album: AlbumItem;
  songs?: SongItem[];
  songCount: number;
  difficultyCount: number;
  /** Non-fatal issues encountered while importing (skipped folders, missing audio, etc.). */
  warnings?: string[];
}

export interface ChartMetaLite {
  difficulty?: string;
  level?: number;
  noteCount?: number;
}

/** Parse a chart file (already a File/Blob) to extract difficulty name/level. */
export async function readChartMeta(file: File): Promise<ChartMetaLite | null> {
  try {
    const text = await file.text();
    const obj = JSON.parse(text);
    const meta = obj.metadata || {};
    const notes = Array.isArray(obj.notes) ? obj.notes.length : obj.noteCount ?? 0;
    const difficulty = meta.difficulty;
    const level = typeof difficulty === 'number' ? difficulty : parseInt(String(difficulty), 10) || 1;
    return { difficulty: difficulty ?? 'NORMAL', level, noteCount: notes };
  } catch {
    return null;
  }
}

export async function importZip(
  file: File,
  opts?: { targetAlbumId?: string | null; t?: TranslateFn },
): Promise<ZipImportResult> {
  const t = opts?.t;
  if (extOf(file.name) !== 'zip') {
    throw new Error(t ? t('import.errorNotZip') : '请选择 .zip 压缩包进行导入');
  }
  if (file.size > MAX_ZIP_BYTES) {
    throw new Error(t ? t('import.errorTooLarge') : '压缩包过大（上限 600MB）');
  }

  const buffer = new Uint8Array(await file.arrayBuffer());
  const files = await unzipAsync(buffer);
  const entries: ZipEntry[] = Object.entries(files).map(([name, data]) => ({ name, data }));

  const groups = groupBySong(entries);
  const warnings: string[] = [];
  const songs: SongItem[] = [];

  for (const g of groups) {
    if (songs.length >= MAX_SONGS_PER_IMPORT) {
      warnings.push(
        t ? t('import.warnTooMany', { max: String(MAX_SONGS_PER_IMPORT) }) : `超过单次导入上限（${MAX_SONGS_PER_IMPORT}）`,
      );
      break;
    }
    if (!groupHasChart(g)) {
      warnings.push(
        t ? t('import.warnNoChart', { name: g.folder || file.name }) : `已跳过「${g.folder || file.name}」：缺少谱面文件`,
      );
      continue;
    }
    const fallbackTitle = g.folder || file.name.replace(/\.zip$/i, '');
    const song = await buildSong(g, fallbackTitle);
    if (!song.audio) {
      warnings.push(t ? t('import.warnNoAudio', { name: song.title }) : `「${song.title}」缺少音频文件`);
    }
    songs.push(song);
  }

  const difficultyCount = songs.reduce((n, s) => n + s.difficulties.length, 0);
  const album: AlbumItem = {
    type: 'album',
    id: generateId('album'),
    title: file.name.replace(/\.zip$/i, '') || 'Imported Pack',
    artist: '',
    cover: songs.find((s) => s.cover)?.cover || '',
    accentColor: songs[0]?.accentColor || '#22d3ee',
    basePath: '',
    songs,
  };

  return {
    album,
    songs: opts?.targetAlbumId ? songs : undefined,
    songCount: songs.length,
    difficultyCount,
    warnings,
  };
}

/**
 * Import loose files (a chart json / audio / cover, one or more) as a single
 * new track. Returns the wrapped album (root) or `songs` when a target album is set.
 */
export async function importLooseFiles(
  files: File[],
  opts?: { targetAlbumId?: string | null; t?: TranslateFn },
): Promise<ZipImportResult> {
  const t = opts?.t;
  if (!files.length) throw new Error(t ? t('import.errorNoFiles') : '未选择文件');
  if (files.length > MAX_LOOSE_FILES) {
    throw new Error(
      t ? t('import.errorTooManyFiles', { max: String(MAX_LOOSE_FILES) }) : `一次最多选择 ${MAX_LOOSE_FILES} 个文件`,
    );
  }

  const invalid = files.filter((f) => !ALLOWED_LOOSE_EXT.includes(extOf(f.name)));
  if (invalid.length) {
    const exts = [...new Set(invalid.map((f) => extOf(f.name) || f.name))].join(', ');
    throw new Error(t ? t('import.errorInvalidType', { exts }) : `不支持的文件类型：${exts}`);
  }

  const chart = files.find((f) => CHART_EXT.includes(extOf(f.name)));
  if (!chart) {
    throw new Error(t ? t('import.errorNoChart') : '未找到谱面文件（.json / .chart）');
  }

  const audio = files.find((f) => AUDIO_EXT.includes(extOf(f.name)));
  const cover = files.find((f) => IMAGE_EXT.includes(extOf(f.name)));

  let title = files[0].name.replace(/\.[^.]+$/, '') || 'New Track';
  let artist = '';
  let bpm = 120;
  let accentColor = '#22d3ee';
  let noteCount: number | undefined;
  let difficultyName = 'NORMAL';
  let level = 1;

  const meta = parseChartMeta(await chart.text());
  if (meta) {
    title = meta.title || title;
    artist = meta.artist || '';
    bpm = meta.bpm || 120;
    accentColor = meta.accentColor || accentColor;
    noteCount = meta.noteCount;
    if (meta.difficulty != null) {
      difficultyName = String(meta.difficulty);
      level = typeof meta.difficulty === 'number' ? meta.difficulty : parseInt(String(meta.difficulty), 10) || 1;
    }
  }

  const audioRef = audio ? await storeFileDedup(audio) : '';
  const coverRef = cover ? await storeFileDedup(cover) : '';
  const difficulties: DifficultyEntry[] = [];
  const chartRef = await storeFileDedup(chart);
  difficulties.push({ name: difficultyName, level, chartFile: chartRef, noteCount });

  const song: SongItem = {
    type: 'song',
    id: generateId('song'),
    title,
    artist,
    bpm,
    cover: coverRef,
    accentColor,
    audio: audioRef,
    basePath: '',
    difficulties,
  };

  const album: AlbumItem = {
    type: 'album',
    id: generateId('album'),
    title,
    artist,
    cover: coverRef,
    accentColor,
    basePath: '',
    songs: [song],
  };

  const warnings = audio
    ? []
    : [t ? t('import.warnNoAudio', { name: title }) : `「${title}」缺少音频文件`];

  return {
    album,
    songs: opts?.targetAlbumId ? [song] : undefined,
    songCount: 1,
    difficultyCount: difficulties.length,
    warnings,
  };
}
