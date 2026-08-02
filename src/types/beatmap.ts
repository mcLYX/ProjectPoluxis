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
}

export interface AlbumItem {
  type: 'album';
  id: string;
  title: string;
  artist?: string;
  cover: string;
  accentColor?: string;
  basePath: string;
  songs: SongItem[];
}

export type BeatmapItem = AlbumItem | SongItem;

export interface BeatmapsManifest {
  version: number;
  items: BeatmapItem[];
}
