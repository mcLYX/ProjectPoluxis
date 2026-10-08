/**
 * 歌曲 → zip 导出（`zipImport` 的逆操作）。
 *
 * 设计目标：**导出的包能被本项目自己的 `importZip` 无损读回**。所以布局刻意
 * 贴着 `zipImport.buildSongFromInfo` 的约定：
 *
 *   <目录>/
 *     info.json      { title, artist, bpm, audio, cover, storyboard, difficulties[], assets[] }
 *     base.mp3       音频
 *     cover.jpg      封面
 *     story.js       故事板
 *     <i>.json       各难度谱面
 *     <assets…>      故事板外部资源（显式写进 info.json 的 assets[]）
 *
 * 为什么用「目录 + info.json」而不是顶层 `beatmaps.json`：
 * 前者是导入器的**主路径**（`groupBySong` + `buildSongFromInfo`），不依赖清单
 * 归一化，且 info.json 能显式声明 `assets` —— 与本地库/在线的约定一致。
 *
 * 音频/封面等大文件直接**流式存为已压缩条目**（level 0）：mp3/jpg 本就压缩过，
 * 再 deflate 纯属浪费 CPU。
 */
import { zipSync } from 'fflate';
import { getFile } from './idb';
import type { SongItem, DifficultyEntry } from '../types/beatmap';

/** 单个待写文件。`blob` 为空时该条目被跳过。 */
export interface ZipOutFile {
  /** zip 内路径（相对歌曲目录，不含目录名）。 */
  path: string;
  blob: Blob | null;
}

/** 导出描述：调用方负责把 SongItem 摊平成这些字段。 */
export interface SongZipSpec {
  /** zip 内的目录名（建议用标题，需做文件名净化）。 */
  dir: string;
  title: string;
  artist: string;
  bpm: number;
  accentColor?: string;
  audioPath: string;
  coverPath: string;
  bgImagePath: string;
  bgVideoPath: string;
  storyboardPath: string;
  /** 音频/封面/背景/故事板的内容（null = 没有这类文件，导出时跳过）。
   * specFromSong 负责从 idb 取；调用方也可直接给内存里的内容。 */
  audio: Blob | null;
  cover: Blob | null;
  bgImage: Blob | null;
  bgVideo: Blob | null;
  storyboard: Blob | null;
  difficulties: Array<{ name: string; level?: number; file: ZipOutFile }>;
  /** 故事板外部资源；会写进 info.json 的 assets[]。 */
  assets: ZipOutFile[];
}

export interface BuiltZip {
  bytes: Uint8Array;
  /** 实际写入的文件数（含 info.json）。 */
  fileCount: number;
  /**
   * **必须让用户知道**的缺失，目前只有谱面。
   * 故事板/背景/外部资源/音频/封面缺失属正常，不在此列 —— 否则每次导出没挂
   * story.js 的歌都会弹一条"缺少 story.js"，噪音盖过信号。
   */
  skipped: string[];
}

/** zip 内部不放目录条目，只放文件条目（各 importer 都不依赖目录项）。 */
const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  json: 'application/json',
  js: 'text/javascript',
  aff: 'text/plain',
};

/**
 * 文件名净化：去掉 zip/文件系统敏感字符。
 * 保留 CJK —— 歌曲标题本来就可能是中文。
 */
export function sanitizeZipName(name: string, fallback = 'song'): string {
  const cleaned = (name ?? '')
    // 控制字符 + Windows 非法字符 + 路径分隔符
    .replace(/[\u0000-\u001f<>:"|?*\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // 结尾的点或空格在 Windows 上会被裁掉
    .replace(/[. ]+$/g, '');
  return cleaned || fallback;
}

function extOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i < 0 ? '' : path.slice(i + 1).toLowerCase();
}

/**
 * 从 Blob 推断音频扩展名（编辑器新导入的音频是内存 File，没有可依赖的引用路径）。
 * 目的是让包内文件名与内容一致 —— 否则会写出"名为 base.mp3、内容却是 ogg"的文件，
 * 导入侧的 `resolveGroupRef` 按名字找文件时虽然还能找到，但播放器按扩展名选解码器会出错。
 */
export function audioExtOf(blob: Blob | null | undefined): string | undefined {
  if (!blob) return undefined;
  const byName = extOf((blob as File).name ?? '');
  if (byName) return byName;
  const mime = (blob.type || '').toLowerCase();
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('flac')) return 'flac';
  if (mime.includes('aac')) return 'aac';
  return undefined;
}

async function toBytes(blob: Blob | null | undefined): Promise<Uint8Array | null> {
  if (!blob) return null;
  if (blob.size === 0) return null;
  try {
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * 组装 info.json 的内容（**纯函数**，便于单测与"导出后能否读回"的往返断言）。
 *
 * 字段与 `zipImport.buildSongFromInfo` 严格对齐：
 * - `difficulties[].chartFile` 相对歌曲目录；
 * - `assets[]` 显式列出故事板外部资源（导入时优先用它，缺省才按约定扫同目录 .json）。
 */
export function buildInfoJson(
  spec: SongZipSpec,
  present: { audio: boolean; cover: boolean; storyboard: boolean; bgImage: boolean; bgVideo: boolean; assets: string[] },
): string {
  const info: Record<string, unknown> = {
    title: spec.title,
    artist: spec.artist,
    bpm: spec.bpm,
  };
  if (spec.accentColor) info.accentColor = spec.accentColor;
  if (present.audio) info.audio = spec.audioPath;
  if (present.cover) info.cover = spec.coverPath;
  // 背景媒体：文件真正落地才写，否则导入时会指向不存在的路径。
  if (present.bgImage && spec.bgImagePath) info.bgImage = spec.bgImagePath;
  if (present.bgVideo && spec.bgVideoPath) info.bgVideo = spec.bgVideoPath;
  if (present.storyboard) info.storyboard = spec.storyboardPath;
  if (present.assets.length) info.assets = present.assets;
  info.difficulties = spec.difficulties.map((d) => {
    const o: Record<string, unknown> = { name: d.name, chartFile: d.file.path };
    if (typeof d.level === 'number') o.level = d.level;
    return o;
  });
  return JSON.stringify(info, null, 2);
}

/**
 * 打包成 zip。
 *
 * 纯逻辑 + Blob 读取分离：`buildInfoJson` 单独导出就是为了能脱离 idb 单测。
 */
export async function buildSongZip(spec: SongZipSpec): Promise<BuiltZip> {
  const dir = sanitizeZipName(spec.dir);
  const enc = new TextEncoder();
  /** @typeRecord<string, [Uint8Array, { level: 0 | 6 }]> */
  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  const skipped: string[] = [];

  /**
   * 写入一个条目。**同一路径重复写入是幂等的**（后写覆盖前者）。
   *
   * `optional` 为真表示"缺了属正常、**不必打扰用户**"：故事板、背景媒体、外部资源
   * 以及音频/封面都属于此类 —— 没挂故事板的歌多了去了，导出一个"没有 story.js 的包"
   * 完全正常，不该在 toast 里报成缺失。只有**谱面**缺失才是真问题（那一档等于丢了），
   * 才进skipped 让用户知道。
   */
  const put = async (relPath: string, blob: Blob | null, compress: boolean, optional: boolean): Promise<boolean> => {
    const data = await toBytes(blob);
    if (!data) {
      if (!optional) skipped.push(relPath);
      return false;
    }
    files[`${dir}/${relPath}`] = [data, { level: compress ? 6 : 0 }];
    return true;
  };

  const [audioOk, coverOk, storyboardOk] = await Promise.all([
    put(spec.audioPath, spec.audio, false, true),
    put(spec.coverPath, spec.cover, false, true),
    put(spec.storyboardPath, spec.storyboard, true, true),
  ]);
  if (spec.bgImagePath) await put(spec.bgImagePath, spec.bgImage, false, true);
  if (spec.bgVideoPath) await put(spec.bgVideoPath, spec.bgVideo, false, true);
  for (const d of spec.difficulties) await put(d.file.path, d.file.blob, true, false);

  // assets 最后写：需要在知道哪些真的落地之后才生成 info.json
  const presentAssets: string[] = [];
  for (const a of spec.assets) {
    if (await put(a.path, a.blob, true, false)) presentAssets.push(a.path);
  }
  const bgImageOk = spec.bgImagePath ? !skipped.includes(spec.bgImagePath) : false;
  const bgVideoOk = spec.bgVideoPath ? !skipped.includes(spec.bgVideoPath) : false;

  const infoJson = buildInfoJson(spec, {
    audio: audioOk,
    cover: coverOk,
    storyboard: storyboardOk,
    bgImage: bgImageOk,
    bgVideo: bgVideoOk,
    assets: presentAssets,
  });
  files[`${dir}/info.json`] = [enc.encode(infoJson), { level: 6 }];

  // 计数**以实际条目数为准**，而不是"写了几次"：同名路径重复写入只会覆盖、
  // 不会新增条目，用累加器会把重复写入算成多个文件（toast 报的数字比包里多）。
  return { bytes: zipSync(files), fileCount: Object.keys(files).length, skipped };
}

/** 歌曲字段 → 导出描述；`chartOverride` 用于编辑器里导出"当前未保存的谱面"。 */
/** 读取引用（idb://… 或 http(s) URL）对应的 Blob；非本地引用或失败返回 null。 */
async function blobOfRef(ref: string | undefined): Promise<Blob | null> {
  if (!ref) return null;
  if (ref.startsWith('idb://')) {
    try {
      return await getFile(ref.slice('idb://'.length));
    } catch {
      return null;
    }
  }
  // 在线引用：跨域且可能很大，导出时跳过（info.json 里也不会写它）。
  return null;
}

/** 打包并触发浏览器下载。 */
export async function downloadSongZip(spec: SongZipSpec, fileName?: string): Promise<BuiltZip> {
  const built = await buildSongZip(spec);
  const blob = new Blob([built.bytes as unknown as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeZipName(fileName ?? spec.dir)}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器拿不到数据，延后一拍。
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return built;
}

/** 由 SongItem 组装导出描述（不含谱面覆盖）。 */
export async function specFromSong(
  song: SongItem,
  opts?: { dirName?: string; chartOverride?: Record<number, string> },
): Promise<SongZipSpec> {  const dir = sanitizeZipName(opts?.dirName ?? song.title ?? song.id);
  const ext = (ref: string | undefined, fallback: string): string => {
    const e = ref ? extOf(ref.split('?')[0]) : '';
    return e || fallback;
  };
  const audioPath = `base.${ext(song.audio, 'mp3')}`;
  const coverPath = `cover.${ext(song.cover, 'jpg')}`;
  const bgImagePath = song.bgImage ? `bg.${ext(song.bgImage, 'jpg')}` : '';
  const bgVideoPath = song.bgVideo ? `bga.${ext(song.bgVideo, 'mp4')}` : '';
  const storyboardPath = 'story.js';

  const difficulties: SongZipSpec['difficulties'] = [];
  const list: DifficultyEntry[] = song.difficulties ?? [];
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    const override = opts?.chartOverride?.[i];
    if (override != null) {
      difficulties.push({
        name: d.name,
        level: d.level,
        file: { path: `${i}.json`, blob: new Blob([override], { type: MIME_BY_EXT.json }) },
      });
      continue;
    }
    difficulties.push({
      name: d.name,
      level: d.level,
      file: { path: `${i}.json`, blob: await blobOfRef(d.chartFile) },
    });
  }

  const assets: ZipOutFile[] = [];
  for (const [rel, ref] of Object.entries(song.assets ?? {})) {
    assets.push({ path: rel, blob: await blobOfRef(ref) });
  }

  return {
    dir,
    title: song.title,
    artist: song.artist,
    bpm: song.bpm,
    accentColor: song.accentColor,
    audioPath,
    coverPath,
    bgImagePath,
    bgVideoPath,
    storyboardPath,
    audio: await blobOfRef(song.audio),
    cover: await blobOfRef(song.cover),
    bgImage: await blobOfRef(song.bgImage),
    bgVideo: await blobOfRef(song.bgVideo),
    storyboard: await blobOfRef(song.storyboard),
    difficulties,
    assets,
  };
}

/** `specFromChart` 的入参（编辑器「导出 zip」专用）。 */
export interface ChartExportSpec {
  /** 编辑器里**当前未保存**的谱面 JSON（实时内容，必须传这个而不是从库里读）。 */
  chartJson: string;
  title: string;
  artist: string;
  bpm: number;
  accentColor?: string;
  /** 当前编辑难度的名称 / 等级（从 chart.metadata.difficulty 解析得到）。 */
  diffName?: string;
  diffLevel?: number;
  /**
   * 已绑定的本地歌曲（可空）。
   * 有 → 音频/封面/背景/故事板/外部资源一并打包，且**所有难度**都导出；
   * 无（自由编辑器）→ 只打包当前这一份谱面，info.json 不写媒体字段。
   */
  song?: SongItem | null;
  /**
   * 覆盖音频内容（编辑器里刚导入的音频）。
   *
   * 必要性：编辑器「导入音频」把文件留在内存（`customAudioFileRef`）+ idb
   * （`currentAudioRefRef`），**不会**立刻写回 `song.audio` —— 所以只读
   * `song.audio` 会拿到旧音频，导出的包里没有用户刚换的那首。
   * 显式传入即可覆盖；不传则沿用 song.audio。
   */
  audioOverride?: Blob | null;
  /** 覆盖音频的扩展名（跟随实际文件类型，避免包里 .mp3 内容却是 .ogg）。 */
  audioExtHint?: string;
  /** 当前编辑的难度在 `song.difficulties` 中的下标；-1/越界按"无"处理。 */
  diffIndex?: number;
  dirName?: string;
}

/**
 * 编辑器「导出 zip」的组装入口。
 *
 * 与 `specFromSong` 的区别（也是它存在的理由）：
 *  - **谱面永远取实时内容**（`chartJson`），不读 idb 里的旧版本；
 *  - **不要求绑定歌曲**：`song` 为空时依然能导出，得到一个"只有谱面"的自包含包
 *    （自由编辑器 / 新建谱面场景）；
 *  - 难度定位用 `diffIndex`（编辑器打开的是 `selectedDiffIndex` 那一档），
 *    不像 `chartOverride: {0}` 那样假定当前谱面一定是第 0 档 —— 多难度歌曲上
 *    那个假定会覆盖错档，导出的包等于把别的难度换成了当前内容。
 */
export async function specFromChart(opts: ChartExportSpec): Promise<SongZipSpec> {
  const song = opts.song ?? null;
  const dir = sanitizeZipName(opts.dirName ?? opts.title);
  const liveBlob = new Blob([opts.chartJson], { type: MIME_BY_EXT.json });
  const diffIndex = opts.diffIndex ?? -1;
  const hasLiveSlot = !!song && diffIndex >= 0 && diffIndex < (song.difficulties?.length ?? 0);

  const difficulties: SongZipSpec['difficulties'] = [];
  if (song && hasLiveSlot) {
    // 绑定歌曲：导出全部难度，只有当前这一档换成实时内容。
    for (let i = 0; i < song.difficulties.length; i++) {
      const d = song.difficulties[i];
      if (i === diffIndex) {
        difficulties.push({
          name: opts.diffName ?? d.name,
          level: opts.diffLevel ?? d.level,
          file: { path: `${i}.json`, blob: liveBlob },
        });
      } else {
        difficulties.push({ name: d.name, level: d.level, file: { path: `${i}.json`, blob: await blobOfRef(d.chartFile) } });
      }
    }
  } else {
    // 自由编辑 / 新建谱面 / 下标对不上：只导出当前这一份（自包含）。
    difficulties.push({
      name: opts.diffName ?? 'Custom',
      level: opts.diffLevel,
      file: { path: '0.json', blob: liveBlob },
    });
  }

  // 扩展名沿用库里的实际格式，避免"库里是 .ogg、包里写成 .mp3"这种错位。
  const ext = (ref: string | undefined, fallback: string): string => {
    const e = ref ? extOf(ref.split('?')[0]) : '';
    return e || fallback;
  };

  const assets: ZipOutFile[] = [];
  for (const [rel, ref] of Object.entries(song?.assets ?? {})) {
    assets.push({ path: rel, blob: await blobOfRef(ref) });
  }

  // 音频：编辑器新导入的优先（覆盖 song.audio），否则用库里的。
  const audioOverride = opts.audioOverride;
  const audioBlob = audioOverride !== undefined ? audioOverride : await blobOfRef(song?.audio);

  return {
    dir,
    title: opts.title || song?.title || 'Untitled',
    artist: opts.artist || song?.artist || '',
    bpm: opts.bpm || song?.bpm || 120,
    accentColor: opts.accentColor ?? song?.accentColor,
    audioPath: `base.${opts.audioExtHint || ext(song?.audio, 'mp3')}`,
    coverPath: `cover.${ext(song?.cover, 'jpg')}`,
    bgImagePath: song?.bgImage ? `bg.${ext(song.bgImage, 'jpg')}` : '',
    bgVideoPath: song?.bgVideo ? `bga.${ext(song.bgVideo, 'mp4')}` : '',
    storyboardPath: 'story.js',
    audio: audioBlob,
    cover: await blobOfRef(song?.cover),
    bgImage: await blobOfRef(song?.bgImage),
    bgVideo: await blobOfRef(song?.bgVideo),
    storyboard: await blobOfRef(song?.storyboard),
    difficulties,
    assets,
  };
}
