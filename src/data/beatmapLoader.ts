import { BeatmapsManifest, BeatmapItem, SongItem, AlbumItem } from '../types/beatmap';
import { ChartData } from '../types/game';
import { DEMO_CHARTS } from './demoCharts';

const BASE_URL = 'beatmaps/';

const audioCache = new Map<string, AudioBuffer>();
const chartCache = new Map<string, ChartData>();
let manifestCache: BeatmapsManifest | null = null;
let manifestLoaded = false;
let manifestLoading: Promise<BeatmapsManifest> | null = null;

/** Build the "Built-in" album containing all demo/builtin charts. */
export function buildBuiltinAlbum(): AlbumItem {
  const songs: SongItem[] = Object.entries(DEMO_CHARTS).map(([key, chart]) => ({
    type: 'song' as const,
    id: key,
    title: chart.metadata.title,
    artist: chart.metadata.artist,
    bpm: chart.metadata.bpm,
    cover: '',
    accentColor: chart.metadata.bgScheme.accentColor,
    audio: '',
    basePath: '',
    difficulties: [
      {
        name: chart.metadata.difficulty.split(' ')[0] || 'Demo',
        level: parseInt(chart.metadata.difficulty.match(/Lv\.(\d+)/)?.[1] || '0', 10) || 0,
        chartFile: '',
        noteCount: chart.notes.length,
      },
    ],
  }));

  return {
    type: 'album',
    id: 'built-in',
    title: 'Built-in',
    artist: 'System',
    cover: '',
    accentColor: '#06b6d4',
    basePath: '',
    songs,
  };
}

/**
 * Load beatmaps manifest from /beatmaps/beatmaps.json.
 * Always includes the Built-in album as the first item, regardless of
 * whether external beatmaps.json loads successfully.
 */
export async function loadBeatmapsManifest(forceRefresh = false): Promise<BeatmapsManifest> {
  if (manifestLoaded && manifestCache && !forceRefresh) {
    return manifestCache;
  }
  if (manifestLoading && !forceRefresh) {
    return manifestLoading;
  }

  manifestLoading = (async () => {
    const builtinAlbum = buildBuiltinAlbum();
    let externalItems: BeatmapItem[] = [];

    try {
      const res = await fetch(`${BASE_URL}beatmaps.json`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as BeatmapsManifest;
      externalItems = data.items || [];
    } catch (e) {
      console.warn('[beatmap] Failed to load beatmaps.json, showing built-in only:', e);
    }

    const result: BeatmapsManifest = {
      version: 1,
      items: [builtinAlbum, ...externalItems],
    };

    manifestCache = result;
    manifestLoaded = true;
    return result;
  })();

  return manifestLoading;
}

export function getCachedManifest(): BeatmapsManifest | null {
  return manifestCache;
}

export function resolveBeatmapUrl(relativePath: string): string {
  return `${BASE_URL}${relativePath}`;
}

export async function loadAudioForSong(song: SongItem, audioCtx: AudioContext): Promise<AudioBuffer | null> {
  if (!song.audio) return null;
  const cacheKey = song.id;
  if (audioCache.has(cacheKey)) return audioCache.get(cacheKey)!;

  try {
    const url = resolveBeatmapUrl(song.audio);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(buf.slice(0));
    audioCache.set(cacheKey, audioBuffer);
    return audioBuffer;
  } catch (e) {
    console.error(`[beatmap] Failed to load audio for ${song.id}:`, e);
    return null;
  }
}

export function getCachedAudio(songId: string): AudioBuffer | null {
  return audioCache.get(songId) || null;
}

export async function loadChartForDifficulty(
  song: SongItem,
  difficultyIdx: number
): Promise<ChartData | null> {
  const diff = song.difficulties[difficultyIdx];
  if (!diff || !diff.chartFile) return null;
  const cacheKey = `${song.id}::${diff.name}`;
  if (chartCache.has(cacheKey)) return chartCache.get(cacheKey)!;

  try {
    const url = resolveBeatmapUrl(diff.chartFile);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const chart = await res.json() as ChartData;
    chartCache.set(cacheKey, chart);
    return chart;
  } catch (e) {
    console.error(`[beatmap] Failed to load chart for ${song.id}/${diff.name}:`, e);
    return null;
  }
}

export function getCachedChart(songId: string, diffName: string): ChartData | null {
  return chartCache.get(`${songId}::${diffName}`) || null;
}

export function isFallbackSong(songId: string): boolean {
  return !!DEMO_CHARTS[songId];
}

export function getFallbackChart(songId: string): ChartData | null {
  return DEMO_CHARTS[songId] || null;
}

export function flattenAllSongs(items: BeatmapItem[]): SongItem[] {
  const result: SongItem[] = [];
  for (const item of items) {
    if (item.type === 'song') {
      result.push(item);
    } else {
      result.push(...item.songs);
    }
  }
  return result;
}
