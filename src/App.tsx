import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
// 重度/非首屏组件按需懒加载，降低菜单首屏 JS 体积（three 等仅在使用时下载）。
/* 渲染器代码块加载器：lazy 挂载与开局预热共用同一 promise（模块去重），
 * 开局流程用它确保 chunk 下载+解析完成后才启动游戏时钟，消除首局黑屏竞走。 */
const loadRenderer3D = (): Promise<typeof import('./components/GameCanvas')> => import('./components/GameCanvas');
const loadRenderer2D = (): Promise<typeof import('./components/GameCanvas2D')> => import('./components/GameCanvas2D');

const GameCanvas = lazy(() => loadRenderer3D().then(m => ({ default: m.GameCanvas })));
// 2D canvas renderer (quality 'lite'). Does NOT import three.js, so its chunk stays tiny.
const GameCanvas2D = lazy(() => loadRenderer2D().then(m => ({ default: m.GameCanvas2D })));
const Editor2DCanvas = lazy(() => import('./components/Editor2DCanvas').then(m => ({ default: m.Editor2DCanvas })));
const VisualChartEditor = lazy(() => import('./components/VisualChartEditor').then(m => ({ default: m.VisualChartEditor })));
const SettingsModal = lazy(() => import('./components/SettingsModal').then(m => ({ default: m.SettingsModal })));
import type { EditorTool, BatchSelection, QuickCreateDelta, MarqueeMode } from './components/VisualChartEditor';
// 故事板宿主（§3.7）：轻量组件（无 three.js），静态导入即可。
import { StoryboardHost, type StoryboardHostHandle } from './components/StoryboardHost';
// 故事板 v3：指针桥工厂（身份需稳定）+ 歌曲目录相对资源解析。
import { createPointerBridge } from './utils/storyboardPointerBridge';
import { dirOfUrl, isFetchableAssetBase, resolveAssetPath } from './utils/storyboardAssets';
import { SongSelect, SongSelectNavState, ResultInfo } from './components/SongSelect';
import { OrientationHint } from './components/OrientationHint';
import { TimingBar, type TimingBarHandle } from './components/TimingBar';
import { DEMO_CHARTS } from './data/demoCharts';
import { storeFile, storeFileDedup, getFile, generateId } from './data/idb';
import { getAlbumById, createAlbum, addSong, findSongById, findAlbumTitleForSong, addDifficultyToSong, updateDifficultyOfSong, updateSongById } from './data/libraryStore';
import { resolveBeatmapUrl, parseDifficultyMeta, resolveStoryboardUrl, resolveCoverUrl } from './data/beatmapLoader';
import { specFromChart, downloadSongZip, audioExtOf } from './data/zipExport';
import type { SkinTextureSet, SkinImageSet } from './types/game';
import { qualityStore, useQuality } from './qualityStore';
import { playheadStore } from './playheadStore';
import { selectionStore, useSelection } from './selectionStore';
import { ChartData, GameStats, JudgementFeedback, NoteData } from './types/game';
import { getSkin, loadSkinImages, loadSkinTextures } from './data/skinStore';
import type { EditorLaunchInfo, SongItem } from './types/beatmap';
import { calculateNoteScore, calculateRank } from './utils/scoring';
import { clampInt } from './utils/math';
import { safeStorage } from './utils/storage';
import { createFrameGate } from './utils/frameLimiter';
import { getChartDuration, beatToSecondsMultiBpm, secondsToBeatMultiBpm, countPlayableNotes, getFirstNoteTime } from './utils/beatTime';
import { buildLayerTree, layerOffsetAt } from './utils/layers';
import { parseAndValidateChart, exportChartJson } from './utils/chartParser';
import { submitScore, clearHighScore, getScoreKey, calcBadgeFromStats, getAllHighScores, mergeCloudHighScores, type HighScoreMap } from './utils/scoreStore';
import { getPlatform, hasPlatformIdentity } from './platform';
import { usePlatform } from './platform/PlatformContext';
import { accountStore } from './accountStore';
import { globalAudio } from './audio/AudioManager';
import { useI18n } from './i18n';
import { applyDslToNote, loadEditorDsl, saveEditorDsl } from './utils/editorRules';
import {
  Play,
  Pause,
  RotateCcw,
  ArrowLeft,
} from 'lucide-react';

/**
 * 判定回传节流间隔（ms）：HUD / stats 的刷新频率上限（~30Hz）。
 * 只影响 UI 刷新时机，不影响判定与计分（缓冲按原顺序批量应用）。
 */
const JUDGEMENT_FLUSH_MS = 33;

// =============== HUD color helpers (driven by per-chart bgScheme) ===============
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const full = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function withAlpha(hex: string, a: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
function adjustBrightness(hex: string, factor: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgb(${clampInt(r * factor, 0, 255)}, ${clampInt(g * factor, 0, 255)}, ${clampInt(b * factor, 0, 255)})`;
}

// Fallback palette (matches the previous cyan look) used when a chart doesn't
// define its own bgScheme.
const FALLBACK_BG = { accentColor: '#06b6d4', gradientStart: '#0a1124', gradientEnd: '#050816' };

const DEFAULT_SETTINGS = {
  speedMultiplier: 1.0,
  audioOffsetMs: 0,
  projectionLeadMs: 500,
  noteRenderDistance: 70,
  noteSizeScale: 1.0,
  // 画质设置（qualityMode / custom* / maxFps）不在此处：它们是 `qualityStore` 的
  // 单一真相，由该 store 自行持久化到同一个 `poluxis-settings` key。
  musicVolume: 0.8,
  effectVolume: 0.5,
  // 兼容模式（HarmonyOS 弱设备音频时钟停滞时）：谱面走墙钟、音频跟随谱面校准。
  // 默认开启：多数设备关闭后音画同步更好，但部分设备音频时钟不稳会出问题，
  // 故以兼容模式为默认，异常时反而更稳。
  compatMode: true,
  // 禁用附加内容：勾上后歌曲目录里的 bg.jpg / bga.mp4 / story.js 一律不加载
  // （画面退回渐变背景）。低配设备或只想读谱时用来省内存/显存。
  disableExtraContent: false,
  // 当前选中的皮肤 id；null 表示使用默认纯色外观。
  selectedSkinId: null as string | null,
  // 默认皮肤（未选皮肤包时）的自定义项。
  // 默认皮肤音符边框 = 内框(跟随音符色) + 外框(软边纹理,可自定义)。判定框颜色恒等于音符色。
  defaultSkinInnerEnabled: true,   // 内框开关，默认开
  defaultSkinOuterEnabled: false,  // 外框开关，默认关（关闭时外框不渲染）
  defaultSkinOuterWidth: 0.05,     // 外框粗细（仅开关启用时生效）
  defaultSkinOuterColor: '#22d3ee',
  defaultSkinOuterAlpha: 1,
  defaultSkinJudgeWidth: 0.01, // 判定框（投影引导）粗细，颜色恒等于音符色
};

function loadSettings(): typeof DEFAULT_SETTINGS {
  try {
    const saved = safeStorage.getItem('poluxis-settings');
    if (!saved) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(saved);
    const result: typeof DEFAULT_SETTINGS = { ...DEFAULT_SETTINGS };
    const r = result as Record<keyof typeof DEFAULT_SETTINGS, unknown>;
    for (const k of Object.keys(result) as Array<keyof typeof DEFAULT_SETTINGS>) {
      const val = parsed[k];
      if (typeof val === 'undefined') continue;
      const def = r[k];
      // A setting whose default is `null` (e.g. selectedSkinId) has type
      // 'object', while the saved value is a string — the naive
      // `typeof val === typeof def` check would reject it and silently reset
      // the selection to default on every refresh. Accept any loaded value
      // for null-typed settings instead.
      if (def === null) {
        r[k] = val;
      } else if (typeof val === typeof def) {
        r[k] = val;
      }
    }
    return result;
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 保存 App 负责的设置。
 *
 * 与 `qualityStore` 共用 `poluxis-settings`：画质字段由 store 自行维护，故这里必须
 * 「读-改-写」——只覆盖本函数收到的字段，保留持久化对象里的其余字段，否则每次保存
 * 都会把画质设置清掉。
 */
function saveSettings(settings: typeof DEFAULT_SETTINGS) {
  try {
    const raw = safeStorage.getItem('poluxis-settings');
    let base: Record<string, unknown> = {};
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') base = parsed as Record<string, unknown>;
    }
    const src = settings as unknown as Record<string, unknown>;
    for (const k of Object.keys(src)) base[k] = src[k];
    safeStorage.setItem('poluxis-settings', JSON.stringify(base));
  } catch (e) { /* ignore quota / private mode errors */ }
}

/**
 * 进度条改用 `transform: scaleX()` 驱动，不再写 `width`。
 *
 * 为什么（Performance 面板实测：Lite / 2D 渲染 + CPU 4x 限速）：
 *  - `width` 是**布局属性**，每次写入都要样式重算 + 布局；
 *  - 原先还叠了 `transition-all duration-100`，而写入间隔约 33ms（30Hz），
 *    **短于过渡时长** → 过渡永远处于进行中，每个渲染帧都要重算 width；
 *  - 实测 `UpdateLayoutTree` 303 次 / 18.73s（几乎每帧一次），
 *    平均 5.9ms、最长 72ms，约占单帧预算的 12%。
 *
 * transform 过渡由合成器执行，不进入样式重算 / 布局；且 30Hz 的写入会被
 * 100ms 的过渡插值成连续动画，平滑度反而比原来更好。
 *
 * 注意：`background` 里的 90deg 渐变是相对**元素自身盒**定义的，所以
 * `width` 与 `scaleX()` 的渐变映射完全一致，不会改变观感；唯一差异是填充
 * 右端的圆角被横向压成椭圆（4px 高的条上约 2px→1px，肉眼基本不可见）。
 */
function setProgressScale(el: HTMLElement | null, ratio: number): void {
  if (!el) return;
  const safe = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  el.style.transform = `scaleX(${safe})`;
}

export function App() {
  const { t } = useI18n();
  const { platform, ready } = usePlatform();
  const initialSettings = loadSettings();
  // R4-6: quality 渲染设置切片下沉到模块级 qualityStore（App 根 state 之外）。
  // 幂等初始化 + 自持久化（见 qualityStore）；SettingsModal/App 经 useQuality
  // 订阅，GameCanvas 仍以 props 接收。
  qualityStore.init();
  const quality = useQuality();
  // 当前正在进行的谱面加载请求（用于防快速切歌覆盖 / 卸载取消，P2-9）。
  const loadChartAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => loadChartAbortRef.current?.abort(), []);

  const [currentChart, setCurrentChart] = useState<ChartData>(DEMO_CHARTS['neon-cyberspace']);
  /** 当前局的背景媒体（歌曲目录约定 bg.jpg / bga.mp4；编辑器预览恒为空 → 纯渐变）。 */
  const [bgMedia, setBgMedia] = useState<{ image?: string; video?: string } | undefined>(undefined);
  /** 当前局的故事板脚本地址（歌曲目录约定 story.js，§3.7；仅 3D 渲染器挂载）。 */
  const [storyUrl, setStoryUrl] = useState<string | undefined>(undefined);
  // 故事板宿主挂点：bg/overlay 占位（z 序由 App 树决定）+ 3D 画布容器（game.style 目标）+ 句柄。
  const storyBgRef = useRef<HTMLDivElement | null>(null);
  const storyOverlayRef = useRef<HTMLDivElement | null>(null);
  const gameViewportRef = useRef<HTMLDivElement | null>(null);
  /** HUD / UI 层容器（`api.hud.style` 的作用目标；overlay 层恒在其之下，z-10）。 */
  const hudLayerRef = useRef<HTMLDivElement | null>(null);
  /** 判定面→屏幕投影（GameCanvas 挂载时写入；StoryboardHost 经 api.toScreen 消费）。 */
  const gameProjectorRef = useRef<((x: number, y: number) => { sx: number; sy: number }) | null>(null);
  /**
   * 游戏画布（GameCanvas 挂载时回写；`api.scene` 抓画面用）。
   * ⚠️ 必须显式回写而不能靠 `querySelector('canvas')` 猜 —— 渲染器重建时容器里
   * 可能残留旧画布，猜错会把故事板自己的画布抓回来 → 逐帧自我反馈累积。
   */
  const gameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * 指针桥（§3.7 v3）：3D 画布写入指针/投影，故事板宿主读并回写 `blockedIds`。
   * 身份必须稳定 —— 用惰性 state（而非 useRef 每次新建），否则两端会拿到不同的桥。
   */
  const [storyboardPointerBridge] = useState(createPointerBridge);
  /**
   * 当前局歌曲目录的**绝对**地址前缀（供故事板 `api.assets` 解析相对资源）。
   * 由开局时该难度的 `chartFile`（清单规范化阶段已重写成绝对地址）反推目录得到；
   * zip 导入的本地库歌曲没有可用基址 → 留空，`api.assets` 会以明确原因 reject。
   */
  const [songAssetBase, setSongAssetBase] = useState('');
  /** 当前歌曲的外部资源映射（相对路径 → idb:// 或 URL）；zip/离线导入时非空。 */
  const [songAssets, setSongAssets] = useState<Record<string, string> | undefined>(undefined);
  const storyboardHostRef = useRef<StoryboardHostHandle | null>(null);
  /**
   * 编辑器内挂载的歌曲媒体（bg.jpg / bga.mp4 / story.js 的 idb 引用，§3.7）。
   * 挂载即实时预览；已知目标歌曲（editorTarget.songId）时立即写回库，
   * 尚无歌曲上下文（自由编辑器首次保存）时暂存于此，随「保存到本地」落到新歌曲上。
   */
  const editorMediaRef = useRef<Partial<SongItem>>({});
  /** 由卡片发起谱面编辑/新建时的上下文；为 null 表示自由编辑器（保存至 Editor 专辑）。 */
  const [editorTarget, setEditorTarget] = useState<EditorLaunchInfo | null>(null);
  const [appToast, setAppToast] = useState<string | null>(null);
  const appToastTimer = useRef<number | null>(null);
  const showAppToast = useCallback((msg: string) => {
    setAppToast(msg);
    // 必须先清掉上一个定时器：否则连续两次toast 时，先前那个仍会按时把状态置空，
    // 导致后一条消息**只显示了很短时间就消失**（SongSelect 侧一直有做，这里漏了）。
    if (appToastTimer.current) window.clearTimeout(appToastTimer.current);
    appToastTimer.current = window.setTimeout(() => setAppToast(null), 2600);
  }, []);
  const [gameState, setGameState] = useState<'menu' | 'playing' | 'paused' | 'editor'>('menu');
  const gameStateRef = useRef(gameState);
  useEffect(() => { gameStateRef.current = gameState; }, [gameState]);
  const [gameTime, setGameTime] = useState(0);
  const [speedMultiplier, setSpeedMultiplier] = useState(initialSettings.speedMultiplier);
  const [autoPlay, setAutoPlay] = useState(false);
  const [audioOffsetMs, setAudioOffsetMs] = useState(initialSettings.audioOffsetMs);
  const [compatMode, setCompatMode] = useState(initialSettings.compatMode);
  /** 禁用附加内容（bg.jpg / bga.mp4 / story.js）。原始挂载值保留，只在消费点闸门处
   *  派生为 undefined —— 于是开关切换即时生效，取消勾选也不必重开当前曲目。 */
  const [disableExtraContent, setDisableExtraContent] = useState(initialSettings.disableExtraContent);
  // 兼容模式 → AudioManager 时钟源切换（谱面走墙钟）。在渲染副作用中同步，
  // 避免在 AudioContext 初始化前误设；play() 内会根据 compatMode 锚定墙钟。
  useEffect(() => {
    globalAudio.setCompatMode(compatMode);
  }, [compatMode]);
  const [projectionLeadMs, setProjectionLeadMs] = useState(initialSettings.projectionLeadMs);
  const [noteRenderDistance, setNoteRenderDistance] = useState(initialSettings.noteRenderDistance);
  const [noteSizeScale, setNoteSizeScale] = useState(initialSettings.noteSizeScale);
  // quality 渲染设置已下沉 qualityStore（见上方 qualityStore.init / useQuality）。
  const [musicVolume, setMusicVolume] = useState(initialSettings.musicVolume);
  const [effectVolume, setEffectVolume] = useState(initialSettings.effectVolume);
  // 皮肤：选中 id → 预加载后的贴图集合（传给 GameCanvas）。
  const [selectedSkinId, setSelectedSkinId] = useState<string | null>(initialSettings.selectedSkinId);
  const [skinTextures, setSkinTextures] = useState<SkinTextureSet | null>(null);
  // Lite（2D 渲染器）皮肤图集：纯图片，无需 three.js。
  const [skinImages, setSkinImages] = useState<SkinImageSet | null>(null);
  // 默认皮肤（未选皮肤包时）自定义项。
  const [defaultSkinInnerEnabled, setDefaultSkinInnerEnabled] = useState(initialSettings.defaultSkinInnerEnabled);
  const [defaultSkinOuterEnabled, setDefaultSkinOuterEnabled] = useState(initialSettings.defaultSkinOuterEnabled);
  const [defaultSkinOuterWidth, setDefaultSkinOuterWidth] = useState(initialSettings.defaultSkinOuterWidth);
  const [defaultSkinOuterColor, setDefaultSkinOuterColor] = useState(initialSettings.defaultSkinOuterColor);
  const [defaultSkinOuterAlpha, setDefaultSkinOuterAlpha] = useState(initialSettings.defaultSkinOuterAlpha);
  const [defaultSkinJudgeWidth, setDefaultSkinJudgeWidth] = useState(initialSettings.defaultSkinJudgeWidth);
  const [playSession, setPlaySession] = useState(0);
  // 渲染器"预热"标记：一旦进过游戏/编辑器就记住，返回菜单时保持挂载，使菜单的
  // 模糊背景仍能透视后面的场景；首屏菜单仍不加载 three（未预热 → 不挂载）。
  const [rendererWarmed, setRendererWarmed] = useState<{ d3: boolean; d2: boolean }>({ d3: false, d2: false });
  const [hasCustomAudio, setHasCustomAudio] = useState(false);
  const [songSelectState, setSongSelectState] = useState<SongSelectNavState | null>(null);
  // Stable identity so SongSelect's state-sync useEffect doesn't loop on every
  // render (an inline arrow here would change every render → infinite updates).
  const handleSongSelectStateChange = useCallback((state: SongSelectNavState) => {
    setSongSelectState(state);
  }, []);
  const [transitionPhase, setTransitionPhase] = useState<'idle' | 'fade-out' | 'fade-in'>('idle');
  const transitionTimerRef = useRef<number | null>(null);

  // Countdown State for Resuming Gameplay
  const [countdownVal, setCountdownVal] = useState<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);

  // Editor State
  const [editorTool, setEditorTool] = useState<EditorTool>('select');
  // ref 镜像当前工具：R 键等事件闭包中读取最新值。
  const editorToolRef = useRef<EditorTool>('select');
  useEffect(() => { editorToolRef.current = editorTool; }, [editorTool]);
  const [batchSelection, setBatchSelection] = useState<BatchSelection>({ startBeat: null, endBeat: null });
  // 多选模式：双击“选择/移动”工具、双击 R 键、或按住 Ctrl 临时进入。
  const [isMultiSelect, setIsMultiSelect] = useState(false);
  // —— 编辑选中态：单一真相源是模块级 selectionStore（App 只是订阅方）——
  // 原实现为「集合 state + 单选焦点 state + ref 镜像 + 散落各处的双写清空」，
  // 三者一致性只靠注释维持（新增写入点必须记得同步，漏一处就分叉）。
  // 现收口到 store：集合与焦点同处一个快照，写入只有 setIds / setFocus / clear
  // 三个入口，清空不再需要「记得同时清两处」。
  // 订阅后仍把值原样以 props 下发给画布，故 3D / 2D / 编辑器的 props 契约与
  // React.memo 特性零改动 —— 收口只改变「谁拥有这个状态」，不波及下游渲染链路。
  const selection = useSelection();
  const selectedNoteIds = selection.ids;
  const selectedNoteId = selection.focus;
  // 2D 框选合并方式（仅多选 + 2D 生效）。
  const [marqueeMode, setMarqueeMode] = useState<MarqueeMode>('normal');
  // Ctrl 临时切换：按住时生效，松开恢复。用 state 而非 ref，以在按住/松开时
  // 触发 re-render，让子组件及时感知多选状态。
  const [ctrlHeld, setCtrlHeld] = useState(false);
  /** 当前是否处于多选模式（含 Ctrl 临时切换）。供子组件判断交互分支。
   *  规则：Ctrl 按住时对持久多选状态取反——
   *    - 非多选（含其他工具）下按 Ctrl → 临时多选；
   *    - 多选模式下按 Ctrl → 临时变回单选；
   *  松开 Ctrl 恢复持久状态（isMultiSelect）。 */
  const effectiveMultiSelect = ctrlHeld ? !isMultiSelect : isMultiSelect;

  /** 实际生效的工具：任何工具下按 Ctrl → 临时变为多选工具（select）。
   *  多选模式下按 Ctrl（effectiveMultiSelect=false）时工具仍为 select，
   *  无需切换；其余情况沿用当前工具。 */
  const effectiveEditorTool: EditorTool =
    ctrlHeld && !isMultiSelect ? 'select' : editorTool;
  const [snapSubdivision, setSnapSubdivision] = useState<number>(0.25);
  const [editorPreviewPlaying, setEditorPreviewPlaying] = useState(false);
  const [editorPlaybackRate, setEditorPlaybackRate] = useState<number>(1);
  const [editorVlineCount, setEditorVlineCount] = useState<number>(13);
  const [editorPxPerBeat, setEditorPxPerBeat] = useState<number>(100);
  const [editorViewMode, setEditorViewMode] = useState<'3d' | '2d'>('3d');
  const [editorPreview3D, setEditorPreview3D] = useState(false);
  /** 2D 编辑器画布上是否叠加音频波形（需已加载真实音频，非自带合成器）。 */
  const [editorShowWaveform, setEditorShowWaveform] = useState(false);
  const [isPlayTestMode, setIsPlayTestMode] = useState(false);
  const playTestStartBeatRef = useRef(0);
  // 试玩起点（秒 / 拍）与“是否从当前位置开始”，用于暂停后重试时回到
  // 记录到的试玩起点，而不是整首曲子从头开始。
  const playTestStartSecRef = useRef(0);
  const playTestFromCurrentRef = useRef(false);

  // 编辑器“高级功能”：放置新音符时套用的规则（仅编辑器本地配置，存 localStorage）。
  const [editorDsl, setEditorDsl] = useState<string>(() => loadEditorDsl());
  const editorDslRef = useRef<string>(editorDsl);
  editorDslRef.current = editorDsl;

  // 编辑器加载/上传的音频引用：上传时写入 idb 得到 idb:// 引用；保存至 Editor 专辑时一并写入。
  // customAudioFileRef 持有上传的二进制（用于保存），currentAudioRefRef 持有最终要保存的引用
  // （可为上传得到的 idb://，或来自内置/在线的 URL，或重编辑时已存在的 idb://）。
  const customAudioFileRef = useRef<File | null>(null);
  const currentAudioRefRef = useRef<string | null>(null);

  // Current song info for high score tracking. scoreKey 已含来源命名空间
  // （local:/online:/ 或不加前缀的 builtin），避免同一在线曲目下载前后的成绩互通。
  const [currentSongInfo, setCurrentSongInfo] = useState<
    { songId: string; scoreKey: string; diffName: string } | null
  >(null);
  // Post-play result shown on the song-select "result card" (null = normal menu)
  const [resultInfo, setResultInfo] = useState<ResultInfo | null>(null);
  const [clearBanner, setClearBanner] = useState<'FC' | 'AP' | 'AP+' | null>(null);

  // Modals
  const [showSettings, setShowSettings] = useState(false);

  const [stats, setStats] = useState<GameStats>({
    score: 0, combo: 0, maxCombo: 0, sPerfectCount: 0, perfectCount: 0, perfectEarly: 0, perfectLate: 0, goodEarly: 0, goodLate: 0,
    goodCount: 0, missCount: 0, totalNotes: countPlayableNotes(currentChart), accuracy: 100, rank: calculateRank(0),
  });
  // R4-5: stats 镜像 ref。handleSongEnd 需读取最新 stats，但不能把 stats 放进其
  // useCallback 依赖——否则每次判定 setStats 都会让 onSongEnd 换新身份，穿透
  // GameCanvas 的 React.memo，导致每次判定整体重渲染。镜像 ref 解耦此问题。
  const statsRef = useRef(stats);
  useEffect(() => {
    statsRef.current = stats;
  }, [stats]);

  // 判定精度条 marker 现由 TimingBar 组件内部维护（经 ref 的命令式接口 push），
  // 不再经过 App 的 React state —— 否则每 ~33ms 一次 setTimingMarkers 仍会让
  // App 全树重渲染（见下方 P0 说明）。comboBurst 每 10 连击才变一次，频率极低，
  // 继续留在 React state。
  const [comboBurst, setComboBurst] = useState<{ key: number; value: number } | null>(null);
  // 判定回传节流：判定结果先进缓冲，再按固定间隔（~30Hz）批量提交。
  // 原实现「每个音符判定 → 一次 setStats + setTimingMarkers」≈60 次/秒全树重渲染
  // （Lite 版 0 次 React 渲染，这是完整版 2D 比 Lite 卡的主因）。节流只改变
  // HUD 的刷新时机，不改变判定与计分：缓冲按原顺序逐条应用，最终状态逐位一致。
  const judgementQueueRef = useRef<JudgementFeedback[]>([]);
  const judgementFlushRafRef = useRef<number | null>(null);
  const lastJudgementFlushRef = useRef(0);
  // Ambient background is a STATIC radial gradient applied imperatively (set
  // once per chart, see the effect below) — never via React state and never per
  // frame. (Its old loudness/beat pulse was removed: it was mid-quality only and
  // didn't fit the current music.)
  const ambientBgRef = useRef<HTMLDivElement | null>(null);
  // Live mirror of the current chart so editor callbacks can read fresh notes
  // without adding `currentChart` to their dependency arrays (which would make
  // the place handler stale between rapid placements).
  const currentChartRef = useRef(currentChart);
  currentChartRef.current = currentChart;

  // —— 图层（Layer）编辑态 ——
  // editorLayerId：null = 总览（合成视图）；'' = 默认根图层；其它 = 显式图层 id。
  const [editorLayerId, setEditorLayerId] = useState<string | null>(null);
  // 放置音符 / 新增事件的目标图层：隔离某图层 → 该图层；总览与默认根图层 → 默认根
  // （不写 layerId 的旧形态）。
  const placeTargetLayerId = editorLayerId ?? '';
  // 编辑器画布只看当前隔离图层的音符（总览 = 全部）。游玩 / 试玩始终用完整谱面。
  const editorChart = useMemo(() => {
    if (gameState !== 'editor' || editorLayerId === null) return currentChart;
    const lid = editorLayerId;
    /* 防御：隔离的图层在当前谱面里已不存在（换谱面 / 图层被删）→ 退回总览。
       否则 filter 会滤掉全部音符，表现为"谱面没有显示"。'' = 默认根图层，恒存在。 */
    const exists = lid === '' || (currentChart.layers ?? []).some((l) => l.id === lid);
    if (!exists) return currentChart;
    return { ...currentChart, notes: currentChart.notes.filter((n) => (n.layerId ?? '') === lid) };
  }, [currentChart, editorLayerId, gameState]);
  // Gameplay HUD is driven imperatively (no React re-render during play):
  const progressRef = useRef<HTMLDivElement | null>(null);
  // P0：连击 / 分数 / 精度+排名 也改为 ref 直写（原先绑定 React state，导致每次
  // 判定回传 setStats 都会让 App 全树重渲染 —— 这是完整版 2D 比 Lite 更耗电的主因）。
  const comboNumRef = useRef<HTMLDivElement | null>(null);
  const comboWrapRef = useRef<HTMLDivElement | null>(null);
  const scoreRef = useRef<HTMLDivElement | null>(null);
  const accRankRef = useRef<HTMLDivElement | null>(null);
  const timingBarRef = useRef<TimingBarHandle | null>(null);
  /** HUD rAF 的帧率上限门控（见 utils/frameLimiter）。 */
  const hudGateRef = useRef(createFrameGate());
  const chartDurationRef = useRef(0);
  const gameTimerRef = useRef<number | null>(null);

  /**
   * 把 statsRef 的最新数值直写进 HUD DOM（带变更守卫，避免无谓的样式/布局）。
   *
   * P0：这些元素（连击 / 分数 / ACC+RANK）原先绑定 React state，每次判定回传
   * setStats 都会触发 App 全树重渲染 —— 完整版 2D 比 Lite 更耗电的主因。
   * 现改为游玩热路径零 React：判定只写 statsRef，本函数在 HUD rAF（~30fps）
   * 里刷新 DOM；暂停前再补写一次（用于暂停浮层显示最新成绩）。
   */
  const writeHudFromStats = useCallback(() => {
    const s = statsRef.current;
    const wrap = comboWrapRef.current;
    if (wrap && comboNumRef.current) {
      if (s.combo > 0) {
        const txt = String(s.combo);
        if (comboNumRef.current.textContent !== txt) comboNumRef.current.textContent = txt;
        if (wrap.style.visibility !== 'visible') wrap.style.visibility = 'visible';
      } else if (wrap.style.visibility !== 'hidden') {
        wrap.style.visibility = 'hidden';
      }
    }
    const scoreEl = scoreRef.current;
    if (scoreEl) {
      const txt = Math.round(s.score).toLocaleString().padStart(8, '0');
      if (scoreEl.textContent !== txt) scoreEl.textContent = txt;
    }
    const accEl = accRankRef.current;
    if (accEl) {
      const judged = s.sPerfectCount + s.perfectCount + s.goodCount + s.missCount;
      const remaining = Math.max(0, s.totalNotes - judged);
      const rank = calculateRank(
        s.score + remaining * calculateNoteScore('S-Perfect', Math.max(1, s.totalNotes))
      );
      const txt = `ACC: ${s.accuracy.toFixed(2)}% | RANK: ${rank}`;
      if (accEl.textContent !== txt) accEl.textContent = txt;
    }
  }, []);
  // Set to true the instant the song finishes (handleSongEnd fires). This
  // prevents any subsequent ESC / pause-button presses from triggering the
  // paused overlay while the clear-banner / audio fade-out is running (which
  // would otherwise leave the state stuck in "paused" right before flipping
  // to the menu/result screen).
  const songEndedRef = useRef(false);
  const [isSongEnded, setIsSongEnded] = useState(false);

  useEffect(() => {
    globalAudio.setMusicVolume(musicVolume);
  }, [musicVolume]);

  useEffect(() => {
    globalAudio.setEffectVolume(effectVolume);
  }, [effectVolume]);

  // ====== Result-screen music volume ducking ====================================
  // When the result card is shown, duck the BGM to 50% of the user-set volume.
  // This makes the post-play music feel less intrusive while the player reads
  // their score / badge. When the result card is closed, restore the full volume.
  useEffect(() => {
    if (resultInfo) {
      // Entering result screen — duck to 50%
      globalAudio.setMusicVolume(musicVolume * 0.5);
    } else {
      // Exiting result screen (or initial mount) — restore full volume
      globalAudio.setMusicVolume(musicVolume);
    }
    // Cleanup on unmount: restore volume in case the component is torn down
    // while still in result mode (e.g. user navigates away).
    return () => {
      globalAudio.setMusicVolume(musicVolume);
    };
  }, [resultInfo, musicVolume]);

  // ====== Global UI click sound ==================================================
  // Capture-phase `click` listener on document. Click is deliberately used
  // instead of pointerdown so that drag gestures (card carousel, scroll
  // dragging, window resizing, etc.) never fire a UI plink — the browser
  // only dispatches `click` after a press-release pair with no significant
  // pointer movement. We also use a POSITIVE selector to match ONLY actual
  // interactive elements, so clicking empty background / modal backdrops /
  // HUD dead zones stays silent.
  useEffect(() => {
    // Elements that count as a "UI click" target / ancestor:
    //   - Semantic HTML controls (button, a[href], select, details/summary,
    //     label wrapping an input, etc.)
    //   - ARIA roles that imply clickability
    //   - Explicit opt-in via `data-ui-click="1"` attribute (for cards /
    //     custom widgets whose clickability is not obvious from the tag).
    const INTERACTIVE_SELECTOR = [
      'button',
      'a[href]',
      'summary',
      'select',
      'option',
      'label',
      '[role="button"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      '[role="menuitemcheckbox"]',
      '[role="link"]',
      '[role="option"]',
      '[role="switch"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[data-ui-click]',
    ].join(',');
    // Input subtypes that are "click activated" rather than typed/dragged.
    // Anything not on this list (text / password / range / date / number /
    // file etc.) is skipped so typing and scrubbing don't spam the plink.
    const CLICKY_INPUT_TYPES = new Set([
      'button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'color',
    ]);

    const handler = (e: MouseEvent) => {
      if (typeof e.button === 'number' && e.button !== 0) return;
      const target = e.target as Node | null;
      if (!target || target.nodeType !== 1) return;
      const tEl = target as HTMLElement;

      // Exclude the 3D game viewport entirely. Even if someone drops a
      // <button> inside it in the future, game-area events should never
      // trigger the DOM UI plink (we have note-type sfx for that).
      if (tEl.closest?.('[data-viewport="3d"]')) return;

      // Fast path: is the target itself, or any ancestor, one of the
      // whitelisted interactive selectors? If yes → proceed; otherwise this
      // is background / whitespace → skip.
      const interactive = tEl.closest?.(INTERACTIVE_SELECTOR);
      if (!interactive) return;

      // INPUT handling: only whitelisted click-subtypes produce a plink.
      if (tEl.tagName === 'INPUT') {
        const typeAttr = (tEl as HTMLInputElement).type?.toLowerCase() || '';
        if (!CLICKY_INPUT_TYPES.has(typeAttr)) return;
      }
      // TEXTAREA and non-click SELECT subtypes (e.g. when expanding a
      // dropdown the "click on the dropdown body" case) are already filtered
      // out by INTERACTIVE_SELECTOR — but let's be explicit for textarea.
      if (tEl.tagName === 'TEXTAREA') return;

      try {
        globalAudio.playUiSound();
      } catch { /* swallow */ }
    };
    document.addEventListener('click', handler, { capture: true, passive: true });
    return () => {
      document.removeEventListener('click', handler, { capture: true } as unknown as EventListenerOptions);
    };
  }, []);

  const isFirstSettingsRender = useRef(true);
  useEffect(() => {
    if (isFirstSettingsRender.current) {
      isFirstSettingsRender.current = false;
      return;
    }
    saveSettings({
      speedMultiplier, audioOffsetMs, projectionLeadMs, noteRenderDistance,
      noteSizeScale, musicVolume, effectVolume, compatMode, disableExtraContent,
      selectedSkinId, defaultSkinInnerEnabled, defaultSkinOuterEnabled, defaultSkinOuterWidth, defaultSkinOuterColor, defaultSkinOuterAlpha, defaultSkinJudgeWidth
    });
  }, [speedMultiplier, audioOffsetMs, projectionLeadMs, noteRenderDistance, noteSizeScale, musicVolume, effectVolume, compatMode, disableExtraContent, selectedSkinId, defaultSkinInnerEnabled, defaultSkinOuterEnabled, defaultSkinOuterWidth, defaultSkinOuterColor, defaultSkinOuterAlpha, defaultSkinJudgeWidth]);

  // 皮肤资产按需加载（去重 + 可等待）：key = 皮肤 id | 渲染器种类。
  // - 菜单态不加载：避免把 three 拉进首屏（保持原有约束）；
  // - 结果缓存为 promise：开局预热与挂载后 effect 重复调用只跑一次，
  //   不再每次进游戏都重新下载/解码皮肤；
  // - 令牌失效：换皮肤/换画质时，旧的在途加载结果被丢弃，不会覆盖新选择。
  const skinLoadRef = useRef<{ key: string; token: number; promise: Promise<void> }>({ key: '', token: 0, promise: Promise.resolve() });
  const ensureSkinAssets = useCallback((lite: boolean): Promise<void> => {
    const key = `${selectedSkinId ?? ''}|${lite ? '2d' : '3d'}`;
    const cached = skinLoadRef.current;
    if (cached.key === key) return cached.promise;
    const token = cached.token + 1;
    const promise = (async () => {
      if (!selectedSkinId) {
        setSkinTextures(null);
        setSkinImages(null);
        return;
      }
      const meta = await getSkin(selectedSkinId);
      if (token !== skinLoadRef.current.token) return; // 已被更新的选择取代
      if (lite) {
        // 2D 渲染器：加载纯图片皮肤（不导入 three.js）。
        const imgs = await loadSkinImages(meta);
        if (token !== skinLoadRef.current.token) return;
        setSkinImages(imgs);
        setSkinTextures(null);
      } else {
        const tex = await loadSkinTextures(meta);
        if (token !== skinLoadRef.current.token) return;
        setSkinTextures(tex);
        setSkinImages(null);
      }
    })();
    skinLoadRef.current = { key, token, promise };
    return promise;
  }, [selectedSkinId]);

  // 进入游戏/编辑器（含局间重开）时确保皮肤资产就绪。
  useEffect(() => {
    if (gameState === 'menu') return;
    void ensureSkinAssets(quality.qualityMode === 'lite');
  }, [gameState, quality.qualityMode, ensureSkinAssets]);

  // 标记渲染器已预热（按当前画质种类分别记录，避免 Lite 会话后返回菜单时误加载 three）。
  useEffect(() => {
    if (gameState === 'menu') return;
    const lite = quality.qualityMode === 'lite';
    setRendererWarmed((w) => {
      if (lite) return w.d2 ? w : { ...w, d2: true };
      return w.d3 ? w : { ...w, d3: true };
    });
  }, [gameState, quality.qualityMode]);

  // Calculate current beat from gameTime. Uses the shared inverse so charts
  // with a bpmlist stay accurate (a plain bpm*t/60 would drift after the first
  // tempo change).
  const currentBeat = secondsToBeatMultiBpm(
    gameTime,
    currentChart.metadata.bpm,
    currentChart.metadata.offset || 0,
    currentChart.metadata.bpmlist
  );
  // 编辑器处理器读取「当前播放头」一律走 playheadStore（见下方 effect 与 HUD rAF）：
  // 预览播放时它由 rAF 实时写入，非预览时与 gameTime 同步；读取方无需依赖会每帧变化的
  // currentBeat，从而保持 useCallback 身份稳定（避免 GameCanvas 被无谓重渲染）。

  // 把（低频的）gameTime 变化同步进编辑器时间源：seek / 暂停 / 进出编辑器时让编辑器
  // 显示立即跟上。预览播放期间由 HUD rAF 直接写 store，本 effect 不参与（gameTime 不变）。
  useEffect(() => {
    playheadStore.set({ timeSec: gameTime, beat: currentBeat });
  }, [gameTime, currentBeat]);

  /* ===== 首帧后才启动音频时钟 =====
   * 开局把 play() 挂起为 pending，等画布上报第一帧（GameCanvas/GameCanvas2D 的
   * onFirstFrame）再真正起走 —— 挂载、WebGL/2D 初始化、首帧渲染的耗时全部落在
   * 时钟启动之前，黑屏期间谱面时间不再竞走。等待期间画布以 t=0 渲染场景
   * （AudioManager.resetClock 保证 getCurrentTime 回退值为 0）。
   * 5s 兜底：画布万一异常未上报，也要保证游戏能开局。 */
  const pendingAudioStartRef = useRef<{ startSec: number; leadIn: number } | null>(null);
  const audioStartFallbackRef = useRef<number | null>(null);
  /** 本局画布是否已上报首帧（playSession 变化时复位）。 */
  const firstFrameRef = useRef(false);
  /** 本局故事板是否已完成重型初始化（api.markReady）；无故事板时立即为 true。 */
  const storyboardReadyRef = useRef(true);
  const clearPendingAudioStart = useCallback(() => {
    pendingAudioStartRef.current = null;
    if (audioStartFallbackRef.current) {
      window.clearTimeout(audioStartFallbackRef.current);
      audioStartFallbackRef.current = null;
    }
  }, []);
  const startPendingAudio = useCallback(() => {
    const p = pendingAudioStartRef.current;
    if (!p) return;
    clearPendingAudioStart();
    globalAudio.play(p.startSec, p.leadIn);
  }, [clearPendingAudioStart]);
  /**
   * 音频时钟的启动有两个前置条件：① 画布渲染出首帧；② 故事板重型初始化完成
   * （弱机上故事板初始化会阻塞主线程 ~10s，若不等它，音频时钟会在阻塞期间照走，
   * 解码一结束谱面就从中段开始）。两者满足（或兜底超时）才真正 play()。
   */
  const maybeStartAudio = useCallback(() => {
    if (firstFrameRef.current && storyboardReadyRef.current) startPendingAudio();
  }, [startPendingAudio]);
  const handleFirstFrame = useCallback(() => {
    firstFrameRef.current = true;
    maybeStartAudio();
  }, [maybeStartAudio]);
  const handleStoryboardReady = useCallback(() => {
    storyboardReadyRef.current = true;
    maybeStartAudio();
  }, [maybeStartAudio]);

  /**
   * 故事板歌曲目录相对资源解析（§3.7 v3 `api.assets`）。
   * 只接受 http(s)/blob 基址：`idb://`（zip 导入的本地库歌曲）不可 fetch，
   * 那类歌曲打包时也不会收录约定外的额外文件，故以明确原因 reject 让故事板降级。
   */
  const resolveStoryboardAsset = useCallback(async (relPath: string): Promise<string> => {
    // 基址来源有优先级：
    //   ① `songAssetBase` —— 由所选难度的 chartFile反推（在线/自建部署）。
    //   ② **story.js 自身 URL 的目录** —— 这才是"相对路径"的正确锚点：
    //      story.js 在 `http://localhost:61616/beatmaps/From_Phigros/Verrückt/story.js`，
    //      就应当去读**同目录**的 noise-domains.json。chartFile 为空/无斜杠时
    //      ① 会给出空串（实测症状：base="" → 判据直接拒绝），此时靠 ② 兜住。
    //      dev / build / 任意静态托管下都成立，且与部署方的目录结构无关。
    //   ③ blob:（zip 导入）—— story.js 是 blob URL，其"目录"无意义，
    //      这类歌曲应由宿主从 idb 取文件（见 StoryboardHost.assetsHandle）。
    const fromStory = dirOfUrl(storyUrl);
    const base = songAssetBase || fromStory;
    if (!isFetchableAssetBase(base)) {
      throw new Error(
        '[storyboard.assets] 当前歌曲没有可用的目录基址（zip 导入的本地库歌曲需从 idb 读取）',
      );
    }
    return resolveAssetPath(relPath, base);
  }, [songAssetBase, storyUrl]);

  const handleStartGame = useCallback((chartData: ChartData = currentChart, useCustomAudio = hasCustomAudio, songId?: string, scoreKey?: string, diffName?: string, bgMedia?: { image?: string; video?: string }, storyboardUrl?: string, assetBase?: string, assets?: Record<string, string>) => {
    // Reset the end-of-song lock BEFORE the fade-out timer starts, so the
    // player can pause during the lead-in of the *next* song if they want.
    songEndedRef.current = false;
    setIsSongEnded(false);
    if (transitionTimerRef.current) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
    // 背景媒体（约定命名 bg.jpg / bga.mp4，随歌曲走；重开局未传时清空）。
    setBgMedia(bgMedia);
    // 故事板脚本（约定命名 story.js，§3.7；仅 3D 渲染器；重开局未传时清空）。
    setStoryUrl(storyboardUrl);
    // 歌曲目录绝对基址（故事板 api.assets 解析相对资源用；重开局未传时清空）。
    setSongAssetBase(assetBase ?? '');
    setSongAssets(assets);
    /* 并行预热（与 200ms 淡出重叠进行）：渲染器代码块（首局需下载+解析 three /
     * 2D 渲染器）+ 皮肤资产。预热完成前不启动音频时钟 —— 否则弱机/慢网下画布
     * 尚未挂载、黑屏期间谱面时间已在走，玩家会白丢开头的判定窗口。 */
    const lite = quality.qualityMode === 'lite';
    const rendererReady = (lite ? loadRenderer2D() : loadRenderer3D()).catch((e) => {
      console.error('渲染器加载失败，仍尝试进入游戏', e);
    });
    const skinReady = ensureSkinAssets(lite).catch(() => { /* 皮肤加载失败：回退纯色渲染 */ });
    setTransitionPhase('fade-out');
    transitionTimerRef.current = window.setTimeout(() => {
      void (async () => {
      await Promise.all([rendererReady, skinReady]);
      globalAudio.stop();
      if (countdownTimerRef.current) {
        window.clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
      setCountdownVal(null);
      globalAudio.setOffset(audioOffsetMs / 1000);
      if (!useCustomAudio) {
        globalAudio.setSynthesizedTrack(chartData.metadata.bpm);
      }

      // Lead-in is a pure wall-clock delay before the song starts; the audio
      // offset is not part of it (AudioManager applies the offset internally).
      const firstNoteTime = getFirstNoteTime(chartData);
      const leadIn = Math.max(0, 2 - firstNoteTime);
      // 时钟不在这里启动：挂起为 pending，等「画布首帧 + 故事板预热完成」再 play()
      // （见 maybeStartAudio）。resetClock 让等待期的 getCurrentTime() 回退到 0；
      // 画布据此以 gameTime 渲染——下面把 gameTime 置为 -leadIn（预滚动位），于是
      // 等待期画面停在 lead-in 起点、且完全不做判定（不再闪一帧被judge 的 t=0 帧）。
      globalAudio.resetClock();
      firstFrameRef.current = false;
      // 无故事板、或 lite 渲染器（不挂载故事板宿主）→ 没有预热，立即可启动。
      storyboardReadyRef.current = !storyboardUrl || lite;
      pendingAudioStartRef.current = { startSec: 0, leadIn };
      audioStartFallbackRef.current = window.setTimeout(startPendingAudio, 5000);

      setCurrentChart(chartData);
      setHasCustomAudio(useCustomAudio);
      setStats({
        score: 0, combo: 0, maxCombo: 0, sPerfectCount: 0, perfectCount: 0, perfectEarly: 0, perfectLate: 0, goodEarly: 0, goodLate: 0,
        goodCount: 0, missCount: 0, totalNotes: countPlayableNotes(chartData), accuracy: 100, rank: calculateRank(0),
      });
      setComboBurst(null);
      // 丢弃上一局可能尚未 flush 的判定缓冲，避免开局后被追加到新一局的 stats 上。
      judgementQueueRef.current.length = 0;
      setResultInfo(null);
      if (songId && scoreKey && diffName) {
        setCurrentSongInfo({ songId, scoreKey, diffName });
      } else {
        setCurrentSongInfo(null);
      }
      // 预滚动位（lead-in 起点）：等待期画布以它渲染；音频一旦启动 getCurrentTime()
      // 也正好从这里（-leadIn）开始 —— 两者无缝衔接，不再闪一帧 t=0 的帧。
      setGameTime(-leadIn);
      setPlaySession((s) => s + 1);
      setGameState('playing');
      setTransitionPhase('fade-in');
      transitionTimerRef.current = window.setTimeout(() => {
        setTransitionPhase('idle');
        transitionTimerRef.current = null;
      }, 300);
      })();
    }, 200);
  }, [currentChart, hasCustomAudio, audioOffsetMs, quality.qualityMode, ensureSkinAssets]);

  /**
   * Start play-test mode from the editor.
   * @param fromCurrentBeat - if true, start at the current editor playhead position;
   *                         if false, start from the beginning (beat 0).
   * @param restartFromRecorded - if true, ignore `fromCurrentBeat` and restart from
   *                         the position where the CURRENT play-test began (recorded
   *                         in playTestStart*Ref). Used by the pause→retry button so
   *                         retrying a "play from current position" test returns to
   *                         that recorded point rather than the song's very beginning.
   */
  const handleStartPlayTest = useCallback((fromCurrentBeat: boolean, restartFromRecorded = false) => {
    if (transitionTimerRef.current) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
    if (countdownTimerRef.current) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    // Reset the end-of-song lock so the pause button isn't stuck disabled
    // from a previous play-test that ended.
    songEndedRef.current = false;
    setIsSongEnded(false);
    setCountdownVal(null);
    setEditorPreviewPlaying(false);
    // Restore 1x playback for actual playtest/gameplay.
    setEditorPlaybackRate(1);
    globalAudio.setPlaybackRate(1);

    // Resolve the start position. On a recorded restart this is the point where
    // the current play-test started; otherwise it's the live editor playhead (or 0).
    // 编辑器播放头时间源（预览播放期间由 HUD rAF 实时写入；非预览时与 gameTime 同步）。
    // 用它而非 gameTime：预览播放时 gameTime 不再每帧更新。
    const editorTime = playheadStore.getSnapshot();
    const startBeat = restartFromRecorded
      ? playTestStartBeatRef.current
      : (fromCurrentBeat ? editorTime.beat : 0);
    const startSec = restartFromRecorded
      ? playTestStartSecRef.current
      : (fromCurrentBeat ? editorTime.timeSec : 0);
    playTestStartBeatRef.current = startBeat;
    playTestStartSecRef.current = startSec;
    playTestFromCurrentRef.current = restartFromRecorded ? playTestFromCurrentRef.current : fromCurrentBeat;

    setTransitionPhase('fade-out');
    transitionTimerRef.current = window.setTimeout(() => {
      globalAudio.stop();
      globalAudio.setOffset(audioOffsetMs / 1000);
      if (!hasCustomAudio) {
        globalAudio.setSynthesizedTrack(currentChart.metadata.bpm);
      }

      const startTimeSec = startSec;

      setStats({
        score: 0, combo: 0, maxCombo: 0, sPerfectCount: 0, perfectCount: 0, perfectEarly: 0, perfectLate: 0, goodEarly: 0, goodLate: 0,
        goodCount: 0, missCount: 0, totalNotes: countPlayableNotes(currentChart), accuracy: 100, rank: calculateRank(0),
      });
      setComboBurst(null);
      // 同上：重开试玩时丢弃残留缓冲。
      judgementQueueRef.current.length = 0;
      setGameTime(startTimeSec);
      setPlaySession((s) => s + 1);
      setIsPlayTestMode(true);
      setGameState('playing');

      // 重头试玩：给首音之前的 lead-in；从当前位置 / 记录起点重试：无 lead-in。
      const noLeadIn = restartFromRecorded ? playTestFromCurrentRef.current : fromCurrentBeat;
      const leadIn = noLeadIn ? 0 : Math.max(0, 2 - getFirstNoteTime(currentChart));
      globalAudio.play(startTimeSec, leadIn);

      setTransitionPhase('fade-in');
      transitionTimerRef.current = window.setTimeout(() => {
        setTransitionPhase('idle');
        transitionTimerRef.current = null;
      }, 300);
    }, 200);
  }, [currentChart, hasCustomAudio, audioOffsetMs]);

  /**
   * Exit play-test mode and return to the editor.
   */
  const handleExitPlayTest = useCallback(() => {
    if (transitionTimerRef.current) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
    if (countdownTimerRef.current) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdownVal(null);
    setTransitionPhase('fade-out');
    transitionTimerRef.current = window.setTimeout(() => {
      globalAudio.stop();
      setIsPlayTestMode(false);
      setGameState('editor');
      // Clear the end-of-song lock (set when the play-test finished) so the
      // pause button is re-enabled for the next play-test.
      songEndedRef.current = false;
      setIsSongEnded(false);
      setEditorPreviewPlaying(false);
      setTransitionPhase('fade-in');
      transitionTimerRef.current = window.setTimeout(() => {
        setTransitionPhase('idle');
        transitionTimerRef.current = null;
      }, 300);
    }, 200);
  }, []);

  const handleReturnToMenu = useCallback(() => {
    if (transitionTimerRef.current) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
    if (countdownTimerRef.current) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdownVal(null);
    setEditorPreviewPlaying(false);
    // Reset editor playback speed so it never leaks into gameplay.
    setEditorPlaybackRate(1);
    globalAudio.setPlaybackRate(1);
    setTransitionPhase('fade-out');
    transitionTimerRef.current = window.setTimeout(() => {
      globalAudio.stop();
      clearPendingAudioStart();
      setGameState('menu');
      setTransitionPhase('fade-in');
      transitionTimerRef.current = window.setTimeout(() => {
        setTransitionPhase('idle');
        transitionTimerRef.current = null;
      }, 300);
    }, 200);
  }, []);

  // Open Visual Chart Editor directly in Gameplay
  const handleOpenVisualEditor = useCallback(() => {
    globalAudio.stop();
    if (countdownTimerRef.current) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdownVal(null);
    setGameTime(0);
    setPlaySession((s) => s + 1);
    selectionStore.setFocus(null);
    setEditorPreviewPlaying(false);
    setEditorTarget(null);
    // 图层隔离必须跟着谱面走：上一个谱面选中的图层 id 在新谱面里通常不存在，
    // editorChart 会把所有音符滤掉 → "打开新谱面却什么都不显示"。回到总览。
    setEditorLayerId(null);
    customAudioFileRef.current = null;
    currentAudioRefRef.current = null;
    // 自由编辑器 = 打开最近游玩的谱面：故事板/背景媒体**保留**（不清 storyUrl）。
    editorMediaRef.current = {};
    setGameState('editor');
  }, []);

  // 依据谱面引用（idb:// 或 URL 路径）加载 ChartData；失败返回 null。
  const loadChartFromRef = async (chartFile: string, signal?: AbortSignal): Promise<ChartData | null> => {
    let text: string | null = null;
    if (chartFile.startsWith('idb://')) {
      const blob = await getFile(chartFile.slice('idb://'.length));
      if (blob) text = await blob.text();
    } else {
      const url = resolveBeatmapUrl(chartFile);
      if (url) {
        const res = await fetch(url, signal ? { signal } : undefined);
        if (res.ok) text = await res.text();
      }
    }
    if (!text) return null;
    const r = parseAndValidateChart(text);
    return r.valid && r.chart ? r.chart : null;
  };

  // 加载编辑器对应的音乐：本地（idb://）读取 blob 生成临时 URL，其余按 URL 加载。
  // 返回**是否成功加载了真实音频**（决定编辑器预览/试玩走音频还是合成器）。
  // 失败时给出用户可见提示 + 带引用形状的诊断日志。
  const loadEditorAudio = async (audio?: string): Promise<boolean> => {
    if (!audio) return false;
    try {
      if (audio.startsWith('idb://')) {
        const blob = await getFile(audio.slice('idb://'.length));
        if (!blob) {
          console.warn('[editor] 音频 idb 引用无效（库中无此文件）：', audio);
          setAppToast('编辑器音频加载失败：本地音频引用不存在');
          return false;
        }
        const url = URL.createObjectURL(blob);
        await globalAudio.loadAudioURL(url);
        return true;
      }
      const url = resolveBeatmapUrl(audio);
      if (url) {
        await globalAudio.loadAudioURL(url);
        return true;
      }
      return false;
    } catch (e) {
      console.error('加载编辑器音频失败', { audio }, e);
      setAppToast('编辑器音频加载失败，详见控制台');
      return false;
    }
  };

  // 由卡片发起谱面编辑/新建：加载或生成谱面并进入编辑器。
  const handleLaunchChartEditor = useCallback(async (info: EditorLaunchInfo) => {
    globalAudio.stop();
    if (countdownTimerRef.current) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdownVal(null);
    setGameTime(0);
    setPlaySession((s) => s + 1);
    selectionStore.setFocus(null);
    setEditorPreviewPlaying(false);

    // 取消上一次可能仍在飞行的谱面加载，避免快速重入时旧请求后到覆盖新谱面（P2-9）。
    loadChartAbortRef.current?.abort();
    const chartLoadCtrl = new AbortController();
    loadChartAbortRef.current = chartLoadCtrl;

    let chart: ChartData | null = null;
    if (info.mode === 'edit' && info.chartFile) {
      try {
        chart = await loadChartFromRef(info.chartFile, chartLoadCtrl.signal);
      } catch (e) {
        // 被更新的加载或卸载取消：放弃本次后续状态写入，保留既有状态。
        if (chartLoadCtrl.signal.aborted) return;
        chart = null;
      }
      if (!chart) chart = buildLaunchChart(info, false);
    } else {
      // 新建谱面：空白谱面（不再使用模板）。
      chart = buildLaunchChart(info, false);
    }

    // 加载对应音乐，使编辑器可预览/播放（内置/在线走 URL，本地走 idb://）。
    // 返回值决定预览/试玩走真实音频还是合成器（见下方 setHasCustomAudio）。
    const editorHasAudio = await loadEditorAudio(info.audio);

    // 故事板（§3.7）：编辑器也挂载该曲的 MV（预览/试玩时随 globalAudio 时钟走）。
    setStoryUrl(info.storyboard ? await resolveStoryboardUrl({ storyboard: info.storyboard }) : undefined);
    editorMediaRef.current = {};

    // 记录当前音频引用（URL 或 idb://），保存至 Editor 专辑时若用户未重新上传则沿用。
    currentAudioRefRef.current = info.audio ?? null;
    customAudioFileRef.current = null;
    // ⚠️ 老 bug 修复：此前无条件 setHasCustomAudio(false) —— 本地曲目（idb:// 音频）明明
    // 已加载进 globalAudio，编辑器预览/试玩（`if (!hasCustomAudio) setSynthesizedTrack`）
    // 却永远回退合成器。现在「加载成功才走音频」；失败保持合成器 + toast 提示，
    // 同时也保住了原本要防的「上一首音频标记泄漏到合成器谱面」。
    setHasCustomAudio(editorHasAudio);

    setEditorTarget(info);
    // 同上：换谱面时把图层隔离复位到总览，避免沿用上一张谱面的图层 id。
    setEditorLayerId(null);
    setCurrentChart(chart);
    setGameState('editor');
  }, []);

  // 依据上下文构建谱面（无可用谱面文件时作为兜底，生成空白谱面）。
  const buildLaunchChart = (info: EditorLaunchInfo, copyTemplate: boolean): ChartData => {
    if (copyTemplate) {
      // 不用 structuredClone：它要求 Chrome 98+，会把最低可用版本从 73 抬到 98。
      // 谱面数据是纯 JSON 结构（无 Map/Set/Date/函数），JSON 往返克隆等价且兼容更早内核。
      const tpl = JSON.parse(JSON.stringify(DEMO_CHARTS['neon-cyberspace'])) as ChartData;
      tpl.metadata = {
        ...tpl.metadata,
        title: info.songTitle,
        artist: info.songArtist,
        difficulty: 'New',
        bpm: info.bpm,
      };
      return tpl;
    }
    return {
      metadata: {
        title: info.songTitle,
        artist: info.songArtist,
        difficulty: '',
        bpm: info.bpm,
        offset: 0,
        bgScheme: { gradientStart: '#050c1e', gradientEnd: '#1a0d2e', accentColor: info.accentColor || '#00f0ff' },
        noteColor: info.accentColor || '#00f0ff',
        effectToggles: { bloom: true, particles: true, projection: true, gridLines: true },
      },
      notes: [],
    };
  };

  // 编辑器「导入与导出」：把 bg.jpg / bga.mp4 / story.js 挂到当前编辑目标歌曲（§3.7）。
  // 挂载即实时预览（bgMedia / storyUrl）；有 songId 立即写回库，否则随「保存到本地」落地。
  const handleAttachEditorMedia = useCallback(async (kind: 'bgImage' | 'bgVideo' | 'storyboard', file: File) => {
    const ref = await storeFileDedup(file);
    if (kind === 'storyboard') {
      setStoryUrl(await resolveStoryboardUrl({ storyboard: ref }));
    } else {
      const url = await resolveCoverUrl(ref);
      setBgMedia((prev) => (kind === 'bgImage'
        ? { image: url || undefined, video: prev?.video }
        : { image: prev?.image, video: url || undefined }));
    }
    editorMediaRef.current = { ...editorMediaRef.current, [kind]: ref };
    const sid = editorTarget?.songId;
    if (sid) {
      await updateSongById(sid, kind === 'bgImage' ? { bgImage: ref } : kind === 'bgVideo' ? { bgVideo: ref } : { storyboard: ref });
    }
  }, [editorTarget]);

  /**
   * 编辑器「导出 zip」：导出**我眼前这份**。
   *
   * 两个要点（都来自实际踩坑）：
   * 1. 谱面取`chartJson`（编辑器实时、未保存的内容），绝不从 idb 读旧版本；
   * 2. **不要求绑定歌曲** —— 自由编辑器/新建谱面照样能导出，只是包里只有谱面。
   *    绑定了本地歌曲才会带上音频/封面/背景/故事板/外部资源，并导出全部难度。
   *
   * 难度定位用 `editorTarget.selectedDiffIndex`（编辑器打开的是哪一档就覆盖哪一档），
   * 不能假定是第 0 档 —— 多难度歌曲上那会覆盖错档。
   */
  const handleExportEditorZip = useCallback(
    async (chartJson: string) => {
      const target = editorTarget;
      const chart = currentChart;
      // 难度名/等级：优先用编辑目标携带的（与库一致），否则从谱面 metadata 解析。
      const dmeta = parseDifficultyMeta(chart?.metadata?.difficulty || target?.diffName || 'Custom');
      const song = target?.songId ? await findSongById(target.songId) : null;
      // 音频：编辑器「导入音频」只落在内存（customAudioFileRef）+ idb
      // （currentAudioRefRef），**不会**写回 song.audio —— 不显式覆盖就会把旧音频打进包。
      const liveAudio =
        customAudioFileRef.current ??
        (currentAudioRefRef.current ? await getFile(currentAudioRefRef.current.replace(/^idb:\/\//, '')) : null);
      const spec = await specFromChart({
        chartJson,
        title: target?.songTitle || chart?.metadata?.title || 'Untitled',
        artist: target?.songArtist || chart?.metadata?.artist || '',
        bpm: chart?.metadata?.bpm || target?.bpm || 120,
        accentColor: target?.accentColor,
        diffName: target?.diffName || dmeta.name,
        diffLevel: dmeta.level,
        song,
        diffIndex: target?.selectedDiffIndex ?? -1,
        audioOverride: liveAudio,
        audioExtHint: liveAudio ? audioExtOf(liveAudio) : undefined,
      });
      const built = await downloadSongZip(spec, spec.dir);
      // 用 showAppToast（自带定时清除）—— 直接 setAppToast 不会自动消失。
      showAppToast(
        built.skipped.length
          ? t('editor.exportZipPartial', { name: spec.dir })
          : t('editor.exportZipDone', { name: spec.dir, n: built.fileCount }),
      );
    },
    [editorTarget, currentChart, t, showAppToast],
  );

  // 卸载已挂载的歌曲媒体（编辑器「导入与导出」✕ 按钮）：实时预览同步清除 + 写回库。
  const handleDetachEditorMedia = useCallback((kind: 'bgImage' | 'bgVideo' | 'storyboard') => {
    try {
      if (kind === 'storyboard') setStoryUrl(undefined);
      else setBgMedia((prev) => (kind === 'bgImage' ? { ...prev, image: undefined } : { ...prev, video: undefined }));
      delete editorMediaRef.current[kind];
      const sid = editorTarget?.songId;
      if (sid) {
        void updateSongById(sid, kind === 'bgImage' ? { bgImage: undefined } : kind === 'bgVideo' ? { bgVideo: undefined } : { storyboard: undefined });
      }
    } catch (err) {
      console.error('卸载歌曲媒体失败', err);
      setAppToast('卸载失败，详见控制台');
    }
  }, [editorTarget]);

  // 编辑器“保存到本地”：本地谱面回写原位；否则存入 Editor 专辑。
  const handleSaveChartToLocal = useCallback(async () => {
    if (!currentChart) return;
    const json = exportChartJson(currentChart);
    const file = new File([json], `${currentChart.metadata.difficulty || 'chart'}.json`, { type: 'application/json' });
    const ref = await storeFile(file);
    const noteCount = countPlayableNotes(currentChart);
    // 难度名若为 “xxx Lv.xx” 形式，自动拆出名称与等级。
    const dmeta = parseDifficultyMeta(currentChart.metadata.difficulty || 'Custom');
    const name = dmeta.name || 'Custom';
    const level = dmeta.level;
    const target = editorTarget;
    // 仅当目标是“本地曲目（含库根独立曲目，其 albumId 可能为 null）”时回写原位，
    // 否则（内置/在线/自由编辑器）存入本地 Editor 专辑。
    const isLocalSong = !!(target && target.source === 'local' && target.songId);
    const savedAudioRef = isLocalSong ? (currentAudioRefRef.current || '') : '';

    try {
      if (isLocalSong && target) {
        const sid = target.songId!; // 已确认存在（isLocalSong 已校验）
        if (target.mode === 'edit' && target.diffName) {
          // 覆盖原难度：在整树（含库根）按 id 找到歌曲后按难度名定位；
          // 找不到该难度名则退化为新增（兼容难度名被改动的情况）。
          const song = await findSongById(sid);
          const di = song ? song.difficulties.findIndex((d) => d.name === target.diffName) : -1;
          if (song && di >= 0) {
            await updateDifficultyOfSong(sid, target.diffName, { chartFile: ref, name, level, noteCount });
          } else {
            await addDifficultyToSong(sid, { name, level, chartFile: ref, noteCount });
          }
        } else {
          // 向本地歌曲新增一个难度（新建谱面 / 无难度时现场新建）。
          await addDifficultyToSong(sid, { name, level, chartFile: ref, noteCount });
        }
        // 回写封面与音频引用（库根/专辑内本地曲目通用）：
        // currentAudioRefRef 在打开编辑器时已初始化为原音频引用，用户上传后会更新；
        // 若未改动则等于原值，写回是幂等的。封面取自谱面 jacket（若有）。
        const songPatch: Partial<SongItem> = { audio: currentAudioRefRef.current || '' };
        if (currentChart.metadata.jacket) songPatch.cover = currentChart.metadata.jacket;
        // 编辑器内挂载的背景/故事板随保存落地（幂等：已写回过的引用再写一次无妨）。
        if (editorMediaRef.current.bgImage) songPatch.bgImage = editorMediaRef.current.bgImage;
        if (editorMediaRef.current.bgVideo) songPatch.bgVideo = editorMediaRef.current.bgVideo;
        if (editorMediaRef.current.storyboard) songPatch.storyboard = editorMediaRef.current.storyboard;
        await updateSongById(sid, songPatch);
        // 难度名可能已在编辑中被改动；保存后以最新 name 刷新上下文，使下次保存
        // 仍能定位到同一难度条目（而不是退化为新增难度）。mode 置为 'edit' 让
        // 新建场景（mode:'new'）首次保存后也走覆盖分支。
        setEditorTarget({ ...target, mode: 'edit', diffName: name });
      } else {
        // 非本地（内置/在线/自由编辑器）→ 创建并保存至本地 Editor 专辑。
        const EDITOR_ALBUM_ID = 'editor';
        const existing = await getAlbumById(EDITOR_ALBUM_ID);
        if (!existing) {
          await createAlbum({
            id: EDITOR_ALBUM_ID,
            title: 'Editor',
            accentColor: '#a855f7',
            songs: [],
          });
        }
        const song: SongItem = {
          type: 'song',
          id: generateId('song'),
          title: currentChart.metadata.title || 'Untitled',
          artist: currentChart.metadata.artist || 'Unknown',
          audio: savedAudioRef,
          cover: '',
          bpm: currentChart.metadata.bpm || 120,
          accentColor: target?.accentColor || currentChart.metadata.noteColor || '#a855f7',
          basePath: '',
          difficulties: [{ name, level, chartFile: ref, noteCount }],
          source: 'local',
        };
        // 编辑器内挂载的背景/故事板随首次保存落到新歌曲上。
        if (editorMediaRef.current.bgImage) song.bgImage = editorMediaRef.current.bgImage;
        if (editorMediaRef.current.bgVideo) song.bgVideo = editorMediaRef.current.bgVideo;
        if (editorMediaRef.current.storyboard) song.storyboard = editorMediaRef.current.storyboard;
        await addSong(EDITOR_ALBUM_ID, song);
        // 记住刚创建的本地歌曲：此后再次“保存到本地”将回写该歌曲的难度原位，
        // 而不是每次都新建一首 Editor 曲目。diffName 记录首次创建的难度名，
        // 便于下次保存按名定位并覆盖同一难度。
        setEditorTarget({
          mode: 'edit',
          songId: song.id,
          songTitle: song.title,
          songArtist: song.artist,
          bpm: song.bpm,
          accentColor: song.accentColor,
          source: 'local',
          selectedDiffIndex: 0,
          difficultiesCount: 1,
          diffName: name,
        });
      }
      // 谱面已修改并保存：清掉该谱面（本地命名空间）的历史成绩，避免旧成绩误导。
      // 下载自在线的谱面 source 为 'local'，只会清掉本地副本成绩，不影响在线原曲。
      if (target && target.source === 'local' && target.songId) {
        clearHighScore(getScoreKey(target.songId, 'local'), target.diffName);
      }
      // 提示保存位置：本地曲目 → 其所在专辑；否则（自由编辑器/内置/在线）→ Editor 专辑。
      // 库根独立曲目不属于任何专辑 → 回退到通用“已保存”。
      let savedPath: string | null = null;
      if (isLocalSong && target) {
        const albumTitle = await findAlbumTitleForSong(target.songId!);
        if (albumTitle) savedPath = `/${albumTitle}`;
      } else {
        savedPath = '/Editor';
      }
      showAppToast(savedPath ? t('fab.savedTo', { path: savedPath }) : t('fab.saved'));
    } catch (err) {
      console.error(err);
      showAppToast(t('editor.saveFailed'));
    }
  }, [currentChart, editorTarget, t, showAppToast]);

  /** 把单条判定应用到 stats / markers（原 handleJudgementStable 的函数体）。
   *  纯状态更新，不含节流逻辑，便于节流层按顺序批量调用。 */
  const applyJudgement = useCallback((fb: JudgementFeedback) => {
    // P0：游玩热路径完全不触碰 React state。判定结果直接写进 statsRef，
    // HUD（连击/分数/精度+排名）由 HUD rAF 从 statsRef 直读并直写 DOM。
    // 不计分音符（noScore）：参与判定，但不计分、不计数量、不计连击 —— 统计整条跳过。
    if (fb.noScore) return;
    const prev = statsRef.current;
    const isHit = fb.type !== 'Miss';
    const newCombo = isHit ? prev.combo + 1 : 0;
    const newMaxCombo = Math.max(prev.maxCombo, newCombo);
    const sCount = prev.sPerfectCount + (fb.type === 'S-Perfect' ? 1 : 0);
    const pCount = prev.perfectCount + (fb.type === 'Perfect' ? 1 : 0);
    const gCount = prev.goodCount + (fb.type === 'Good' ? 1 : 0);
    const mCount = prev.missCount + (fb.type === 'Miss' ? 1 : 0);
    // early/late 拆分：deltaT<0 为 early（偏早命中），>=0 为 late。
    // 仅计入 Perfect 与 Good 档；S-Perfect（±40ms 临界）不参与 early/late 拆分。
    const isEarly = fb.deltaT < 0;
    const pEarly = prev.perfectEarly + (fb.type === 'Perfect' && isEarly ? 1 : 0);
    const pLate = prev.perfectLate + (fb.type === 'Perfect' && !isEarly ? 1 : 0);
    const gEarly = prev.goodEarly + (fb.type === 'Good' && isEarly ? 1 : 0);
    const gLate = prev.goodLate + (fb.type === 'Good' && !isEarly ? 1 : 0);
    const newScore = prev.score + fb.scoreGained;
    const judgedTotal = sCount + pCount + gCount + mCount;
    const newAcc = judgedTotal > 0 ? ((sCount + pCount + gCount * 0.5) / judgedTotal) * 100 : 100;

    statsRef.current = {
      ...prev, score: newScore, combo: newCombo, maxCombo: newMaxCombo,
      sPerfectCount: sCount, perfectCount: pCount, goodCount: gCount, missCount: mCount,
      perfectEarly: pEarly, perfectLate: pLate, goodEarly: gEarly, goodLate: gLate,
      accuracy: newAcc, rank: calculateRank(newScore),
    };

    // 故事板（§3.7）：判定事件流转发。只读旁路 —— 宿主内部对回调异常兜底，
    // 这里即使无人订阅也只是一次 ref 空判，热路径零额外分配。
    storyboardHostRef.current?.dispatchJudge({
      level: fb.type,
      timeSec: globalAudio.getCurrentTime(),
      deltaT: fb.deltaT,
      x: fb.x,
      y: fb.y,
      noteType: fb.noteType,
    });

    if (newCombo > 0 && newCombo % 10 === 0) {
      setComboBurst({ key: Date.now(), value: newCombo });
    }

    // 精度条 marker：命令式推给 TimingBar（其内部自管生命周期与清理 timer）。
    timingBarRef.current?.push({ id: `${fb.id}-${fb.createdAt}`, dt: fb.deltaT, type: fb.type });
  }, []);

  /** 立即排空判定缓冲（结算 / 暂停等需要读到最新 stats 的时刻调用）。 */
  const flushJudgements = useCallback(() => {
    if (judgementFlushRafRef.current !== null) {
      cancelAnimationFrame(judgementFlushRafRef.current);
      judgementFlushRafRef.current = null;
    }
    const q = judgementQueueRef.current;
    if (q.length === 0) return;
    judgementQueueRef.current = [];
    lastJudgementFlushRef.current = performance.now();
    for (let i = 0; i < q.length; i++) applyJudgement(q[i]);
  }, [applyJudgement]);

  const handleSongEnd = useCallback(() => {
    // 结算要读最新 stats：先把节流缓冲里残留的判定立即应用掉。
    flushJudgements();
    if (gameState !== 'editor') {
      // Lock pause IMMEDIATELY — no pause-overlay insertion while we are
      // running the clear-banner / fade-out sequence (otherwise the state
      // machine enters paused on top of the menu transition and breaks).
      songEndedRef.current = true;
      setIsSongEnded(true);
      // Fade out audio first
      globalAudio.fadeOutAndStop(1.0);

      if (isPlayTestMode) {
        // In play-test mode, return to editor instead of showing results
        setIsPlayTestMode(false);
        setGameState('editor');
        /* fadeOutAndStop() **故意**不置 isPlaying=false（见其 NOTE：置 false 会让
         * 游戏时钟回退到陈旧的 pauseTime，把整段曲终窗口的画面/粒子冻住），它把复位
         * 责任交给「曲终序列里的 stop()」。但本分支走的是编辑器而非结算页，那句
         * stop() 从未执行 —— 于是 isPlaying 与 globalAudio.isRunning() 会**永远**
         * 停在「运行中」，音频时钟一直空转。
         *
         * 故事板已不再受此影响：resolveStoryboardTime 另加了「本局仍在进行」判据，
         * 回到编辑器即刻停住。这里补复位是为了让 isRunning() 重新说真话，避免后续
         * 新的消费方再踩同一个坑。延迟到淡出时长之后，以免硬切音频；并用
         * gameStateRef 兜住竞态：若这段时间内用户已重新开始试玩，不要掐断新播放。 */
        window.setTimeout(() => {
          if (gameStateRef.current === 'editor') globalAudio.stop();
        }, 1100);
      } else {
        // Calculate badge for THIS play (shown on result card, including auto mode)
        const badge = calcBadgeFromStats(statsRef.current);

        // Save high score + best badge only if NOT auto play
        let isNewScore = false;
        let isNewB = false;
        if (currentSongInfo && !autoPlay) {
          const result = submitScore(currentSongInfo.scoreKey, currentSongInfo.diffName, statsRef.current);
          isNewScore = result?.isNewScore ?? false;
          isNewB = result?.isNewBadge ?? false;
        }

        // 平台上报：支持排行榜 / 云存储的构建提交并镜像进度；否则为空操作 / 本地。
        // 不阻塞结算展示（fire-and-forget）。
        if (currentSongInfo && !autoPlay) {
          getPlatform()
            .then((platform) => {
              platform.submitScore({
                score: statsRef.current.score,
                songId: currentSongInfo.scoreKey,
                difficulty: currentSongInfo.diffName,
                accuracy: statsRef.current.accuracy,
                rank: statsRef.current.rank,
                maxCombo: statsRef.current.maxCombo,
              });
              platform.saveProgress('highscores', getAllHighScores());
            })
            .catch(() => {});
        }

        const meta = {
          title: currentChart.metadata.title,
          artist: currentChart.metadata.artist,
          difficulty: currentChart.metadata.difficulty,
          bpm: currentChart.metadata.bpm,
        };

        const info: ResultInfo = {
          stats: statsRef.current,
          badge,
          isNewHighScore: isNewScore,
          isNewBadge: isNewB,
          songId: currentSongInfo?.songId ?? null,
          diffName: currentSongInfo?.diffName ?? null,
          meta,
        };

        // Back to song select in "result card" mode (bars hidden, enlarged card)
        const showResult = () => {
          setResultInfo(info);
          clearPendingAudioStart();
          setGameState('menu');
          setTransitionPhase('fade-in');
          transitionTimerRef.current = window.setTimeout(() => {
            setTransitionPhase('idle');
            transitionTimerRef.current = null;
          }, 300);
        };

        // Show clear banner (FC / AP / AP+) first if earned
        if (badge) {
          setClearBanner(badge);
          window.setTimeout(() => {
            setClearBanner(null);
            showResult();
          }, 1800);
        } else {
          // No badge — wait for audio fade-out (1s) then show result
          window.setTimeout(showResult, 1000);
        }
      }
    }
  }, [gameState, isPlayTestMode, currentSongInfo, autoPlay, currentChart, flushJudgements]);

  // 账号：具备平台账号能力的构建，每次启动（且用户未手动登出）尝试拉取平台身份
  // 刷新头像与昵称。公开版 getIdentity() 恒返回 null，天然走本地账号分支；失败静默回落。
  useEffect(() => {
    if (!ready || !hasPlatformIdentity()) return;
    if (accountStore.getSnapshot().optOut) return;
    let cancelled = false;
    platform
      ?.getIdentity()
      .then((identity) => {
        if (cancelled || !identity) return;
        accountStore.linkPlatform({
          id: identity.id,
          nickname: identity.nickname,
          avatar: identity.avatar ?? null,
        });
      })
      .catch((e) => console.error('failed to load platform identity', e));
    return () => {
      cancelled = true;
    };
  }, [ready, platform]);

  // 启动时从平台拉回跨设备进度（支持云存储的构建走云端；否则本地，无网络）。
  // 合并策略只升不降，不影响本地已有更好成绩。失败静默。
  useEffect(() => {
    getPlatform()
      .then((platform) => platform.loadProgress<HighScoreMap>('highscores'))
      .then((cloud) => {
        if (cloud) mergeCloudHighScores(cloud);
      })
      .catch(() => {});
  }, []);

  /**
   * 判定回传（节流版）：只入缓冲 + 预约一次按帧的批量提交。
   *
   * 高刷屏（120/144Hz）下判定可能一帧多次，原实现每次都触发 App 全树重渲染；
   * 这里把刷新频率钉在 ~30Hz，把「每判定一次全树重渲染」降为固定频率。
   * 判定与计分语义完全不变（缓冲按到达顺序逐条应用）。
   */
  const handleJudgementStable = useCallback((fb: JudgementFeedback) => {
    judgementQueueRef.current.push(fb);
    if (judgementFlushRafRef.current !== null) return;
    const tick = () => {
      judgementFlushRafRef.current = null;
      const now = performance.now();
      if (now - lastJudgementFlushRef.current < JUDGEMENT_FLUSH_MS) {
        // 还没到刷新间隔 —— 继续等下一帧，避免高刷屏上退化成 120Hz 刷新。
        judgementFlushRafRef.current = requestAnimationFrame(tick);
        return;
      }
      lastJudgementFlushRef.current = now;
      const q = judgementQueueRef.current;
      judgementQueueRef.current = [];
      for (let i = 0; i < q.length; i++) applyJudgement(q[i]);
    };
    judgementFlushRafRef.current = requestAnimationFrame(tick);
  }, [applyJudgement]);

  // Pause-only, idempotent. Used both by the manual pause button and the
  // auto-pause-on-blur/visibilitychange handler. Never resumes — so a second
  // focus-loss event (e.g. visibilitychange + blur firing together) can't
  // accidentally kick off the resume countdown.
  const pauseGame = useCallback(() => {
    // Only meaningful while actively playing: ignore if already paused, in the
    // menu, in the editor, or after the song has ended (fade-out / clear-banner
    // phase where pausing would break the menu transition).
    if (gameStateRef.current !== 'playing' || songEndedRef.current) return;
    // 暂停浮层会显示当前成绩：先把节流缓冲里的判定应用掉，避免显示滞后。
    flushJudgements();
    // flushJudgements 只更新 statsRef；HUD rAF 在暂停时会停，这里补写一次 DOM。
    writeHudFromStats();
    globalAudio.pause();
    // 玩家在首帧等待窗口内暂停：接管时钟控制，丢弃挂起的自动启动。
    clearPendingAudioStart();
    if (countdownTimerRef.current) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdownVal(null);
    // Capture live position so resume (globalAudio.play(gameTime)) is exact.
    // Gameplay no longer updates gameTime every frame, so snapshot it here.
    const liveT = globalAudio.getCurrentTime();
    setGameTime(liveT);
    setProgressScale(progressRef.current, liveT / (chartDurationRef.current || 1));
    setGameState('paused');
  }, [flushJudgements, writeHudFromStats]);

  // Pause / Resume with 3s countdown
  const handleTogglePause = () => {
    // Never allow pausing after the song has ended — the game is already in
    // the fade-out / clear-banner phase and about to transition to menu.
    if (songEndedRef.current) return;
    // If playing, pause instantly and cancel any existing countdowns
    if (gameState === 'playing') {
      pauseGame();
    }
    // If paused, we can toggle countdown resume
    else if (gameState === 'paused') {
      if (countdownVal !== null) {
        // Cancel countdown and stay paused
        if (countdownTimerRef.current) {
          window.clearInterval(countdownTimerRef.current);
          countdownTimerRef.current = null;
        }
        setCountdownVal(null);
      } else {
        // Start 3-second countdown
        setCountdownVal(3);
        let currentSec = 3;
        countdownTimerRef.current = window.setInterval(() => {
          currentSec--;
          if (currentSec <= 0) {
            if (countdownTimerRef.current) {
              window.clearInterval(countdownTimerRef.current);
              countdownTimerRef.current = null;
            }
            setCountdownVal(null);
            /* gameTime came from getCurrentTime(), and play() takes the same
             * chart-time coordinate — so it round-trips as-is. */
            globalAudio.play(gameTime);
            setGameState('playing');
          } else {
            setCountdownVal(currentSec);
          }
        }, 1000);
      }
    }
  };

  // 网页失焦 / 切到后台时自动暂停游戏。仅当游戏进行中（gameState==='playing'）
  // 生效：暂停浮层已显示、在菜单、编辑器或曲终阶段都不会触发。pauseGame 本身
  // 幂等，visibilitychange 与 blur 同时触发时第二次调用直接返回，不会误开恢复倒计时。
  // 注意这里刻意**只暂停不恢复**——回到前台需玩家手动点"继续"（与常规游戏手感一致）。
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) pauseGame(); };
    const onBlur = () => pauseGame();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
    };
  }, [pauseGame]);

  const handleEditorTogglePlay = () => {
    if (editorPreviewPlaying) {
      globalAudio.pause();
      // Snapshot the live position so resume (globalAudio.play(gameTime)) is
      // exact — the editor rAF loop stops driving gameTime the moment preview
      // playback halts, so without this a mid-song pause would resume from 0.
      setGameTime(globalAudio.getCurrentTime());
      setEditorPreviewPlaying(false);
    } else {
      globalAudio.setOffset(audioOffsetMs / 1000);
      if (!hasCustomAudio) {
        globalAudio.setSynthesizedTrack(currentChart.metadata.bpm);
      }
      // Play from the current position (gameTime). The chart clock starts exactly
      // here (beat 0.00 stays at 0.00) and the audio plays from its corresponding
      // position (audioTime = chartTime - userAudioOffset), not from the song's
      // beginning. Unlike gameplay we apply no lead-in — a negative offset must NOT
      // shove the chart back to a negative position to restart the audio from 0.
      globalAudio.play(gameTime);
      setEditorPreviewPlaying(true);
    }
  };

  const handleSeekBeat = (beat: number, opts?: { snap?: boolean }) => {
    /* 拖动 scrub 时 `snap:false` —— 过程中不吸附（大节拍步进下会「跳格」难以微调），
     * 松手时再以默认（吸附）调用一次。 */
    const snappedBeat = opts?.snap === false ? beat : Math.round(beat / snapSubdivision) * snapSubdivision;
    // No lower clamp: the editor must be able to represent and display beats
    // before 0 (e.g. negative-offset lead-in or notes placed before beat 0), so
    // the various beat read-outs correctly show negative values.
    const targetSec = beatToSecondsMultiBpm(
      snappedBeat,
      currentChart.metadata.bpm,
      currentChart.metadata.offset || 0,
      currentChart.metadata.bpmlist
    );
    setGameTime(targetSec);
    if (gameState === 'playing' || (gameState === 'editor' && editorPreviewPlaying)) {
      // In-place seek: no stop/play cycle, no lead-in, no audible gap.
      globalAudio.seek(targetSec);
    }
  };

  /** Mouse-wheel / trackpad scrubbing of the editor timeline (global, both 2D & 3D).
   *  One notch = exactly one snap subdivision. Scroll down = forward. */
  const handleEditorWheel = useCallback((e: React.WheelEvent) => {
    if (gameState !== 'editor') return;
    const dir = e.deltaY > 0 ? 1 : -1;
    const deltaBeats = dir * (snapSubdivision || 0.25);
    // 用时间源而非 gameTime：预览播放期间 gameTime 不再每帧更新。
    const curBeat = playheadStore.getSnapshot().beat;
    handleSeekBeat(curBeat + deltaBeats);
  }, [gameState, snapSubdivision, handleSeekBeat]);

  // 编辑器放置工具快捷键：q=tap, w=touch, e=slide, r=select(移动)
  useEffect(() => {
    if (gameState !== 'editor') return;
    let lastRTime = 0;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

      // Ctrl 临时多选：按住 Control 时进入多选，松开恢复。
      // 无条件 set 以规避 effect 闭包中 ctrlHeld 的过期值（React 对相同值会跳过重渲染）。
      if (e.key === 'Control') {
        setCtrlHeld(true);
        return;
      }

      let next: EditorTool | null = null;
      switch (e.key.toLowerCase()) {
        case 'q': next = 'place-tap'; break;
        case 'w': next = 'place-touch'; break;
        case 'e': next = 'place-slide'; break;
        case 'r': {
          // 双击 R 切换多选 / 单选模式。单击 R 仍切到 select 工具。
          const now = performance.now();
          if (now - lastRTime < 300) {
            // 双击：切换多选模式。
            lastRTime = 0;
            setIsMultiSelect((v) => !v);
            setEditorTool('select');
            e.preventDefault();
            return;
          }
          lastRTime = now;
          // 单击 R 从放置工具切回 select → 退出多选（双击 R 才保留多选）。
          if (editorToolRef.current !== 'select') setIsMultiSelect(false);
          next = 'select';
          break;
        }
        default: return;
      }
      e.preventDefault();
      setEditorTool(next);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') {
        setCtrlHeld(false);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [gameState]);

  // 不满足批量编辑条件时，框选方式重置为“正常”（默认）。
  // 批量编辑条件：多选模式下选中 ≥1；或非多选模式下选中 ≥2（回到单选不清除已选）。
  useEffect(() => {
    const batchActive = effectiveMultiSelect
      ? selectedNoteIds.length >= 1
      : selectedNoteIds.length >= 2;
    if (!batchActive) setMarqueeMode('normal');
  }, [effectiveMultiSelect, selectedNoteIds]);

  useEffect(() => {
    if (gameState === 'playing' || (gameState === 'editor' && editorPreviewPlaying)) {
      // Throttle HUD updates to ~20fps. The 3D canvas (GameCanvas) reads audio
      // time DIRECTLY from globalAudio in its own rAF, so it is completely
      // independent of this throttle.
      // Everything the HUD shows is written imperatively here (progress bar,
      // combo, score, ACC/RANK) — no React state involved, so App does not
      // reconcile during play. ~30fps is plenty for these non-motion elements.
      // (Lite has no React at all; this is what closes the gap.)
      // Time-based throttling replaces the old frame%3 counter. On a 144Hz
      // display the rAF fires ~144x/sec, so a frame-count throttle silently
      // became ~48fps of updates — the main mobile CPU hog.
      //   progress bar   → ~30fps (imperative DOM write, no React re-render)
      //   combo/score/ACC/RANK → ~30fps (imperative DOM writes from statsRef)
      // During pure gameplay we never call setGameTime/setStats, so App never
      // reconciles while playing. Editor preview still needs reactive time for
      // its timeline. The rAF is additionally gated by the user's frame cap.
      let lastHud = 0;
      // 兼容模式校准：每 5000ms 检测一次谱面墙钟与音频真实位置的偏差。
      // 节流到 5s 保持音频完整性——只有持续落后才重建 buffer，避免频繁 seek 噪声。
      let lastCompatCheck = 0;

      const tick = () => {
        const nowMs = performance.now();
        // 帧率上限（设置-图形）：超出的帧直接跳过，但 rAF 链继续。
        if (!hudGateRef.current(nowMs, quality.maxFps)) {
          gameTimerRef.current = requestAnimationFrame(tick);
          return;
        }
        const doHud = nowMs - lastHud >= 33;
        if (doHud) lastHud = nowMs;

        // 兼容模式校准（仅 playing 且开启时）：音频时钟停滞时，把音频 buffer
        // 跳到谱面当前点（音频跟随谱面，谱面绝不跳）。
        if (compatMode && gameState === 'playing' && nowMs - lastCompatCheck >= 5000) {
          lastCompatCheck = nowMs;
          const chartTime = globalAudio.getCurrentTime();
          const audioActual = globalAudio.getRawAudioTime();
          // 阈值 150ms：仅在音频明显落后时校准，微差（正常 jitter）不动作。
          if (audioActual < chartTime - 0.15) {
            globalAudio.nudgeAudio(chartTime);
          }
        }

        const inEditorPreview = gameState === 'editor';

        if (doHud) {
          const t = globalAudio.getCurrentTime();
          if (inEditorPreview) {
            // 编辑器预览：时间经 store 下发，只有订阅它的微型组件重渲染 ——
            // 不再 setGameTime，从而消除「整个 App 每 30fps 全树重渲染」。
            const md = currentChartRef.current.metadata;
            playheadStore.set({
              timeSec: t,
              beat: secondsToBeatMultiBpm(t, md.bpm, md.offset || 0, md.bpmlist),
            });
          }
          setProgressScale(progressRef.current, t / (chartDurationRef.current || 1));
          writeHudFromStats();
        }

        gameTimerRef.current = requestAnimationFrame(tick);
      };
      gameTimerRef.current = requestAnimationFrame(tick);
    } else {
      if (gameTimerRef.current) cancelAnimationFrame(gameTimerRef.current);
    }
    return () => {
      if (gameTimerRef.current) cancelAnimationFrame(gameTimerRef.current);
    };
  }, [gameState, editorPreviewPlaying, quality, compatMode]);

  // Visual Editor Callbacks
  /**
   * 放置音符。`x/y` 是**显示坐标**（所见即所得）；`offset` 为该音符所在图层在它
   * 自己时刻的合成偏移（缺省 0）。内部统一换算成存储坐标 base = 显示 − 偏移，
   * 并把 offset 透传给 DSL 出口裁剪 —— 否则有偏移的图层上 base 会被 ±2.4/±1.5
   * 直接裁掉，导致「指哪不打哪」（设计 §4.3/§4.4）。
   */
  const handlePlaceEditorNote = useCallback((x: number, y: number, beat?: number, offset?: { x: number; y: number }): { id: string; x: number; y: number; beat: number } | null => {
    const exactBeat = Math.round((beat ?? playheadStore.getSnapshot().beat) * 1000) / 1000;
    const ox = offset?.x ?? 0;
    const oy = offset?.y ?? 0;
    const bx = Math.round((x - ox) * 10) / 10;
    const by = Math.round((y - oy) * 10) / 10;

    const noteType: NoteData['type'] =
      editorTool === 'place-slide' ? 'slide' : editorTool === 'place-touch' ? 'touch' : 'tap';

    const base = selectedNoteId ? selectedNoteId.split('#')[0] : null;
    const sel = base ? currentChartRef.current.notes.find((n) => n.id === base) : undefined;

    // Only the slide tool auto-chains: placing while a node of an existing slide
    // chain is selected appends a child node to that chain. Two rules:
    //  1. 落点时间**早于**当前选中节点（头节点或子节点）→ 不连接，落进下方分支
    //     另起一条新的 slide 链（原来是把节点硬推到链末之后）。
    //  2. 连接成功后选中**刚放下的那个子节点**（原来保持选中链头，便于连续追加）。
    // Tap/Touch (and any non-chainable case) place a standalone note and select it.
    if (editorTool === 'place-slide' && sel && sel.type === noteType) {
      // 选中节点自身的时间：id 带 `#i` 即子节点，否则是链头。
      const hash = selectedNoteId ? selectedNoteId.indexOf('#') : -1;
      const selIdx = hash >= 0 ? parseInt(selectedNoteId!.slice(hash + 1), 10) - 1 : -1;
      const selNode = hash >= 0 ? sel.nodes?.[selIdx] : undefined;
      const selBeat = selNode ? selNode.beat : sel.beat;
      // 0.001 与既有 beat 容差一致：落点不早于选中节点才连接（相等仍按原逻辑顺延）。
      if (exactBeat >= selBeat - 0.001) {
        const lastBeat = sel.nodes && sel.nodes.length > 0 ? sel.nodes[sel.nodes.length - 1].beat : sel.beat;
        const step = Math.max(snapSubdivision, 0.05);
        const newBeat = exactBeat > lastBeat + 0.001
          ? exactBeat
          : Math.round((lastBeat + step) * 1000) / 1000;
        const childIndex = (sel.nodes ?? []).length;
        const childId = `${sel.id}#${childIndex + 1}`;
        setCurrentChart((prev) => {
          const updatedNotes = prev.notes.map((n) =>
            n.id === sel.id ? { ...n, nodes: [...(n.nodes ?? []), { beat: newBeat, x: bx, y: by }] } : n
          );
          return { ...prev, notes: updatedNotes };
        });
        // 选中刚放下的子节点：单选焦点与多选集合同步（Ctrl 切多选时集合不会为空）。
        selectionStore.setFocus(childId);
        selectionStore.setIds([childId]);
        // 返回新子节点的 id 与 x/y/beat（slide 子节点不受 DSL 影响，即传入值）。
        return { id: childId, x: bx, y: by, beat: newBeat };
      }
    }

    // Short, collision-resistant id: a 7-char base36 random (~78e9 combos).
    const newNoteId = `ed-${Math.random().toString(36).slice(2, 9)}`;
    const dslNote = applyDslToNote(
      { id: newNoteId, beat: exactBeat, x: bx, y: by, type: noteType, nodes: [] },
      editorDslRef.current,
      offset
    );
    // 放入当前目标图层（默认根图层不写 layerId，保持旧格式形态）。
    const newNote: NoteData =
      placeTargetLayerId && placeTargetLayerId !== ''
        ? { ...dslNote, layerId: placeTargetLayerId }
        : dslNote;
    // 统一选中数据源：单选焦点与多选集合都指向新音符，避免 Ctrl 切到多选后
    // 该音符不被视为已选中（多选集合为空）。
    selectionStore.setFocus(newNoteId);
    selectionStore.setIds([newNoteId]);
    setCurrentChart((prev) => ({ ...prev, notes: [...prev.notes, newNote].sort((a, b) => a.beat - b.beat) }));
    // 返回新音符 id 与 DSL 处理后的实际 x/y/beat，供 2D 放置后仅调整 y、
    // x/beat 使用规则结果（不再拉回拖动前的原值）。
    return { id: newNoteId, x: newNote.x, y: newNote.y, beat: newNote.beat };
  }, [editorTool, selectedNoteId, snapSubdivision, placeTargetLayerId]);

  const handleMoveEditorNote = useCallback((id: string, x: number, y: number, beat?: number) => {
    const hashIdx = id.indexOf('#');
    if (hashIdx >= 0) {
      const base = id.slice(0, hashIdx);
      const childIdx = parseInt(id.slice(hashIdx + 1)) - 1;
      setCurrentChart((prev) => {
        const updatedNotes = prev.notes.map((n) => {
          if (n.id !== base || !n.nodes || childIdx < 0 || childIdx >= n.nodes.length) return n;
          const nodes = n.nodes.map((sn, i) => (i === childIdx ? { ...sn, x, y, ...(beat != null ? { beat } : {}) } : sn));
          return { ...n, nodes };
        });
        return { ...prev, notes: updatedNotes };
      });
      return;
    }
    setCurrentChart((prev) => {
      const updatedNotes = prev.notes.map((n) => (n.id === id ? { ...n, x, y, ...(beat != null ? { beat } : {}) } : n));
      return { ...prev, notes: updatedNotes };
    });
  }, []);

  const handleSelectEditorNote = useCallback((id: string | null) => {
    // 统一选中逻辑：selectedNoteIds 为唯一数据源（含子节点 id#i），
    // selectedNoteId 仅在集合长度为 1 时作为单选焦点（与集合同步）。
    if (id === null) {
      // 取消单选焦点。多选模式保留集合（批量弹窗不消失）；
      // 单选模式（含切换工具后）清空集合，使音符视觉上取消选中。
      selectionStore.setFocus(null);
      if (!effectiveMultiSelect) selectionStore.setIds([]);
      return;
    }
    if (effectiveMultiSelect) {
      // 多选模式：切换精确 id（头节点或子节点独立选中，子节点不带动整条链）。
      const wasSelected = selectionStore.getSnapshot().ids.includes(id);
      selectionStore.setIds((prev) =>
        wasSelected ? prev.filter((x) => x !== id) : [...prev, id]
      );
      if (wasSelected) {
        // 取消选中：若该 note 恰是单选焦点，同步清除焦点，避免残留选中高亮。
        selectionStore.setFocus((cur) => (cur === id ? null : cur));
      } else {
        selectionStore.setFocus(id);
      }
    } else {
      // 单选模式：精确 id 作为集合唯一成员（子节点可独立选中，缺省参数继承头节点）。
      selectionStore.setFocus(id);
      selectionStore.setIds([id]);
    }
  }, [effectiveMultiSelect]);

  /** 切换多选模式（双击 select 工具 / 双击 R 触发）。 */
  const handleToggleMultiSelect = useCallback(() => {
    setIsMultiSelect((v) => !v);
  }, []);

  /** 工具切换统一入口：从其他工具（放置工具）单击切回 select 时退出多选，
   *  保证双击工具图标 / 双击 R 切回时才是多选工具；在 select 上单击不退出。 */
  const handleSetEditorTool = useCallback((tool: EditorTool) => {
    const prev = editorToolRef.current;
    setEditorTool(tool);
    // 切换到 select 且之前不是 select（发生了工具切换）→ 退出多选。
    if (tool === 'select' && prev !== 'select') {
      setIsMultiSelect(false);
    }
  }, []);

  /** 覆盖式设置多选集合（null = 清空）。同时清空单选焦点以避免两者不一致，
   *  也避免关闭批量弹窗后残留单音符面板。 */
  const handleSelectNotes = useCallback((ids: string[] | null) => {
    selectionStore.setIds(ids ?? []);
    selectionStore.setFocus(null);
  }, []);

  /** 按 marqueeMode 合并框选命中的 note id 到多选集合。 */
  const handleMarqueeSelect = useCallback((hitIds: string[], mode: MarqueeMode) => {
    selectionStore.setIds((prev) => {
      const set = new Set(prev);
      if (mode === 'normal') {
        return hitIds;
      }
      if (mode === 'add') {
        for (const id of hitIds) set.add(id);
        return Array.from(set);
      }
      if (mode === 'subtract') {
        for (const id of hitIds) set.delete(id);
        return Array.from(set);
      }
      // intersect: 框中已选中→取消，未选中→加入
      for (const id of hitIds) {
        if (set.has(id)) set.delete(id);
        else set.add(id);
      }
      return Array.from(set);
    });
    selectionStore.setFocus(null);
  }, []);

  /** 批量移动：接收一组绝对位置（头节点与子节点 id 均可），一次性写入。
   *  坐标为 **base**（存储坐标）；屏幕坐标 ±2.4/±1.5 的钳制已在画布侧按显示
   *  坐标完成（有图层偏移时 base 可合法越界，此处不再钳）。
   *  beat 不做下限钳制（2D 允许负拍）。
   *  传入绝对位置而非位移，避免节流多次提交造成位移累积。 */
  const handleMoveEditorNotes = useCallback((positions: Array<{ id: string; x: number; y: number; beat: number }>) => {
    if (positions.length === 0) return;
    const headMap = new Map<string, { x: number; y: number; beat: number }>();
    const childMap = new Map<string, { x: number; y: number; beat: number }>();
    for (const p of positions) {
      if (p.id.includes('#')) childMap.set(p.id, p);
      else headMap.set(p.id, p);
    }
    setCurrentChart((prev) => {
      const updatedNotes = prev.notes.map((n) => {
        const hp = headMap.get(n.id);
        let next = n;
        let changed = false;
        if (hp) {
          next = { ...n, x: hp.x, y: hp.y, beat: hp.beat };
          changed = true;
        }
        // 整条链一起移动：子节点也按绝对位置写入。
        if (n.nodes && n.nodes.length > 0) {
          const nodes = n.nodes.map((sn, i) => {
            const cp = childMap.get(`${n.id}#${i + 1}`);
            if (!cp) return sn;
            changed = true;
            return { ...sn, x: cp.x, y: cp.y, beat: cp.beat };
          });
          if (changed) next = { ...next, nodes };
        }
        return changed ? next : n;
      }).sort((a, b) => a.beat - b.beat);
      return { ...prev, notes: updatedNotes };
    });
  }, []);


  /** Batch-note insertion used by the "quick-create" gesture system. */
  type QcSlideEntry = NonNullable<QuickCreateDelta['slides']>[number];
  const handleApplyQuickCreateDelta = useCallback((delta: QuickCreateDelta) => {
    // 快速创建的手势坐标同样是**显示坐标**：按每个单位自己的 beat 反解成 base
    // （偏移随 beat 变，不能整批用同一个偏移），并把 offset 交给 DSL 出口裁剪。
    const qcTree = buildLayerTree(currentChartRef.current);
    const qcIdx = qcTree.byId[placeTargetLayerId] ?? 0;
    const qcMeta = currentChartRef.current.metadata;
    const qcBase = (x: number, y: number, beat: number) => {
      const o = layerOffsetAt(
        qcTree,
        qcIdx,
        beatToSecondsMultiBpm(beat, qcMeta.bpm, qcMeta.offset, qcMeta.bpmlist)
      );
      return {
        x: Math.round((x - o.x) * 10) / 10,
        y: Math.round((y - o.y) * 10) / 10,
        off: o,
      };
    };
    // 与放置一致：放入当前目标图层（默认根不写 layerId）。
    const qcLayer = placeTargetLayerId ? { layerId: placeTargetLayerId } : {};

    const newTaps: NoteData[] = (delta.taps ?? []).map((t) => {
      const b = qcBase(t.x, t.y, t.beat);
      return {
        ...applyDslToNote(
          { id: `qc-${Math.random().toString(36).slice(2, 9)}`, beat: t.beat, x: b.x, y: b.y, type: 'tap' },
          editorDslRef.current,
          b.off
        ),
        ...qcLayer,
      };
    });
    const newTouches: NoteData[] = (delta.touches ?? []).map((t) => {
      const b = qcBase(t.x, t.y, t.beat);
      return {
        ...applyDslToNote(
          { id: `qc-${Math.random().toString(36).slice(2, 9)}`, beat: t.beat, x: b.x, y: b.y, type: 'touch' },
          editorDslRef.current,
          b.off
        ),
        ...qcLayer,
      };
    });

    // Slide handling is dedup-aware: for an incoming slide {headBeat, headX,
    // headY, nodes[]}, we try to find an EXISTING slide note in the chart
    // whose head (beat, x, y) matches within tolerance — if found, the nodes
    // are MERGED into the existing note's nodes[] (deduplicated by beat) so
    // repeated in-place slide dispatches from qcOnMove don't pile up
    // duplicate slide notes.
    // slide 的头与每个子节点各自按自己的 beat 反解（比较与写入都在 base 空间进行）。
    const slidePatches: Array<{ matchId: string | null; head: QcSlideEntry; off: { x: number; y: number } }> =
      (delta.slides ?? []).map((s: QcSlideEntry) => {
        const hb = qcBase(s.headX, s.headY, s.headBeat);
        return {
          matchId: null,
          off: hb.off,
          head: {
            ...s,
            headX: hb.x,
            headY: hb.y,
            nodes: (s.nodes ?? []).map((nd) => {
              const nb = qcBase(nd.x, nd.y, nd.beat);
              return { ...nd, x: nb.x, y: nb.y };
            }),
          },
        };
      });

    setCurrentChart((prev) => {
      const slidesUpdate = [...prev.notes];
      for (const patch of slidePatches) {
        const h = patch.head;
        const existingIdx = slidesUpdate.findIndex((n) =>
          n.type === 'slide'
          && Math.abs(n.beat - h.headBeat) < 1e-3
          && Math.abs(n.x - h.headX) < 1e-2
          && Math.abs(n.y - h.headY) < 1e-2
        );
        if (existingIdx >= 0) {
          patch.matchId = slidesUpdate[existingIdx].id;
          const existing = slidesUpdate[existingIdx];
          const curNodes = existing.nodes ? [...existing.nodes] : [];
          for (const newNode of h.nodes) {
            const dupIdx = curNodes.findIndex((n) => Math.abs(n.beat - newNode.beat) < 1e-3);
            if (dupIdx >= 0) {
              curNodes[dupIdx] = { ...curNodes[dupIdx], ...newNode };
            } else {
              curNodes.push(newNode);
            }
          }
          curNodes.sort((a, b) => a.beat - b.beat);
          slidesUpdate[existingIdx] = { ...existing, nodes: curNodes };
        }
      }

      // Create any slides that did NOT match an existing head.
      const newSlides: NoteData[] = slidePatches
        .filter((p) => p.matchId === null)
        .map((p) => ({
          ...applyDslToNote(
            {
              id: `qc-${Math.random().toString(36).slice(2, 9)}`,
              beat: p.head.headBeat,
              x: p.head.headX,
              y: p.head.headY,
              type: 'slide',
              nodes: [...p.head.nodes],
            },
            editorDslRef.current,
            p.off
          ),
          ...qcLayer,
        }));

      const updatedNotes = [...slidesUpdate, ...newTaps, ...newTouches, ...newSlides]
        .sort((a, b) => a.beat - b.beat);

      return { ...prev, notes: updatedNotes };
    });

    // Per spec: suppressSelection → never auto-select notes or show panel.
    // In quick-create we always suppress, so just clear any stale selection.
    selectionStore.clear();
  }, [placeTargetLayerId]);

  const chartDuration = useMemo(() => getChartDuration(currentChart), [currentChart]);
  chartDurationRef.current = chartDuration;
  // =========================================================================
  // Per-chart HUD color palette (driven by currentChart.metadata.bgScheme).
  // We compute a handful of derivatives (lightened/darkened/alpha variants)
  // and expose them as CSS variables on the HUD root node. Tailwind classes
  // then reference those vars via arbitrary-value syntax, so hover /
  // transition modifiers keep working.
  // =========================================================================
  type HudCssVars = React.CSSProperties & { [k: `--${string}`]: string };
  const rawBgScheme = currentChart.metadata.bgScheme;
  const bgScheme = rawBgScheme && typeof rawBgScheme === 'object'
    ? { ...FALLBACK_BG, ...rawBgScheme }
    : FALLBACK_BG;
  const accent = bgScheme.accentColor;
  const hudCssVars: HudCssVars = {
    // solid variants
    '--hud-accent': accent,
    '--hud-accent-20': withAlpha(accent, 0.2),
    '--hud-accent-30': withAlpha(accent, 0.3),
    '--hud-accent-40': withAlpha(accent, 0.4),
    '--hud-accent-50': withAlpha(accent, 0.5),
    '--hud-accent-60': withAlpha(accent, 0.6),
    '--hud-accent-80': withAlpha(accent, 0.8),
    '--hud-accent-light': adjustBrightness(accent, 1.35),   // "cyan-300"-ish text
    '--hud-accent-bright': adjustBrightness(accent, 1.6),  // "cyan-200"-ish text
    '--hud-accent-dark': adjustBrightness(accent, 0.55),   // gradient end (like blue-600)
    '--hud-accent-deep': adjustBrightness(accent, 0.32),   // cyan-950
    '--hud-accent-900': adjustBrightness(accent, 0.22),    // cyan-900 for buttons
    // panel background: mix gradientStart (chart's ambient dark) with near-black
    '--hud-panel-bg': withAlpha(
      // Convert gradientStart mix with #000 first, then re-parse to add alpha.
      // We keep it simple: take gradientStart and just give it opacity.
      (bgScheme.gradientStart.startsWith('rgb') || bgScheme.gradientStart.startsWith('hsl'))
        ? '#0a1124'
        : bgScheme.gradientStart,
      0.9,
    ),
    // glow drop-shadow for countdown (we'll use inline style for precision)
  };
  // Computed inline glow variants for combo-burst / countdown drop-shadows
  // (drop-shadow doesn't take CSS var colors in all browsers, so pass directly)
  const comboBurstStroke = withAlpha(accent, 0.6);
  const countdownGlow = `drop-shadow(0 0 40px ${withAlpha(accent, 0.6)})`;
  const hudAccentLight = adjustBrightness(accent, 1.35);
  const hudAccentBright = adjustBrightness(accent, 1.6);
  const hudAccentDark = adjustBrightness(accent, 0.55);
  const hudAccent40 = withAlpha(accent, 0.4);
  const hudAccent60 = withAlpha(accent, 0.6);
  const hudAccent20 = withAlpha(accent, 0.2);
  const hudAccent10 = withAlpha(accent, 0.1);
  // Panel border tint (accent) — used on the glass pause card edge
  const panelBorder = withAlpha(accent, 0.4);
  // Primary button: gradient-from accent -> accent-dark
  const primaryGradient = `linear-gradient(135deg, ${accent} 0%, ${hudAccentDark} 100%)`;
  const primaryGradientHover = `linear-gradient(135deg, ${hudAccentLight} 0%, ${accent} 100%)`;
  const primaryShadow = `0 10px 25px -5px ${withAlpha(accent, 0.45)}`;
  // Progress bar
  const progressGradient = `linear-gradient(90deg, ${hudAccentLight} 0%, ${hudAccentDark} 100%)`;

  // Paint the ambient background for the current chart. It is a STATIC radial
  // gradient (set once per chart, never touched per frame), so it costs nothing
  // during play. Because the element has no `style` prop, React never resets this
  // imperative write on re-renders.
  useEffect(() => {
    const bg = currentChart.metadata.bgScheme;
    if (ambientBgRef.current) {
      ambientBgRef.current.style.background =
        `radial-gradient(circle at 50% 50%, ${bg.gradientEnd} 21.6%, ${bg.gradientStart} 90%)`;
    }
  }, [currentChart]);

  // Quality routing (see QualityMode in types/game.ts):
  //  - 'lite': the editor AND gameplay both use the 2D canvas renderer
  //    (GameCanvas2D) — three.js is never loaded.
  //  - otherwise: the Three.js scene (GameCanvas) is used for both.
  //  - 画面特效不再按 named 档位(low/standard/high/ultra)分派，统一由 qualityStore
  //    的 custom* 标志驱动（预设已在 qualityStore 内回填这些标志），故 3D 渲染
  //    直接消费 custom*，无需再把档位名映射成各项开关。
  const isLiteRenderer = quality.qualityMode === 'lite';
  // Lazy mount: the renderer is only pulled in when entering the editor or a chart
  // — never on a cold start at the menu. Once it has been warmed (played/edited at
  // least once) it stays mounted so the menu's blurred backdrop still shows the
  // scene behind. 'lite' never loads three (uses GameCanvas2D instead).
  const show3D = !isLiteRenderer && (gameState !== 'menu' || rendererWarmed.d3);
  const show2D = isLiteRenderer && (gameState !== 'menu' || rendererWarmed.d2);
  // Whether the perspective viewport is the active surface: in the editor the
  // top-down 2D canvas (Editor2DCanvas) takes over when viewMode === '2d' and
  // 3D preview is off.
  const viewportActive = !(gameState === 'editor' && editorViewMode === '2d' && !editorPreview3D);

  /**
   * 3D 画布 `onPlaceEditorNote` 的**稳定适配层**。
   *
   * 3D 回调只给 (x, y)，而 `handlePlaceEditorNote` 需要「拍 + 图层偏移」，故在放置
   * 瞬间按当前编辑拍求解。必须包在 `useCallback` 里：原先是内联箭头，每次 App 重
   * 渲染都换新身份，而 `GameCanvas` 的 `arePropsEqual` 是**逐 key 身份比较** → 播放
   * 期间每次判定回传都会让整棵 3D 子树重渲染，React.memo 完全失效。
   */
  const handlePlaceEditorNote3D = useCallback(
    (x: number, y: number) => {
      // 3D 编辑视图所见 = 合成后落点；写回前反解出存储坐标 base（§4.3：
      // 偏移按「被放置音符自己的时间」取值，这里即当前编辑拍的时刻）。
      const meta = currentChartRef.current.metadata;
      const b = playheadStore.getSnapshot().beat;
      const t = beatToSecondsMultiBpm(b, meta.bpm, meta.offset, meta.bpmlist);
      const tree = buildLayerTree(currentChartRef.current);
      const idx = tree.byId[placeTargetLayerId] ?? 0;
      const off = layerOffsetAt(tree, idx, t);
      // 传「显示坐标 + 偏移」，由 handlePlaceEditorNote 统一换算并做落点裁剪。
      return handlePlaceEditorNote(x, y, b, off);
    },
    [placeTargetLayerId, handlePlaceEditorNote]
  );

  return (
    <div className="relative w-full h-screen overflow-hidden bg-[#0a0d12] select-none text-white font-rajdhani">
      {/* Static ambient background: a radial gradient painted once per chart (no
          per-frame work). Rendered for every 3D tier — the WebGL canvas is
          alpha:true, so the low tier now gets the gradient background too.
          'lite' draws its own background inside GameCanvas2D, so it's skipped. */}
      {quality.qualityMode === 'lite' ? (
        <div className="absolute inset-0 bg-[#0e1218] pointer-events-none z-0" />
      ) : (
        <div ref={ambientBgRef} className="absolute inset-0 pointer-events-none opacity-75" />
      )}

      {/* 故事板背景层占位（§3.7）：ambient 渐变之上、3D 画布之下。故事板的 bg 层
          优先级最高（> bga.mp4 > bg.jpg > 渐变），DOM z 序天然实现覆盖。 */}
      <div ref={storyBgRef} className="absolute inset-0 z-0 pointer-events-none" />

      {/* 3D Viewport — mounted lazily: only when entering the editor or a chart,
          so three.js is not pulled into the first paint (menu). Inside the editor
          the viewport stays mounted and GameCanvas pauses its rAF render loop via
          `viewportActive` (zero background cost) when the 2D editor mode is
          active, so switching back to 3D resumes instantly without rebuilding the
          WebGL scene. When quality is 'lite' the 3D scene is skipped entirely and
          GameCanvas2D is used during play instead (see below). */}
      {show3D && (
      <div
        ref={gameViewportRef}
        className="absolute inset-0 z-0"
        data-viewport="3d"
        onWheel={handleEditorWheel}
      >
        <Suspense fallback={null}>
        <GameCanvas
          chart={editorChart}
          ambientBgRef={ambientBgRef}
          bgMedia={gameState === 'editor' || disableExtraContent ? undefined : bgMedia}
          projectorRef={gameProjectorRef}
          gameCanvasRef={gameCanvasRef}
          storyboardBridge={storyboardPointerBridge}
          viewportActive={viewportActive}
          isPlaying={gameState === 'playing' || (gameState === 'editor' && editorPreviewPlaying)}
          isPaused={gameState === 'paused'}
          gameTime={gameTime}
          speedMultiplier={speedMultiplier}
          projectionLeadMs={projectionLeadMs}
          noteRenderDistance={noteRenderDistance}
          noteSizeScale={noteSizeScale}
          antialias={quality.customAntialias}
          allowBloom={quality.customBloom}
          allowParticles={quality.customParticles}
          allowDynamicLighting={quality.customDynamicLighting}
          allowHitEffects={quality.customHitEffects}
          renderScale={quality.customRenderScale}
          autoPlay={autoPlay}
          playSession={playSession}
          isEditorMode={gameState === 'editor'}
          activeEditorTool={effectiveEditorTool}
          isMultiSelect={effectiveMultiSelect}
          snapSubdivision={snapSubdivision}
          onJudgement={handleJudgementStable}
          onSongEnd={handleSongEnd}
          onFirstFrame={handleFirstFrame}
          onSelectEditorNote={handleSelectEditorNote}
          onMoveEditorNote={handleMoveEditorNote}
          onPlaceEditorNote={handlePlaceEditorNote3D}
          onApplyQuickCreateDelta={handleApplyQuickCreateDelta}
          skinTextures={skinTextures}
          defaultSkinInnerEnabled={defaultSkinInnerEnabled}
          defaultSkinOuterEnabled={defaultSkinOuterEnabled}
          defaultSkinOuterWidth={defaultSkinOuterWidth}
          defaultSkinOuterColor={defaultSkinOuterColor}
          defaultSkinOuterAlpha={defaultSkinOuterAlpha}
          defaultSkinJudgeWidth={defaultSkinJudgeWidth}
        />
        </Suspense>
      </div>
      )}

      {/* 2D Lite viewport — replaces the 3D scene when quality === 'lite'. */}
      {show2D && (
      <div
        className="absolute inset-0 z-0"
        data-viewport="lite-2d"
        onWheel={gameState === 'editor' ? handleEditorWheel : undefined}
      >
        <Suspense fallback={null}>
        <GameCanvas2D
          chart={editorChart}
          bgMedia={gameState === 'editor' || disableExtraContent ? undefined : bgMedia}
          viewportActive={viewportActive}
          isPlaying={gameState === 'playing' || (gameState === 'editor' && editorPreviewPlaying)}
          isPaused={gameState === 'paused'}
          isEditorMode={gameState === 'editor'}
          activeEditorTool={effectiveEditorTool}
          selectedNoteId={selectedNoteId}
          selectedNoteIds={selectedNoteIds}
          isMultiSelect={effectiveMultiSelect}
          snapSubdivision={snapSubdivision}
          gameTime={gameTime}
          playSession={playSession}
          speedMultiplier={speedMultiplier}
          projectionLeadMs={projectionLeadMs}
          noteRenderDistance={noteRenderDistance}
          noteSizeScale={noteSizeScale}
          autoPlay={autoPlay}
          onJudgement={handleJudgementStable}
          onSongEnd={handleSongEnd}
          onFirstFrame={handleFirstFrame}
          onSelectEditorNote={handleSelectEditorNote}
          onMoveEditorNote={handleMoveEditorNote}
          onPlaceEditorNote={handlePlaceEditorNote}
          onApplyQuickCreateDelta={handleApplyQuickCreateDelta}
          skinImages={skinImages}
          defaultSkinInnerEnabled={defaultSkinInnerEnabled}
          defaultSkinOuterEnabled={defaultSkinOuterEnabled}
          defaultSkinOuterWidth={defaultSkinOuterWidth}
          defaultSkinOuterColor={defaultSkinOuterColor}
          defaultSkinOuterAlpha={defaultSkinOuterAlpha}
          defaultSkinJudgeWidth={defaultSkinJudgeWidth}
        />
        </Suspense>
      </div>
      )}

      {/* 2D top-down editor viewport (replaces 3D when in 2D mode) */}
      {gameState === 'editor' && editorViewMode === '2d' && (
        <div className="absolute inset-0 z-0" data-viewport="2d">
          <Suspense fallback={null}>
          <Editor2DCanvas
            chart={editorChart}
            gameTime={gameTime}
            preview={editorPreview3D}
            showWaveform={editorShowWaveform}
            isPlaying={editorPreviewPlaying}
            snapSubdivision={snapSubdivision}
            activeTool={effectiveEditorTool}
            selectedNoteId={selectedNoteId}
            isMultiSelect={effectiveMultiSelect}
            selectedNoteIds={selectedNoteIds}
            marqueeMode={marqueeMode}
            vlineCount={editorVlineCount}
            pxPerBeat={editorPxPerBeat}
            onPlaceNote={(x, y, beat) => {
              // 2D 俯视画布传屏幕坐标（所见即所得）：按放置目标图层在该 beat 的合成偏移反解 base。
              const tree = buildLayerTree(currentChartRef.current);
              const idx = tree.byId[placeTargetLayerId] ?? 0;
              const meta = currentChartRef.current.metadata;
              const off = layerOffsetAt(tree, idx, beatToSecondsMultiBpm(beat, meta.bpm, meta.offset || 0, meta.bpmlist));
              return handlePlaceEditorNote(x, y, beat, off);
            }}
            onMoveNote={(id, x, y, beat) => handleMoveEditorNote(id, x, y, beat)}
            onSelectNote={handleSelectEditorNote}
            onSeekBeat={handleSeekBeat}
            onSelectNotes={handleSelectNotes}
            onMarqueeSelect={handleMarqueeSelect}
            onMoveNotes={handleMoveEditorNotes}
          />
          </Suspense>
        </div>
      )}

      {/* 故事板覆盖层占位（§3.7）：画布之上、HUD(z-10)/菜单(z-20) 之下。 */}
      <div ref={storyOverlayRef} className="absolute inset-0 z-[5] pointer-events-none" />

      {/* 故事板宿主（§3.7）：仅 3D 渲染器；编辑器/菜单不挂（storyUrl → undefined 即卸载）。
          组件本身不渲染 JSX，只向上面两个占位容器命令式追加故事板 DOM。 */}
      {quality.qualityMode !== 'lite' && (
        <StoryboardHost
          ref={storyboardHostRef}
          bgSlotRef={storyBgRef}
          overlaySlotRef={storyOverlayRef}
          gameViewportRef={gameViewportRef}
          gameCanvasRef={gameCanvasRef}
          hudRef={hudLayerRef}
          pointerBridge={storyboardPointerBridge}
          resolveAssetUrl={resolveStoryboardAsset}
          songAssetBase={songAssetBase}
          songAssets={songAssets}
          projectorRef={gameProjectorRef}
          statsRef={statsRef}
          chartRef={currentChartRef}
          onReady={handleStoryboardReady}
          storyUrl={disableExtraContent || gameState === 'menu' ? undefined : storyUrl}
          playSession={playSession}
          playing={gameState === 'playing'}
          paused={gameState === 'paused'}
        />
      )}

      {/* ── UI 层：游戏内 / 编辑器 UI 全屏铺满，仅靠 safe-area 避开刘海/灵动岛；不再有 2:1 强行限制 ── */}
      <div
        ref={hudLayerRef}
        className="absolute inset-0 z-10 pointer-events-none"
        style={{
          paddingTop: 'env(safe-area-inset-top, 0px)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          paddingLeft: 'env(safe-area-inset-left, 0px)',
          paddingRight: 'env(safe-area-inset-right, 0px)',
        }}
      >

      {/* Visual Chart Editor Overlay when in Editor Mode */}
      {gameState === 'editor' && (
        <Suspense fallback={null}>
        <VisualChartEditor
          chart={currentChart}
          isPlaying={editorPreviewPlaying}
          activeTool={effectiveEditorTool}
          selectedNoteId={selectedNoteId}
          batchSelection={batchSelection}
          isMultiSelect={effectiveMultiSelect}
          selectedNoteIds={selectedNoteIds}
          marqueeMode={marqueeMode}
          snapSubdivision={snapSubdivision}
          viewMode={editorViewMode}
          preview3D={editorPreview3D}
          onTogglePreview3D={() => setEditorPreview3D((v) => !v)}
          showWaveform={editorShowWaveform}
          onToggleShowWaveform={() => setEditorShowWaveform((v) => !v)}
          onSetViewMode={(mode) => {
            setEditorViewMode(mode);
            if (mode === '2d' && editorTool === 'quick-create') {
              // Quick-create is unavailable in 2D mode.
              setEditorTool('select');
              selectionStore.setFocus(null);
              setBatchSelection({ startBeat: null, endBeat: null });
            }
          }}
          onUpdateChart={(updated) => setCurrentChart((prev) => ({ ...prev, ...updated }))}
          editorLayerId={editorLayerId}
          onEditorLayerChange={setEditorLayerId}
          onSeekBeat={handleSeekBeat}
          onTogglePlay={handleEditorTogglePlay}
          onSetActiveTool={(tool) => {
            handleSetEditorTool(tool);
            if (tool === 'quick-create') {
              // Quick-create mode must not show the floating edit panel, even
              // for a note that a prior "select" tool left highlighted.
              selectionStore.setFocus(null);
              setBatchSelection({ startBeat: null, endBeat: null });
            }
          }}
          onSelectNote={handleSelectEditorNote}
          onSetBatchSelection={(sel) => setBatchSelection(sel)}
          onToggleMultiSelect={handleToggleMultiSelect}
          onSelectNotes={handleSelectNotes}
          onMarqueeSelect={handleMarqueeSelect}
          onSetMarqueeMode={(m) => setMarqueeMode(m)}
          onMoveEditorNotes={handleMoveEditorNotes}
          onSetSnapSubdivision={(snap) => setSnapSubdivision(snap)}
          vlineCount={editorVlineCount}
          onSetVlineCount={(n) => setEditorVlineCount(n)}
          pxPerBeat={editorPxPerBeat}
          onSetPxPerBeat={(n) => setEditorPxPerBeat(n)}
          playbackRate={editorPlaybackRate}
          onSetPlaybackRate={(rate) => {
            setEditorPlaybackRate(rate);
            globalAudio.setPlaybackRate(rate);
          }}
          onUploadAudioFile={async (file) => {
            await globalAudio.loadAudioFile(file);
            setHasCustomAudio(true);
            customAudioFileRef.current = file;
            try {
              currentAudioRefRef.current = await storeFile(file);
            } catch (err) {
              console.error('保存音频失败', err);
            }
          }}
          onExitEditor={handleReturnToMenu}
          onSaveToLocal={handleSaveChartToLocal}
          onAttachMedia={handleAttachEditorMedia}
          onExportZip={handleExportEditorZip}
          onDetachMedia={handleDetachEditorMedia}
          onStartPlayTest={handleStartPlayTest}
          onApplyQuickCreateDelta={handleApplyQuickCreateDelta}
          editorDsl={editorDsl}
          onEditorDslChange={(dsl: string) => { setEditorDsl(dsl); saveEditorDsl(dsl); }}
        />
        </Suspense>
      )}

      {/* Normal Gameplay In-Game HUD */}
      {(gameState === 'playing' || gameState === 'paused') && (
        <div
          className={`absolute inset-0 z-10 pointer-events-none transition-opacity duration-300 ${
            transitionPhase === 'fade-out' ? 'opacity-0' : 'opacity-100'
          }`}
          style={hudCssVars}
        >
          {/* Background-layer Combo (large, semi-transparent, behind notes) */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            {/* 连击数由 HUD rAF 直写（ref），初始隐藏，combo>0 时显示。 */}
            <div
              ref={comboWrapRef}
              className="flex flex-col items-center select-none"
              style={{ visibility: 'hidden' }}
            >
              <div
                ref={comboNumRef}
                className="text-[12rem] leading-none font-black font-orbitron text-white/[0.07] tracking-tighter"
                style={{ textShadow: 'none' }}
              >
                0
              </div>
              <div className="text-sm font-bold uppercase tracking-[0.4em] text-white/[0.12] -mt-6">
                COMBO
              </div>
            </div>
            {comboBurst && (
              <div
                key={comboBurst.key}
                className="absolute flex items-center justify-center pointer-events-none"
                style={{ animation: 'comboBurstAnim 600ms ease-out forwards' }}
              >
                <div
                  className="text-[10rem] font-black font-orbitron text-transparent tracking-tighter"
                  style={{ WebkitTextStroke: `2px ${comboBurstStroke}` }}
                >
                  {comboBurst.value}
                </div>
              </div>
            )}
          </div>

          {/* Top HUD overlay */}
          <div className="absolute inset-x-0 top-0 z-10 pointer-events-none bg-gradient-to-b from-black/55 via-black/15 to-transparent">
            <TimingBar ref={timingBarRef} key={playSession} accentColor={accent} />

            <div className="flex items-start justify-between px-4 pt-2">
              <div>
                <div className="flex items-center gap-2">
                  <span
                    className="px-2 py-0.5 rounded text-[10px] font-bold uppercase border backdrop-blur-md"
                    style={{
                      background: hudAccent20,
                      color: hudAccentLight,
                      borderColor: hudAccent40,
                      boxShadow: `0 0 12px ${hudAccent20}, inset 0 1px 0 rgba(255,255,255,0.15)`,
                    }}
                  >
                    {currentChart.metadata.difficulty}
                  </span>
                  <span className="text-xs text-white/55 font-mono">
                    BPM {currentChart.metadata.bpm}
                  </span>
                </div>
                <h2 className="text-lg font-bold font-orbitron tracking-wider text-white drop-shadow-md">
                  {currentChart.metadata.title}
                </h2>
              </div>
              <div className="text-right">
                <div className="text-[10px] font-bold uppercase tracking-widest text-white/50">Score</div>
                <div ref={scoreRef} className="text-3xl font-black font-orbitron tracking-tight gradient-text" style={{ backgroundImage: `linear-gradient(90deg, #ffffff 0%, ${hudAccentBright} 55%, #fcd34d 100%)` }}>
                  00000000
                </div>
                <div ref={accRankRef} style={{ color: hudAccentLight }} className="text-xs font-mono">
                  ACC: 100.00% | RANK: --
                </div>
              </div>
            </div>
          </div>

          {/* 3-Second Resume Countdown overlay */}
          {countdownVal !== null && (
            <div
              className={`absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/40 pointer-events-none transition-all duration-500 ${
                countdownVal === 3
                  ? 'backdrop-blur-[8px]'
                  : countdownVal === 2
                  ? 'backdrop-blur-[4px]'
                  : 'backdrop-blur-none'
              }`}
            >
              <div className="text-center">
                <div
                  className="text-8xl sm:text-[10rem] font-black font-orbitron tracking-tighter scale-110 animate-pulse"
                  style={{ color: hudAccentLight, filter: countdownGlow }}
                >
                  {countdownVal}
                </div>
                <div className="text-xs font-bold uppercase tracking-[0.3em] text-white/55 mt-4">
                  {t('hud.getReady')}
                </div>
              </div>
            </div>
          )}

          {/* Dark Pause Overlay with Action Cards */}
          {gameState === 'paused' && countdownVal === null && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-auto">
              {/* 压暗 + 模糊单独成层（同 SongSelect）：容器自身带 backdrop-filter
                  会成为后代的 backdrop root，让暂停卡片采不到真正的游戏画面。 */}
              <div aria-hidden className="absolute inset-0 bg-black/65 backdrop-blur-md" />
              <div
                className="glass-panel-strong relative text-center max-w-sm w-full p-6 rounded-3xl animate-in zoom-in-95 duration-200"
                style={{ borderColor: panelBorder }}
              >
                <div
                  className="font-bold tracking-widest uppercase text-xs font-orbitron mb-1"
                  style={{ color: hudAccentLight }}
                >
                  {isPlayTestMode ? t('hud.playTestPaused') : t('hud.paused')}
                </div>
                <h2 className="text-xl font-bold font-orbitron text-white tracking-wider mb-6">
                  {currentChart.metadata.title}
                </h2>

                {/* 3 Cybernetic Circle Buttons (返回, 重试, 继续) */}
                <div className="flex items-center justify-center gap-6 mb-4">
                  {/* Exit/Return button (neutral glass — not themed) */}
                  <button
                    onClick={isPlayTestMode ? handleExitPlayTest : handleReturnToMenu}
                    className="glass-btn w-14 h-14 rounded-full text-white/85 hover:text-white flex items-center justify-center cursor-pointer group"
                    title={isPlayTestMode ? t('hud.backToEditor') : t('hud.backToMenu')}
                  >
                    <ArrowLeft size={22} className="group-hover:-translate-x-0.5 transition" />
                  </button>

                  {/* Continue/Resume button (primary accent themed) */}
                  <button
                    onClick={handleTogglePause}
                    className="w-18 h-18 rounded-full border text-white flex items-center justify-center transition cursor-pointer transform hover:scale-105 active:scale-95"
                    title={t('hud.continue')}
                    style={{
                      borderColor: hudAccentLight,
                      background: primaryGradient,
                      boxShadow: primaryShadow,
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = primaryGradientHover; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = primaryGradient; }}
                  >
                    <Play size={26} className="fill-white translate-x-0.5" />
                  </button>

                  {/* Restart/Retry button (subtle accent-tinted glass) */}
                  <button
                    onClick={() => isPlayTestMode ? handleStartPlayTest(false, true) : handleStartGame(currentChart, hasCustomAudio, currentSongInfo?.songId, currentSongInfo?.scoreKey, currentSongInfo?.diffName, bgMedia, storyUrl)}
                    className="w-14 h-14 rounded-full border flex items-center justify-center transition cursor-pointer group"
                    title={t('hud.retry')}
                    style={{
                      borderColor: hudAccent40,
                      background: withAlpha(accent, 0.1),
                      color: hudAccentLight,
                      boxShadow: `0 0 16px ${hudAccent10}, inset 0 1px 0 rgba(255,255,255,0.12)`,
                    }}
                    onMouseEnter={(e) => {
                      const el = e.currentTarget as HTMLButtonElement;
                      el.style.background = withAlpha(accent, 0.2);
                      el.style.color = hudAccentBright;
                    }}
                    onMouseLeave={(e) => {
                      const el = e.currentTarget as HTMLButtonElement;
                      el.style.background = withAlpha(accent, 0.1);
                      el.style.color = hudAccentLight;
                    }}
                  >
                    <RotateCcw size={20} className="group-hover:rotate-45 transition" />
                  </button>
                </div>

                <div className="text-[10px] text-white/45 uppercase tracking-wider">
                  {isPlayTestMode ? t('hud.backEditorStates') : t('hud.backMenuStates')}
                </div>
              </div>
            </div>
          )}

          {/* Bottom HUD: Progress Bar is pinned to the absolute bottom */}
          <div className="absolute inset-x-0 bottom-0 z-10 pointer-events-auto px-4 pb-1.5 bg-gradient-to-t from-black/75 via-black/25 to-transparent pt-6">
            <div
              className="w-full h-1 rounded-full overflow-hidden border backdrop-blur-sm"
              style={{
                background: 'rgba(255,255,255,0.06)',
                borderColor: 'rgba(255,255,255,0.12)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1)',
              }}
            >
              {/* 由 transform: scaleX() 驱动（见 setProgressScale 的说明）：
                  只过渡 transform，避免 width 触发布局 + transition-all 让过渡
                  永远处于进行中。will-change-transform 让它独立成合成层，
                  过渡期间完全不进入主线程样式重算。 */}
              <div
                ref={progressRef}
                className="h-full w-full origin-left rounded-full transition-transform duration-100 ease-linear will-change-transform"
                style={{
                  background: progressGradient,
                  boxShadow: `0 0 12px ${hudAccent60}`,
                  transform: 'scaleX(0)',
                }}
              />
            </div>
          </div>

          {/* Pause Button sits strictly above the timeline */}
          <div className="absolute left-4 bottom-4 z-20 pointer-events-auto">
            <button
              onClick={handleTogglePause}
              disabled={isSongEnded}
              className={`p-1.5 rounded-lg border backdrop-blur-md transition ${isSongEnded ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
              title={isSongEnded ? t('hud.songEnded') : t('hud.pause')}
              style={{
                background: withAlpha(accent, 0.12),
                borderColor: withAlpha(accent, 0.4),
                color: hudAccentLight,
                boxShadow: `0 0 14px ${hudAccent10}, inset 0 1px 0 rgba(255,255,255,0.14)`,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = withAlpha(accent, 0.24); }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = withAlpha(accent, 0.12); }}
            >
              <Pause size={16} />
            </button>
          </div>

          {/* Speed & AutoPlay display sits on bottom right above timeline */}
          <div className="absolute right-4 bottom-4 z-20 pointer-events-none font-mono text-[11px] text-white/55 flex items-center gap-3">
            <span>×{speedMultiplier.toFixed(1)}</span>
            {autoPlay && <span className="text-amber-400 font-bold">[AUTO]</span>}
          </div>
        </div>
      )}

      </div>{/* /UI 框 */}

      {/* Main Menu Screen — Vertical Card Carousel (封面背景全屏；卡片 UI 全屏铺满，靠 safe-area 避让刘海，无 2:1 限制) */}
      {gameState === 'menu' && (
        <div className={`absolute inset-0 z-20 transition-opacity duration-300 ${
          transitionPhase === 'fade-out' ? 'opacity-0' : 'opacity-100'
        } ${transitionPhase === 'fade-in' ? 'animate-fade-in' : ''}`}>
          <SongSelect
            autoPlay={autoPlay}
            initialState={songSelectState ?? undefined}
            result={resultInfo}
            onClearResult={() => setResultInfo(null)}
            onRetryCustom={() => handleStartGame(currentChart, hasCustomAudio)}
            onToggleAutoPlay={() => setAutoPlay((v) => !v)}
            onOpenSettings={() => setShowSettings(true)}
            onOpenEditor={handleOpenVisualEditor}
            onLaunchChartEditor={handleLaunchChartEditor}
            onSwitchLite={() => { window.location.href = 'lite/index.html'; }}
            onStartGame={(chart, hasAudio, songId, scoreKey, diffName, bgMedia, storyboardUrl, assetBase, songAssets) => handleStartGame(chart, hasAudio, songId, scoreKey, diffName, bgMedia, storyboardUrl, assetBase, songAssets)}
            onStateChange={handleSongSelectStateChange}
          />
        </div>
      )}

      <Suspense fallback={null}>
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        speedMultiplier={speedMultiplier}
        setSpeedMultiplier={setSpeedMultiplier}
        audioOffsetMs={audioOffsetMs}
        setAudioOffsetMs={setAudioOffsetMs}
        projectionLeadMs={projectionLeadMs}
        setProjectionLeadMs={setProjectionLeadMs}
        noteRenderDistance={noteRenderDistance}
        setNoteRenderDistance={setNoteRenderDistance}
        noteSizeScale={noteSizeScale}
        setNoteSizeScale={setNoteSizeScale}
        musicVolume={musicVolume}
        setMusicVolume={setMusicVolume}
        effectVolume={effectVolume}
        setEffectVolume={setEffectVolume}
        compatMode={compatMode}
        setCompatMode={setCompatMode}
        disableExtraContent={disableExtraContent}
        setDisableExtraContent={setDisableExtraContent}
        selectedSkinId={selectedSkinId}
        setSelectedSkinId={setSelectedSkinId}
        defaultSkinInnerEnabled={defaultSkinInnerEnabled}
        setDefaultSkinInnerEnabled={setDefaultSkinInnerEnabled}
        defaultSkinOuterEnabled={defaultSkinOuterEnabled}
        setDefaultSkinOuterEnabled={setDefaultSkinOuterEnabled}
        defaultSkinOuterWidth={defaultSkinOuterWidth}
        setDefaultSkinOuterWidth={setDefaultSkinOuterWidth}
        defaultSkinOuterColor={defaultSkinOuterColor}
        setDefaultSkinOuterColor={setDefaultSkinOuterColor}
        defaultSkinOuterAlpha={defaultSkinOuterAlpha}
        setDefaultSkinOuterAlpha={setDefaultSkinOuterAlpha}
        defaultSkinJudgeWidth={defaultSkinJudgeWidth}
        setDefaultSkinJudgeWidth={setDefaultSkinJudgeWidth}
      />
      </Suspense>
      {/* Clear Banner (FC / AP / AP+) */}
      {clearBanner && (
        <div className="fixed inset-0 z-40 flex items-center justify-center pointer-events-none">
          <div
            className={`px-12 py-4 sm:px-16 sm:py-5 rounded-2xl font-black font-orbitron text-4xl sm:text-5xl tracking-[0.2em] uppercase ${
              clearBanner === 'FC'
                ? 'bg-sky-500/20 border-4 border-sky-400 text-sky-300 shadow-[0_0_60px_rgba(56,189,248,0.6)]'
                : clearBanner === 'AP'
                ? 'bg-amber-500/20 border-4 border-amber-400 text-amber-300 shadow-[0_0_60px_rgba(251,191,36,0.6)]'
                : 'bg-amber-500/20 border-4 border-amber-400 text-amber-300 shadow-[0_0_80px_rgba(251,146,60,0.8),0_0_40px_rgba(251,191,36,0.6)]'
            }`}
            style={{
              animation: 'clearBannerEnter 600ms cubic-bezier(0.18, 0.9, 0.22, 1.2) forwards, clearBannerExit 500ms 1.3s ease-in forwards',
            }}
          >
            {clearBanner === 'FC' ? 'FULL COMBO' : clearBanner === 'AP' ? 'ALL PERFECT' : 'ALL PERFECT+'}
          </div>
        </div>
      )}

      {/* 横竖屏提示：竖屏游玩时建议横屏，切横屏自动消失，可手动关闭 */}
      <OrientationHint />

      {/* 轻量 Toast（谱面保存反馈等） */}
      {appToast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[120] px-4 py-2 rounded-xl glass-panel-strong text-sm font-bold text-white/90 shadow-2xl border border-white/15">
          {appToast}
        </div>
      )}

    </div>
  );
}

export default App;
