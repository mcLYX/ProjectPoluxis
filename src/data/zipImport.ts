import { unzip } from 'fflate';
import type { AlbumItem, BeatmapItem, SongItem, DifficultyEntry } from '../types/beatmap';
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

/**
 * 将 metadata.difficulty 解析为纯难度名 + 等级数字：
 *  - 字符串形如 "Hard Lv.6" → { name: 'Hard', level: 6 }
 *  - 纯字符串 "Hard"（未显式使用 Lv.x 格式）→ { name: 'Hard' }（不解析等级，不显示 Lv.）
 *  - 数字只作为整体难度名，不再单独解析为等级
 *  - 空 / 未定义 → { name: 'NORMAL' }
 * 这是修复“把整段难度数据当难度名并补上 Lv.1”的核心逻辑。
 */
export function resolveDifficulty(raw: unknown): { name: string; level?: number } {
  if (typeof raw === 'number') {
    return { name: String(raw) };
  }
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { name: 'NORMAL' };
  const m = s.match(/\s*[Ll]v\.?\s*(\d+(?:\.\d+)?)\s*$/);
  if (m) {
    return { name: s.slice(0, m.index).trim() || 'NORMAL', level: Number(m[1]) };
  }
  return { name: s };
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
    const d = resolveDifficulty(meta.difficulty);
    difficulties.push({
      name: d.name || extOf(ce.name) || 'NORMAL',
      level: d.level,
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
    const d = resolveDifficulty(meta.difficulty);
    return { difficulty: d.name, level: d.level, noteCount: notes };
  } catch {
    return null;
  }
}

/** 将 beatmaps.json 中的相对文件路径解析为 zip 内对应文件的 idb:// 引用。 */
async function resolveZipFileRef(
  raw: unknown,
  entryMap: Map<string, ZipEntry>,
): Promise<string> {
  if (typeof raw !== 'string' || !raw) return '';
  if (/^https?:\/\//.test(raw) || raw.startsWith('blob:') || raw.startsWith('idb://')) return raw;
  const clean = raw.replace(/^\.?\//, '');
  const entry = entryMap.get(clean) ?? entryMap.get(clean.replace(/^\/+/, ''));
  if (!entry) return '';
  const ext = extOf(entry.name);
  const file = new File([entry.data as unknown as BlobPart], entry.name, { type: mimeFromExt(ext) });
  return storeFileDedup(file);
}

/** 将 beatmaps.json 的任意结构规整为本地 BeatmapItem 树，文件引用落到 idb。 */
async function normalizeZipManifest(raw: unknown, entryMap: Map<string, ZipEntry>): Promise<BeatmapItem[]> {
  const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');

  const normDifficulty = async (d: unknown): Promise<DifficultyEntry> => {
    const o = (d ?? {}) as Record<string, unknown>;
    const chartFile = await resolveZipFileRef(o.chartFile, entryMap);
    return {
      name: asStr(o.name) || 'Normal',
      // level 为可选键：未提供则不显示难度等级
      level: typeof o.level === 'number' ? (o.level as number) : undefined,
      chartFile,
      noteCount: typeof o.noteCount === 'number' ? (o.noteCount as number) : undefined,
    };
  };

  const normSong = async (o: Record<string, unknown>): Promise<SongItem | null> => {
    const id = asStr(o.id);
    if (!id) return null;
    const [cover, audio, difficulties] = await Promise.all([
      resolveZipFileRef(o.cover, entryMap),
      resolveZipFileRef(o.audio, entryMap),
      Promise.all(
        (Array.isArray(o.difficulties) ? (o.difficulties as unknown[]) : []).map(normDifficulty),
      ),
    ]);
    return {
      type: 'song',
      id,
      title: asStr(o.title) || '未命名',
      artist: asStr(o.artist),
      bpm: typeof o.bpm === 'number' ? (o.bpm as number) : 0,
      cover,
      accentColor: asStr(o.accentColor) || undefined,
      audio,
      basePath: '',
      difficulties,
    };
  };

  const normNode = async (rawNode: unknown): Promise<BeatmapItem | null> => {
    if (!rawNode || typeof rawNode !== 'object') return null;
    const o = rawNode as Record<string, unknown>;
    const explicit = asStr(o.type);
    const childrenArr = Array.isArray(o.songs) ? (o.songs as unknown[]) : [];
    const looksLikeSong =
      Array.isArray(o.difficulties) || typeof o.audio === 'string' || typeof o.bpm === 'number';
    const isAlbum = explicit === 'album' || (childrenArr.length > 0 && !looksLikeSong);
    if (explicit === 'song' || (!isAlbum && looksLikeSong)) {
      return normSong(o);
    }
    const id = asStr(o.id) || asStr(o.title) || `album-${generateId('a')}`;
    const children = (await Promise.all(childrenArr.map(normNode))).filter(
      (n): n is BeatmapItem => n !== null,
    );
    const cover = await resolveZipFileRef(o.cover, entryMap);
    return {
      type: 'album',
      id,
      title: asStr(o.title) || '未命名专辑',
      artist: asStr(o.artist),
      cover,
      accentColor: asStr(o.accentColor) || undefined,
      basePath: '',
      songs: children,
    };
  };

  const items: BeatmapItem[] = [];
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const arr = Array.isArray(o.items)
      ? (o.items as unknown[])
      : Array.isArray(raw)
        ? (raw as unknown[])
        : [];
    const norm = await Promise.all(arr.map(normNode));
    items.push(...(norm.filter((n): n is BeatmapItem => n !== null)));
  }
  return items;
}

/** 收集树中所有叶节点（歌曲），用于“导入到指定专辑”时扁平加入。 */
function collectLeafSongs(nodes: BeatmapItem[]): SongItem[] {
  const out: SongItem[] = [];
  const walk = (n: BeatmapItem) => {
    if (n.type === 'album') n.songs.forEach(walk);
    else out.push(n);
  };
  nodes.forEach(walk);
  return out;
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

  const warnings: string[] = [];

  // 顶层 beatmaps.json：按其中描述的树结构导入（相对路径解析为 zip 内文件的 idb:// 引用）。
  const manifestEntry = entries.find((e) => e.name.replace(/^\/+/, '').toLowerCase() === 'beatmaps.json');
  if (manifestEntry) {
    try {
      const raw = JSON.parse(new TextDecoder().decode(manifestEntry.data));
      const entryMap = new Map(entries.map((e) => [e.name, e]));
      const items = await normalizeZipManifest(raw, entryMap);
      if (items.length) {
        const leafSongs = collectLeafSongs(items);
        const wrapperAlbum: AlbumItem = {
          type: 'album',
          id: generateId('album'),
          title: file.name.replace(/\.zip$/i, '') || 'Imported Pack',
          artist: '',
          cover: leafSongs.find((s) => s.cover)?.cover || '',
          accentColor: leafSongs[0]?.accentColor || '#22d3ee',
          basePath: '',
          songs: items,
        };
        return {
          album: wrapperAlbum,
          songs: opts?.targetAlbumId ? leafSongs : undefined,
          songCount: leafSongs.length,
          difficultyCount: leafSongs.reduce((n, s) => n + s.difficulties.length, 0),
          warnings: [],
        };
      }
      warnings.push(
        `「${file.name}」beatmaps.json 为空或结构无法识别，已按文件夹结构导入`,
      );
    } catch {
      warnings.push(
        `「${file.name}」beatmaps.json 解析失败，已按文件夹结构导入`,
      );
    }
  }

  const groups = groupBySong(entries);
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

  const meta = parseChartMeta(await chart.text());
  if (meta) {
    title = meta.title || title;
    artist = meta.artist || '';
    bpm = meta.bpm || 120;
    accentColor = meta.accentColor || accentColor;
    noteCount = meta.noteCount;
  }

  const audioRef = audio ? await storeFileDedup(audio) : '';
  const coverRef = cover ? await storeFileDedup(cover) : '';
  const difficulties: DifficultyEntry[] = [];
  const chartRef = await storeFileDedup(chart);
  const d = resolveDifficulty(meta?.difficulty);
  difficulties.push({ name: d.name, level: d.level, chartFile: chartRef, noteCount });

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
