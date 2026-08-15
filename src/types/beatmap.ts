export type BeatmapSource = 'builtin' | 'online' | 'local';

export interface DifficultyEntry {
  name: string;
  /** 可选：谱面未显式标注难度等级时不传，UI 不显示 Lv.x。 */
  level?: number;
  chartFile: string;
  noteCount?: number;
}

// 由卡片发起“编辑谱面/新建谱面”时携带的上下文信息（不含谱面数据本身，
// 真正的谱面由编辑器侧按需加载/生成）。
export interface EditorLaunchInfo {
  mode: 'edit' | 'new';
  albumId?: string | null;
  songId?: string;
  songTitle: string;
  songArtist: string;
  bpm: number;
  accentColor?: string;
  source: BeatmapSource;
  /** 现有本地难度对应的 idb:// 谱面引用（编辑已有谱面时提供）。 */
  chartFile?: string;
  /** 现有难度的名称（用于保存时定位要覆盖的难度）。 */
  diffName?: string;
  /** 歌曲音频引用（内置/在线为 URL，本地为 idb://），用于编辑器加载对应音乐。 */
  audio?: string;
  /** 当前选中的难度索引，-1 表示无难度。 */
  selectedDiffIndex: number;
  difficultiesCount: number;
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
  /** 若来自在线服务器，记录其原始 id，用于去重与“重新下载”。 */
  onlineId?: string;
  /** 原始在线资源的远程地址，用于对已下载曲目执行“重新下载”。 */
  onlineUrls?: { audio?: string; cover?: string; charts?: string[] };
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
