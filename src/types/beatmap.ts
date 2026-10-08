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
  /** 歌曲目录的故事板脚本引用（约定 story.js；编辑器内也挂载 MV 预览）。 */
  storyboard?: string;
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
  /**
   * 背景媒体（约定命名：歌曲目录下 `bg.jpg` / `bga.mp4`；info.json 可覆盖，
   * 路径相对歌曲目录）。内置/在线为相对索引根的路径，本地/zip 导入为 idb:// 引用。
   * 渲染优先级：bgVideo > bgImage > 内置渐变。不再写入谱面文件。
   */
  bgImage?: string;
  bgVideo?: string;
  /** 故事板脚本（约定 `story.js`，尚未实现；索引先记录占位）。 */
  storyboard?: string;
  /**
   * 故事板的**外部资源**：`相对路径 → 可fetch 的地址`（§3.7 v3 `api.assets`）。
   *
   * 用途："约定之外"的数据文件。来源优先级：
   *   1. `info.json` 的 `assets: [...]` 显式声明（推荐，打包方可控）；
   *   2. 缺省：与 `story.js` 同目录的额外 `.json`（排除 info.json 与谱面）。
   *
   * 地址形态随来源而变：在线/静态托管为 URL（相对索引根或绝对），
   * zip 导入 / 下载到本地为 `idb://` 引用 —— 宿主 `api.assets` 两种都能读。
   */
  assets?: Record<string, string>;
  basePath: string;
  difficulties: DifficultyEntry[];
  source?: BeatmapSource;
  /** 若来自在线服务器，记录其原始 id，用于去重与“重新下载”。 */
  onlineId?: string;
  /** 原始在线资源的远程地址，用于对已下载曲目执行“重新下载”。 */
  onlineUrls?: { audio?: string; cover?: string; charts?: string[]; bgImage?: string; bgVideo?: string; storyboard?: string };
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
