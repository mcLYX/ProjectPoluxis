export type BeatmapSource = 'builtin' | 'online' | 'local';

export interface DifficultyEntry {
  name: string;
  level: number;
  chartFile: string;
  noteCount?: number;
}

export interface SongItem {
  type: 'song';
  id: string;
  title: string;
  artist: string;
  bpm: number;
  cover: string;
  accentColor?: string;
  audio: string;
  basePath: string;
  difficulties: DifficultyEntry[];
  source?: BeatmapSource;
}

export interface AlbumItem {
  type: 'album';
  id: string;
  title: string;
  artist?: string;
  cover: string;
  accentColor?: string;
  basePath: string;
  // Recursive folder: an album may contain nested albums AND songs (mixed),
  // and may be empty.
  songs: BeatmapItem[];
  source?: BeatmapSource;
}

export type BeatmapItem = AlbumItem | SongItem;

/** 类型守卫：在混合树中筛选/收窄到歌曲节点。 */
export function isSongItem(item: BeatmapItem): item is SongItem {
  return item.type === 'song';
}

export interface BeatmapsManifest {
  version: number;
  items: BeatmapItem[];
}
