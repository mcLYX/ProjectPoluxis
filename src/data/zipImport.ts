import { unzip } from 'fflate';
import type { AlbumItem, SongItem, DifficultyEntry } from '../types/beatmap';
import { storeFile, generateId } from './idb';

const AUDIO_EXT = ['mp3', 'ogg', 'wav', 'm4a', 'flac', 'webm', 'aac'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
const CHART_EXT = ['json', 'chart'];

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

function parseChartMeta(text: string): ChartMeta | null {
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

function findInGroup(group: GroupedSong, exts: string[]): ZipEntry | undefined {
  return group.entries.find((e) => {
    const tail = group.folder ? e.name.slice(group.folder.length + 1) : e.name;
    return exts.includes(extOf(tail));
  });
}

async function buildSong(group: GroupedSong, fallbackTitle: string): Promise<SongItem> {
  const audio = findInGroup(group, AUDIO_EXT);
  const cover = findInGroup(group, IMAGE_EXT);
  const chartEntries = group.entries.filter((e) => {
    const tail = group.folder ? e.name.slice(group.folder.length + 1) : e.name;
    return CHART_EXT.includes(extOf(tail));
  });

  const difficulties: DifficultyEntry[] = [];
  let firstMeta: ChartMeta | null = null;

  for (const ce of chartEntries) {
    const text = new TextDecoder().decode(ce.data);
    const meta = parseChartMeta(text);
    if (!meta) continue;
    if (!firstMeta) firstMeta = meta;
    const file = new File([ce.data as unknown as BlobPart], 'chart.json', { type: 'application/json' });
    const ref = await storeFile(file);
    const level = typeof meta.difficulty === 'number' ? meta.difficulty : parseInt(String(meta.difficulty), 10) || 1;
    difficulties.push({
      name: meta.difficulty || extOf(ce.name) || 'NORMAL',
      level,
      chartFile: ref,
      noteCount: meta.noteCount,
    });
  }

  const audioRef = audio ? await storeFile(new File([audio.data as unknown as BlobPart], audio.name, { type: mimeFromExt(extOf(audio.name)) })) : '';
  const coverRef = cover ? await storeFile(new File([cover.data as unknown as BlobPart], cover.name, { type: mimeFromExt(extOf(cover.name)) })) : '';

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
  songCount: number;
  difficultyCount: number;
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

export async function importZip(file: File): Promise<ZipImportResult> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const files = await unzipAsync(buffer);
  const entries: ZipEntry[] = Object.entries(files).map(([name, data]) => ({ name, data }));

  const groups = groupBySong(entries);
  const songs: SongItem[] = [];
  for (const g of groups) {
    const fallbackTitle = g.folder || file.name.replace(/\.zip$/i, '');
    const song = await buildSong(g, fallbackTitle);
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

  return { album, songCount: songs.length, difficultyCount };
}
