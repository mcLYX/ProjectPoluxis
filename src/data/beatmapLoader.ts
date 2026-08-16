import {
  BeatmapItem,
  BeatmapsManifest,
  AlbumItem,
  SongItem,
  DifficultyEntry,
} from '../types/beatmap';
import type { ChartData } from '../types/game';
import { parseAndValidateChart } from '../utils/chartParser';
import { DEMO_CHARTS } from './demoCharts';
import {
  getLibrary,
  preloadIdbUrls,
  getCachedIdbUrl,
  resolveIdbUrl,
} from './idb';
import { getLibraryVersion } from './libraryStore';
import { getCurrentServer } from './onlineServers';

// Local fallbacks (previously imported from removed modules)
const BACKUP_BG_SCHEME = { gradientStart: '#050c1e', gradientEnd: '#1b072c', accentColor: '#00f0ff' };
const BACKUP_BPMCONFIG = { min: 120, max: 200 };
const DEFAULT_NOTE_COLOR = '#22d3ee';

function getFallbackChartData(): ChartData {
  return Object.values(DEMO_CHARTS)[0];
}

const BASE_URL = import.meta.env.BASE_URL;
const FALLBACK_SONG_ID = 'fallback-song';
const FALLBACK_BG = `${BASE_URL}backgrounds/fallback.jpg`;
const UNKNOWN_COVER = `${BASE_URL}covers/unknown.png`;

export function isFallbackSong(songId: string): boolean {
  return songId === FALLBACK_SONG_ID || songId.startsWith('fallback');
}

export function getFallbackChart(_id?: string): ChartData {
  return getFallbackChartData();
}

export async function loadChartForDifficulty(
  item: SongItem,
  difficultyIndex: number,
): Promise<ChartData> {
  const diff = item.difficulties[difficultyIndex];
  if (!diff) throw new Error('难度索引无效');
  const raw = diff.chartFile;
  if (!raw) return getFallbackChart();
  // 内置谱面：直接返回打包进 JS 的 DEMO_CHARTS，不联网
  if (raw.startsWith('embedded://')) {
    const id = raw.slice('embedded://'.length);
    const chart = DEMO_CHARTS[id];
    if (chart) return JSON.parse(JSON.stringify(chart));
    return getFallbackChart();
  }
  try {
    const url = raw.startsWith('idb://') ? await resolveIdbUrl(raw) : resolveBeatmapUrl(raw);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`谱面加载失败: ${res.status}`);
    const json = await res.json();
    const result = parseAndValidateChart(json);
    if (!result.valid || !result.chart) throw new Error(result.error || '谱面校验失败');
    if (result.warnings?.length) {
      console.warn(`谱面「${item.title}」已修补加载:`, result.warnings);
    }
    return result.chart;
  } catch (e) {
    console.error('加载谱面出错', e);
    return getFallbackChart();
  }
}

/**
 * 将难度名（可能形如 "Hard Lv.6" / "Easy Lv.3" / "Test Lv.0"）解析为
 * 纯净名称与等级数字。无 Lv 后缀时等级记为 0（即不强制显示等级）。
 */
export function parseDifficultyMeta(raw: string): { name: string; level: number } {
  const m = raw.match(/\s*[Ll]v\.?\s*(\d+(?:\.\d+)?)\s*$/);
  if (m) {
    return { name: raw.slice(0, m.index).trim(), level: Number(m[1]) };
  }
  return { name: raw, level: 0 };
}

export function resolveBeatmapUrl(url?: string): string {
  if (!url) return '';
  if (url.startsWith('idb://')) {
    const id = url.slice('idb://'.length);
    return getCachedIdbUrl(id) || url;
  }
  if (/^https?:\/\//.test(url) || url.startsWith('blob:')) return url;
  return `${BASE_URL}${url.replace(/^\//, '')}`;
}

export function buildBuiltinAlbum(): AlbumItem {
  const entries = Object.entries(DEMO_CHARTS);
  const bySong = new Map<string, { id: string; chart: ChartData }[]>();
  entries.forEach(([id, chart]) => {
    const sid = id.includes('-') ? id.split('-')[0] : id;
    if (!bySong.has(sid)) bySong.set(sid, []);
    bySong.get(sid)!.push({ id, chart });
  });

  const songs: SongItem[] = [];
  bySong.forEach((charts, sid) => {
    const isFb = sid === 'fallback';
    const base = isFb ? '' : `${BASE_URL}beatmaps/${sid}/`;
    const difficulties = charts.map(({ id, chart }) => {
      const dmeta = parseDifficultyMeta(chart.metadata.difficulty);
      return {
        name: dmeta.name,
        level: dmeta.level,
        // 内置谱面直接引用打包进 JS 的 DEMO_CHARTS，避免联网 404 后再回退
        chartFile: isFb ? '' : `embedded://${id}`,
        noteCount: Array.isArray(chart.notes) ? chart.notes.length : 0,
      };
    });
    songs.push({
      type: 'song',
      id: isFb ? FALLBACK_SONG_ID : sid,
      title: isFb ? '敬请期待' : charts[0].chart.metadata.title,
      artist: isFb ? '' : charts[0].chart.metadata.artist,
      bpm: isFb ? 120 : charts[0].chart.metadata.bpm,
      cover: isFb ? UNKNOWN_COVER : `${base}cover.jpg`,
      accentColor: isFb ? '#64748b' : charts[0].chart.metadata.bgScheme?.accentColor || DEFAULT_NOTE_COLOR,
      audio: isFb ? '' : `${base}audio.mp3`,
      basePath: base,
      difficulties,
    });
  });

  return {
    type: 'album',
    id: 'builtin-album',
    title: 'Built-in',
    artist: '',
    cover: '',
    accentColor: '#22d3ee',
    basePath: '',
    songs,
  };
}

export async function loadAudioForSong(item: SongItem, audioManager: any): Promise<void> {
  if (!item.audio) return;
  try {
    await audioManager.loadAudioURL(resolveBeatmapUrl(item.audio));
  } catch (e) {
    console.error('加载音频失败', e);
  }
}

// ---------- 在线服务器 / 清单规范化 ----------

/**
 * 将任意（可能损坏、结构不规则）的 JSON 规整为严格的递归树模型：
 * - 顶层 song / album 均支持
 * - album 可嵌套 album、可为空、可混排 album 与 song
 * - 损坏的字段会被安全兜底，绝不抛出异常
 * 同时把所有相对路径按 baseUrl 重写为绝对地址。
 */
function normalizeManifest(raw: unknown, baseUrl: string): BeatmapsManifest {
  const abs = (p?: unknown): string => {
    if (typeof p !== 'string' || !p) return '';
    if (/^https?:\/\//.test(p) || p.startsWith('blob:') || p.startsWith('idb://')) return p;
    return `${baseUrl}/${p.replace(/^\//, '')}`;
  };
  const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');

  const normDifficulty = (d: unknown): DifficultyEntry => {
    const o = (d ?? {}) as Record<string, unknown>;
    return {
      name: asStr(o.name) || 'Normal',
      // level 为可选键：beatmaps.json 未提供时不应默认 Lv.1，而是不显示难度
      level: typeof o.level === 'number' ? o.level : undefined,
      chartFile: abs(o.chartFile),
      noteCount: typeof o.noteCount === 'number' ? o.noteCount : undefined,
    };
  };

  const normSong = (o: Record<string, unknown>): SongItem | null => {
    const id = asStr(o.id);
    if (!id) return null; // 缺少 id 的脏数据直接丢弃
    return {
      type: 'song',
      id,
      title: asStr(o.title) || '未命名',
      artist: asStr(o.artist),
      bpm: typeof o.bpm === 'number' ? o.bpm : 0,
      cover: abs(o.cover),
      accentColor: asStr(o.accentColor) || undefined,
      audio: abs(o.audio),
      basePath: asStr(o.basePath),
      difficulties: Array.isArray(o.difficulties) ? o.difficulties.map(normDifficulty) : [],
    };
  };

  const normNode = (rawNode: unknown): BeatmapItem | null => {
    if (!rawNode || typeof rawNode !== 'object') return null;
    const o = rawNode as Record<string, unknown>;
    const explicit = asStr(o.type);
    const childrenArr = Array.isArray(o.songs) ? o.songs : [];
    const looksLikeSong =
      Array.isArray(o.difficulties) || typeof o.audio === 'string' || typeof o.bpm === 'number';
    const isAlbum = explicit === 'album' || (childrenArr.length > 0 && !looksLikeSong);
    if (explicit === 'song' || (!isAlbum && looksLikeSong)) {
      return normSong(o);
    }
    // 当作文件夹（album）处理：递归规整子节点
    const id = asStr(o.id) || asStr(o.title) || `album-${Math.random().toString(36).slice(2, 8)}`;
    const children = childrenArr
      .map(normNode)
      .filter((n): n is BeatmapItem => n !== null);
    return {
      type: 'album',
      id,
      title: asStr(o.title) || '未命名专辑',
      artist: asStr(o.artist),
      cover: abs(o.cover),
      accentColor: asStr(o.accentColor) || undefined,
      basePath: asStr(o.basePath),
      songs: children,
    };
  };

  let items: BeatmapItem[] = [];
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const arr = Array.isArray(o.items) ? o.items : Array.isArray(raw) ? (raw as unknown[]) : [];
    items = arr.map(normNode).filter((n): n is BeatmapItem => n !== null);
  }
  const ver = (raw as Record<string, unknown> | null)?.version;
  return { version: typeof ver === 'number' ? ver : 1, items };
}

export async function loadOnlineManifest(baseUrl: string): Promise<BeatmapsManifest | null> {
  // Strip FQDN trailing dot (host.:port) and trailing slashes defensively.
  const base = baseUrl.trim().replace(/\.+(?=\/|$)/g, '').replace(/\/+$/, '');
  // A "server" is a beatmaps directory; its index is <dir>/beatmaps.json and all
  // paths inside it are relative to <dir>. Also accept a full manifest.json URL.
  const candidates = [`${base}/beatmaps.json`, `${base}/manifest.json`, base];
  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      return normalizeManifest(data, base);
    } catch (e) {
      console.error('加载在线清单失败', url, e);
    }
  }
  return null;
}

// ---------- 装配主页面 manifest（内置 · 在线 · 本地） ----------

function resolveRef(url?: string): string {
  if (!url) return '';
  if (url.startsWith('idb://')) {
    const id = url.slice('idb://'.length);
    return getCachedIdbUrl(id) || url;
  }
  return url;
}

function resolveNode(n: BeatmapItem): BeatmapItem {
  if (n.type === 'album') {
    return { ...n, cover: resolveRef(n.cover), songs: n.songs.map(resolveNode) };
  }
  return {
    ...n,
    cover: resolveRef(n.cover),
    audio: resolveRef(n.audio),
    difficulties: n.difficulties.map((d) => ({ ...d, chartFile: resolveRef(d.chartFile) })),
  };
}

function resolveAlbum(a: AlbumItem): AlbumItem {
  return resolveNode(a) as AlbumItem;
}

function stampSource(nodes: BeatmapItem[], source: BeatmapItem['source']): BeatmapItem[] {
  return nodes.map((n) =>
    n.type === 'album'
      ? { ...n, source, songs: stampSource(n.songs, source) }
      : { ...n, source },
  );
}

function collectLocalRefs(albums: AlbumItem[]): string[] {
  const refs: string[] = [];
  const walk = (n: BeatmapItem) => {
    if (n.cover?.startsWith('idb://')) refs.push(n.cover);
    if (n.type === 'album') {
      n.songs.forEach(walk);
    } else {
      if (n.audio?.startsWith('idb://')) refs.push(n.audio);
      n.difficulties.forEach((d) => {
        if (d.chartFile?.startsWith('idb://')) refs.push(d.chartFile);
      });
    }
  };
  albums.forEach(walk);
  return refs;
}

// ---------- 树遍历辅助（供 UI 使用） ----------

/** 统计一个节点下的叶子歌曲（song）总数，递归进入子专辑。 */
export function countLeafSongs(node: BeatmapItem): number {
  if (node.type === 'song') return 1;
  return node.songs.reduce((sum, c) => sum + countLeafSongs(c), 0);
}

/** 该节点（或任意后代）是否包含可游玩的歌曲。 */
export function albumHasPlayableSong(node: BeatmapItem): boolean {
  if (node.type === 'song') return (node.difficulties?.length ?? 0) > 0;
  return node.songs.some(albumHasPlayableSong);
}

/** 在整棵树中按 id 递归查找专辑（支持嵌套专辑）。 */
export function findAlbumById(nodes: BeatmapItem[], id: string): AlbumItem | null {
  for (const n of nodes) {
    if (n.type === 'album') {
      if (n.id === id) return n;
      const found = findAlbumById(n.songs, id);
      if (found) return found;
    }
  }
  return null;
}

/** 在整棵树中按 id 递归查找任意节点（专辑或曲目），用于剪贴板标题展示。 */
export function findItemById(nodes: BeatmapItem[], id: string): BeatmapItem | null {
  const stack: BeatmapItem[] = [...nodes];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.id === id) return n;
    if (n.type === 'album') stack.push(...n.songs);
  }
  return null;
}

let manifestCache: { key: string; value: BeatmapsManifest } | null = null;

export function invalidateManifestCache() {
  manifestCache = null;
}

export async function assembleManifest(): Promise<BeatmapsManifest> {
  const cur = getCurrentServer();
  const key = `${cur?.id ?? 'none'}@${getLibraryVersion()}`;
  if (manifestCache && manifestCache.key === key) return manifestCache.value;

  const builtin = buildBuiltinAlbum();
  const builtinItems: BeatmapItem[] = stampSource([{ ...builtin }], 'builtin');

  let onlineItems: BeatmapItem[] = [];
  if (cur) {
    const m = await loadOnlineManifest(cur.baseUrl);
    if (m) onlineItems = stampSource(m.items, 'online');
  }

  const localRaw = (await getLibrary()) as AlbumItem[];
  const refs = collectLocalRefs(localRaw);
  await preloadIdbUrls(refs);
  const localItems: BeatmapItem[] = localRaw.map((a) => stampSource([resolveAlbum(a)], 'local')[0]);

  const value: BeatmapsManifest = {
    version: 1,
    items: [...builtinItems, ...onlineItems, ...localItems],
  };
  manifestCache = { key, value };
  return value;
}

export { FALLBACK_SONG_ID, FALLBACK_BG, UNKNOWN_COVER, BACKUP_BG_SCHEME, BACKUP_BPMCONFIG };
