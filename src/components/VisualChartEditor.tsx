import React, { useState, useRef, useEffect, useMemo } from 'react';
import { cssVars } from '../utils/style';
import { GlassDropdown } from './GlassDropdown';
import { ChartData, NoteData, EventData, EventType, BpmPoint, EasingType, NoteType, SlideNodeData, NOTE_X_RANGE, NOTE_Y_RANGE, LayerData, NoteTrigger, TriggerAction } from '../types/game';
import { exportChartJson, parseAndValidateChart } from '../utils/chartParser';
import { countPlayableNotes, getMaxBeat, beatToSecondsMultiBpm } from '../utils/beatTime';
import { EASING_TYPES, EASING_FNS } from '../utils/easing';
import { buildLayerTree, layerOffsetAt, noteLayerIdx } from '../utils/layers';
import { isTriggerEventUnsupported } from '../shared/triggers';
import {
  ChevronLeft,
  ChevronRight,
  Play,
  Pause,
  RotateCcw,
  Trash2,
  Copy,
  Upload,
  Download,
  Move,
  Plus,
  X,
  Compass,
  Zap,
  Music,
  Box,
  LayoutGrid,
  FlipHorizontal,
  FlipVertical,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Wand2,
  MousePointer2,
  Settings2,
  Clock,
  BoxSelect,
  FileDown,
  Layers,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { lintDsl, applyDslToNote } from '../utils/editorRules';
import { useLiveDrag } from '../liveDragStore';
import { editorTimeStore, useEditorTime } from '../editorTimeStore';
import { EditorHeatScrubber } from './EditorHeatScrubber';

export type EditorTool = 'select' | 'place-tap' | 'place-touch' | 'place-slide' | 'quick-create';

export interface BatchSelection {
  startBeat: number | null;
  endBeat: number | null;
}

/** 2D 编辑器框选合并方式（仅多选模式下生效）。 */
export type MarqueeMode = 'normal' | 'add' | 'subtract' | 'intersect';

/** 批量编辑弹窗的功能项（下拉 + 按钮共用）。 */
export type BatchOp =
  | 'ToTap' | 'ToTouch' | 'ToSlide' | 'MkChain' | 'SplitChain'
  | 'FillL' | 'FillSI' | 'FillSO' | 'FillSIO'
  | 'FlipX' | 'FlipY' | 'UseRule'
  | 'Clone' | 'Delete';

/** Payload used by the "quick-create" gesture system to batch-place notes
 *  into the chart. A single pointer up / move dispatch may produce multiple
 *  notes of different types at once. */
export interface QuickCreateDelta {
  /** Tap to create (single note). */
  taps?: Array<{ beat: number; x: number; y: number }>;
  /** Touches to create (touch stream, one note per grid position). */
  touches?: Array<{ beat: number; x: number; y: number }>;
  /** Slide to create (one slide note, with beat-snapped head + nodes). */
  slides?: Array<{
    headBeat: number; headX: number; headY: number;
    nodes: Array<{ beat: number; x: number; y: number }>;
  }>;
  /** When true, the caller should not select any newly-created notes nor pop
   *  the floating edit panel (the user is mid-gesture / "playing through"). */
  suppressSelection?: boolean;
}

interface VisualChartEditorProps {
  chart: ChartData;
  isPlaying: boolean;
  activeTool: EditorTool;
  selectedNoteId: string | null;
  batchSelection: BatchSelection;
  /** 多选模式是否开启（双击工具 / Ctrl 临时 / 双击 R 切换）。 */
  isMultiSelect: boolean;
  /** 当前多选集合（note 的 base id，不含子节点 # 后缀）。 */
  selectedNoteIds: string[];
  /** 2D 框选合并方式。 */
  marqueeMode: MarqueeMode;
  snapSubdivision: number;
  playbackRate: number;
  onSetPlaybackRate: (rate: number) => void;
  onUpdateChart: (updated: ChartData) => void;
  /** 图层编辑态：null = 总览（合成视图）；'' = 默认根图层；其它 = 显式图层 id。 */
  editorLayerId: string | null;
  onEditorLayerChange: (id: string | null) => void;
  onSeekBeat: (beat: number) => void;
  onTogglePlay: () => void;
  onSetActiveTool: (tool: EditorTool) => void;
  onSelectNote: (id: string | null) => void;
  onSetBatchSelection: (sel: BatchSelection) => void;
  /** 翻转多选模式（双击工具 / 双击 R 触发）。 */
  onToggleMultiSelect: () => void;
  /** 覆盖式设置多选集合（null = 清空）。 */
  onSelectNotes: (ids: string[] | null) => void;
  /** 按当前 marqueeMode 合并框选命中的 note id 到多选集合。 */
  onMarqueeSelect: (hitIds: string[], mode: MarqueeMode) => void;
  onSetMarqueeMode: (mode: MarqueeMode) => void;
  /** 批量移动：写入一组绝对位置（头节点与子节点 id 均可）。 */
  onMoveEditorNotes: (positions: Array<{ id: string; x: number; y: number; beat: number }>) => void;
  onSetSnapSubdivision: (snap: number) => void;
  /** 2D editor: number of vertical grid lines (incl. edges) -> X snap columns. */
  vlineCount: number;
  onSetVlineCount: (n: number) => void;
  /** 2D editor: vertical pixels between adjacent integer beats (time-axis zoom). */
  pxPerBeat: number;
  onSetPxPerBeat: (n: number) => void;
  onUploadAudioFile: (file: File) => Promise<void>;
  onExitEditor: () => void;
  /** 保存到本地：将当前谱面写入本地库（覆盖原谱面或存入 Editor 专辑）。 */
  onSaveToLocal?: () => void;
  /**
   * 「导入与导出」：把 bg.jpg / bga.mp4 / story.js 挂到当前编辑目标歌曲（§3.7）。
   * App 侧负责存储、实时预览与写回库；此处只透传文件。抛错时显示在 fileError。
   */
  onAttachMedia?: (kind: 'bgImage' | 'bgVideo' | 'storyboard', file: File) => Promise<void> | void;
  /**
   * 「导出 zip」：把当前编辑目标歌曲整包导出（谱面/音频/封面/背景/故事板/外部资源）。
   * App 侧负责读 idb、拼 info.json 并触发下载；此处只透传当前谱面内容。
   * 抛错时显示在 fileError。
   */
  onExportZip?: (chartJson: string) => Promise<void> | void;
  /** 卸载已挂载的背景/故事板（实时预览同步清除 + 写回库）。错误由实现方兜底。 */
  onDetachMedia?: (kind: 'bgImage' | 'bgVideo' | 'storyboard') => void;
  onStartPlayTest: (fromCurrentBeat: boolean) => void;
  /** '3d' = default perspective view; '2d' = top-down falling-editor view. */
  viewMode: '3d' | '2d';
  onSetViewMode: (mode: '3d' | '2d') => void;
  onApplyQuickCreateDelta?: (delta: QuickCreateDelta) => void;
  /** 编辑器“高级功能”放置规则 DSL（仅本地配置，不写入谱面）。 */
  editorDsl: string;
  onEditorDslChange: (dsl: string) => void;
  /** Live 3D preview behind the 2D editor (2D 背景半透明, 透出背后 3D 舞台). */
  preview3D?: boolean;
  /** 切换 3D 预览开关。 */
  onTogglePreview3D?: () => void;
  /** 2D 画布上叠加半透明音频波形（仅在已加载真实音频、而非自带合成器时生效）。 */
  showWaveform?: boolean;
  /** 切换音频波形开关。 */
  onToggleShowWaveform?: () => void;
}

/** Numeric field that allows an EMPTY state (commits `null` on empty). The
 *  displayed text is decoupled from the committed value so deleting all digits
 *  does not force an immediate "0" — the chart gets the default (0) while the
 *  field stays empty for easy retyping. Syncs from props only while not focused. */
function NumField({
  value,
  onCommit,
  step,
  min,
  max,
  placeholder,
  className,
}: {
  value: number | undefined | null;
  onCommit: (v: number | null) => void;
  step?: number | string;
  min?: number;
  max?: number;
  placeholder?: string;
  className?: string;
}) {
  const [text, setText] = useState(value == null || value === 0 ? '' : String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current) {
      setText(value == null || value === 0 ? '' : String(value));
    }
  }, [value]);
  return (
    <input
      ref={ref}
      type="number"
      step={step}
      min={min}
      max={max}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (raw === '') { onCommit(null); return; }
        const n = parseFloat(raw);
        if (!Number.isNaN(n)) onCommit(n);
      }}
      onBlur={() => {
        const n = parseFloat(text);
        const v = Number.isNaN(n) ? null : n;
        onCommit(v);
        setText(v === 0 || v === null ? '' : String(v));
      }}
      className={className}
    />
  );
}

/** 吸附细分选项（0.01 = "自由"哨兵值，显示时换文案）。 */
const SNAP_CHOICES: Array<{ label: string; val: number }> = [
  { label: '1/1', val: 1 }, { label: '1/2', val: 0.5 }, { label: '1/3', val: 0.333333333333 },
  { label: '1/4', val: 0.25 }, { label: '1/6', val: 0.166666666667 }, { label: '1/8', val: 0.125 },
  { label: '1/12', val: 0.083333333333 }, { label: '1/16', val: 0.0625 }, { label: 'Free', val: 0.01 },
];

/** 缓动值下拉：公共 GlassDropdown 的薄包装（含"默认"项 = 移除键，继承头结点值）。 */
const EasingSelect: React.FC<{
  value: EasingType | 'default';
  onChange: (v: EasingType | 'default') => void;
}> = ({ value, onChange }) => {
  const { t } = useI18n();
  const options: Array<{ value: EasingType | 'default'; label: string }> = [
    { value: 'default', label: t('editor.default') },
    ...EASING_TYPES.map((et) => ({ value: et, label: et })),
  ];
  return (
    <GlassDropdown<EasingType | 'default'>
      value={value}
      options={options}
      onChange={onChange}
      className="col-span-4"
      accent="cyan"
    />
  );
};


/** Batch-edit function selector + execute button. The selected op lives in
 *  the parent's persistent state (not local), so it survives re-mounts of the
 *  batch panel when the selection changes. */
function BatchOpStateful<T extends string>({
  value,
  options,
  onSelect,
  onExecute,
  executeLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onSelect: (op: T) => void;
  onExecute: (op: T) => void;
  executeLabel: string;
}) {
  return (
    <>
      <GlassDropdown<T>
        value={value}
        options={options}
        onChange={(v) => onSelect(v)}
        className="flex-1"
        accent="amber"
      />
      <button
        onClick={() => onExecute(value)}
        className="shrink-0 px-3 py-1 rounded-lg border border-amber-400/40 bg-amber-500/20 text-amber-200 font-bold text-[11px] hover:bg-amber-500/35 transition cursor-pointer"
      >
        {executeLabel}
      </button>
    </>
  );
}

/** Compact row editing a node's rotation angle (deg) and segment easing. */
function AngleEasingRow({
  angle,
  easing,
  onAngle,
  onEasing,
  labelAngle,
  labelEasing,
}: {
  angle: number | null; // null = 缺省（empty input / inherits head / 0）
  easing: EasingType | 'default'; // 'default' = 缺省（inherits head / linear）
  onAngle: (v: number | null) => void;
  onEasing: (v: EasingType | 'default') => void;
  labelAngle: string;
  labelEasing: string;
}) {
  return (
    <div className="col-span-12 grid grid-cols-12 gap-1.5 items-center px-2 pb-1.5 text-[10px] font-mono">
      <span className="col-span-2 text-white/60">{labelAngle}</span>
      <NumField
        value={angle ?? 0}
        onCommit={onAngle}
        step={5}
        placeholder="—"
        className="col-span-3 glass-input border border-white/12 rounded px-1.5 py-0.5 text-amber-300 w-full placeholder:text-white/25"
      />
      <span className="col-span-2 text-white/60">{labelEasing}</span>
      <EasingSelect value={easing} onChange={onEasing} />
      <span className="col-span-1" />
    </div>
  );
}



/* ------------------------------------------------------------------ *
 * 播放头时间订阅组件
 *
 * 这些微型组件订阅 `editorTimeStore`，是**唯一**会随预览播放 ~30fps 重渲染的地方。
 * `VisualChartEditor` 本体不再接收高频时间 prop，因此在预览播放期间不重渲染，
 * 其 O(n) 计算也只在 chart / 选中项真正变化时才重算（见组件内的 useMemo）。
 * ------------------------------------------------------------------ */
const LiveBeat: React.FC<{ decimals?: number }> = ({ decimals = 2 }) => {
  const { beat } = useEditorTime();
  return <>{beat.toFixed(decimals)}</>;
};

const LiveTime: React.FC<{ decimals?: number }> = ({ decimals = 3 }) => {
  const { timeSec } = useEditorTime();
  return <>{timeSec.toFixed(decimals)}s</>;
};

/** Render-prop 订阅：用于需要 beat 参与的属性/计算（disabled、BPM 查询、seek 步进）。 */
const LiveBeatGate: React.FC<{ children: (beat: number) => React.ReactNode }> = ({ children }) => {
  const { beat } = useEditorTime();
  return <>{children(beat)}</>;
};

/* 时间轴拖拽条已由 EditorHeatScrubber（热力直方图）取代。 */

export const VisualChartEditor: React.FC<VisualChartEditorProps> = ({
  chart,
  isPlaying,
  activeTool,
  selectedNoteId,
  batchSelection,
  isMultiSelect,
  selectedNoteIds,
  marqueeMode,
  snapSubdivision,
  playbackRate,
  onSetPlaybackRate,
  onUpdateChart,
  editorLayerId,
  onEditorLayerChange,
  onSeekBeat,
  onTogglePlay,
  onSetActiveTool,
  onSelectNote,
  onSetBatchSelection,
  onToggleMultiSelect,
  onSelectNotes,
  onMarqueeSelect: _onMarqueeSelect,
  onSetMarqueeMode,
  onMoveEditorNotes: _onMoveEditorNotes,
  onSetSnapSubdivision,
  vlineCount,
  onSetVlineCount,
  pxPerBeat,
  onSetPxPerBeat,
  onUploadAudioFile,
  onExitEditor,
  onSaveToLocal,
  onAttachMedia,
  onExportZip,
  onDetachMedia,
  onStartPlayTest,
  viewMode,
  onSetViewMode,
  preview3D,
  onTogglePreview3D,
  showWaveform,
  onToggleShowWaveform,
  onApplyQuickCreateDelta: _onApplyQuickCreateDelta,
  editorDsl,
  onEditorDslChange,
}) => {
  const { t, lang } = useI18n();
  const beatUnit = lang === 'en' ? 'beat' : '拍';
  const ruleErrors = useMemo(() => lintDsl(editorDsl), [editorDsl]);
  // onApplyQuickCreateDelta is wired up from the parent so GameCanvas can
  // push its batch-note payloads through the same prop surface even though
  // the overlay component itself never fires it. Silence "unused variable".
  void _onApplyQuickCreateDelta;
  const [isSidebarExpanded, setIsSidebarExpanded] = useState(true);
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  // 链面板「链属性」栏（默认收起）与坐标参考系（默认屏幕坐标 = 所见即所得）。
  const [chainPropsOpen, setChainPropsOpen] = useState(false);
  const [coordFrame, setCoordFrame] = useState<'screen' | 'base'>('screen');

  /** Playback rate options for the editor (chart-making aid only). */
  const RATE_OPTIONS: Array<{ value: number; label: string }> = [
    { value: 0.25, label: '0.25x' },
    { value: 0.5, label: '0.5x' },
    { value: 1, label: '1x' },
    { value: 2, label: '2x' },
  ];
  // 初次打开仅展开“视图”与“编辑模式/放置工具”，其余面板默认收起。
  const [sectionOpen, setSectionOpen] = useState({
    view: true,
    tools: true,
    playtest: false,
    layers: false,
    events: false,
    rules: false,
    metadata: false,
    timing: false,
    batch: false,
    importExport: false,
  });

  // ----- 音符触发器（§3.4）编辑：MVP 每条一个内联动作 -----
  /** 触发器动作的**可编辑视图**：内联事件的部分字段（{ ref } 引用型在 UI 中不展开）。 */
  type TriggerEvt = Partial<EventData> & { eventType?: EventType };
  const triggerEventOf = (n: NoteData | undefined, kind: 'hit' | 'miss'): TriggerEvt | undefined => {
    if (!n || !n.trigger) return undefined;
    const list = kind === 'miss' ? n.trigger.onMiss : n.trigger.onHit?.default;
    const a = (list && list.length > 0 ? list[0] : undefined) as TriggerAction | undefined;
    if (!a || typeof (a as { ref?: string }).ref === 'string') return undefined;
    return a as TriggerEvt;
  };
  const setTriggerEvent = (kind: 'hit' | 'miss', evt: TriggerEvt | undefined) => {
    if (!selectedNote) return;
    const acts: TriggerAction[] = evt ? [evt as TriggerAction] : [];
    const next: NoteTrigger = { ...(selectedNote.trigger ?? {}) };
    if (kind === 'miss') next.onMiss = acts;
    else next.onHit = { ...(next.onHit ?? {}), default: acts };
    const has = (next.onHit?.default?.length ?? 0) > 0 || (next.onMiss?.length ?? 0) > 0;
    handleModifySelected({ trigger: has ? next : undefined });
  };

  // ----- Chart integrity check -----
  type CheckKind =
    | 'negativeBeat'
    | 'chainOrder'
    | 'coordRange'
    | 'bgOnNonRootLayer'
    | 'triggerUnsupported';
  interface CheckIssue {
    kind: CheckKind;
    /** Translated category label (drives the coloured tag). */
    cat: string;
    /** Human-readable detail line (built in code, numbers already formatted). */
    detail: string;
    /** Beat to seek to when the warning is clicked. */
    targetBeat: number;
    /** Note id to select (skipped for event issues). */
    targetId?: string;
    isEvent?: boolean;
  }
  const X_MIN = -NOTE_X_RANGE, X_MAX = NOTE_X_RANGE, Y_MIN = -NOTE_Y_RANGE, Y_MAX = NOTE_Y_RANGE;
  /** 链面板：头节点图层在给定拍的**合成偏移**（屏幕参考系 = base + 此值）。
   *  子节点无 layerId，沿用头节点图层；时间取子节点自己的 beat（偏移随拍变化）。 */
  const chainOffsetAt = (layerId: string | undefined, beat: number) => {
    const tree = buildLayerTree(chart);
    const t = beatToSecondsMultiBpm(beat, chart.metadata.bpm, chart.metadata.offset, chart.metadata.bpmlist);
    return layerOffsetAt(tree, noteLayerIdx(tree, { layerId }), t);
  };
  const round10 = (v: number) => Math.round(v * 10) / 10;
  /** base → 面板显示值（屏幕参考系下加该单位自己时刻的合成偏移）。 */
  const toFrameX = (b: number, layerId: string | undefined, beat: number) =>
    coordFrame === 'base' ? b : b + chainOffsetAt(layerId, beat).x;
  const toFrameY = (b: number, layerId: string | undefined, beat: number) =>
    coordFrame === 'base' ? b : b + chainOffsetAt(layerId, beat).y;
  /** 面板输入 → base（屏幕参考系下减去偏移；按 0.1 取整与放置一致）。 */
  const toBaseX = (v: number, layerId: string | undefined, beat: number) =>
    round10(v - (coordFrame === 'screen' ? chainOffsetAt(layerId, beat).x : 0));
  const toBaseY = (v: number, layerId: string | undefined, beat: number) =>
    round10(v - (coordFrame === 'screen' ? chainOffsetAt(layerId, beat).y : 0));
  // 最新谱面引用：偏移复检在防抖回调里执行，不能闭包捕获旧的 chart。
  const chartRef = useRef(chart);
  chartRef.current = chart;
  const [checkIssues, setCheckIssues] = useState<CheckIssue[]>([]);
  const [showCheck, setShowCheck] = useState(false);
  const [checkRan, setCheckRan] = useState(false);

  const runChartCheck = () => {
    const issues: CheckIssue[] = [];
    // 图层偏移下 base 坐标可合法越界（如偏移 -1 时显示 x=2.4 的 base 是 3.4）；
    // 越界校验只针对「合成后落点」＝ base + 图层偏移(音符自己的时间)（设计 §4.4）。
    const checkTree = buildLayerTree(chart);
    const landingOf = (x: number, y: number, beat: number, layerId?: string) => {
      const t = beatToSecondsMultiBpm(beat, chart.metadata.bpm, chart.metadata.offset, chart.metadata.bpmlist);
      const off = layerOffsetAt(checkTree, noteLayerIdx(checkTree, { layerId }), t);
      return { x: x + off.x, y: y + off.y };
    };
    for (const note of chart.notes) {
      if (note.beat < -1e-6) {
        issues.push({
          kind: 'negativeBeat',
          cat: t('editor.checkCatNegative'),
          detail: `${t('editor.checkTypeNote')} ${note.id} · ${t('editor.beat')} ${note.beat.toFixed(2)}`,
          targetBeat: note.beat,
          targetId: note.id,
        });
      }
      const landing = landingOf(note.x, note.y, note.beat, note.layerId);
      if (landing.x < X_MIN - 1e-6 || landing.x > X_MAX + 1e-6 || landing.y < Y_MIN - 1e-6 || landing.y > Y_MAX + 1e-6) {
        issues.push({
          kind: 'coordRange',
          cat: t('editor.checkCatCoord'),
          detail: `${t('editor.checkTypeNote')} ${note.id} · x=${landing.x.toFixed(2)}, y=${landing.y.toFixed(2)}`,
          targetBeat: note.beat,
          targetId: note.id,
        });
      }
      if (note.nodes && note.nodes.length) {
        let prevBeat = note.beat;
        let prevLabel = t('editor.headNode');
        for (let i = 0; i < note.nodes.length; i++) {
          const sn = note.nodes[i];
          const nodeLabel = t('editor.nodeN', { n: i + 1 });
          // 子节点同样要查负拍与坐标越界（此前只查了时间倒序）。
          if (sn.beat < -1e-6) {
            issues.push({
              kind: 'negativeBeat',
              cat: t('editor.checkCatNegative'),
              detail: `${t('editor.checkTypeNote')} ${note.id} · ${nodeLabel} · ${t('editor.beat')} ${sn.beat.toFixed(2)}`,
              targetBeat: sn.beat,
              targetId: note.id,
            });
          }
          const snx = typeof sn.x === 'number' ? sn.x : note.x;
          const sny = typeof sn.y === 'number' ? sn.y : note.y;
          const snLanding = landingOf(snx, sny, sn.beat, note.layerId);
          if (snLanding.x < X_MIN - 1e-6 || snLanding.x > X_MAX + 1e-6 || snLanding.y < Y_MIN - 1e-6 || snLanding.y > Y_MAX + 1e-6) {
            issues.push({
              kind: 'coordRange',
              cat: t('editor.checkCatCoord'),
              detail: `${t('editor.checkTypeNote')} ${note.id} · ${nodeLabel} · x=${snLanding.x.toFixed(2)}, y=${snLanding.y.toFixed(2)}`,
              targetBeat: sn.beat,
              targetId: note.id,
            });
          }
          if (sn.beat < prevBeat - 1e-6) {
            issues.push({
              kind: 'chainOrder',
              cat: t('editor.checkCatChainOrder'),
              detail: `${t('editor.checkTypeNote')} ${note.id} · ${nodeLabel} (${t('editor.beat')} ${sn.beat.toFixed(2)}) < ${prevLabel} (${prevBeat.toFixed(2)})`,
              targetBeat: sn.beat,
              targetId: note.id,
            });
          }
          prevBeat = sn.beat;
          prevLabel = nodeLabel;
        }
      }
    }
    const events = chart.events ?? [];
    for (const evt of events) {
      if (evt.beat < -1e-6) {
        issues.push({
          kind: 'negativeBeat',
          cat: t('editor.checkCatNegative'),
          detail: `${t('editor.checkTypeEvent')} ${evt.id} · ${t('editor.beat')} ${evt.beat.toFixed(2)}`,
          targetBeat: evt.beat,
          isEvent: true,
        });
      }
    }
    // 音符触发器（§3.4）：变速/偏移已预先积分进滚动距离与落点，判定时刻无法再改变，
    // 这类动作运行时会被忽略 —— 提前告知作者，避免「写了却没反应」。
    const evtById: { [id: string]: EventData } = {};
    for (const e of chart.events ?? []) if (e.id) evtById[e.id] = e;
    for (const l of chart.layers ?? []) for (const e of l.events ?? []) if (e.id) evtById[e.id] = e;
    for (const note of chart.notes) {
      if (!note.trigger) continue;
      const acts: TriggerAction[] = [];
      for (const a of note.trigger.onMiss ?? []) acts.push(a);
      for (const k in note.trigger.onHit ?? {}) {
        for (const a of (note.trigger.onHit as any)[k] ?? []) acts.push(a);
      }
      for (const a of acts) {
        const target: any = typeof (a as any).ref === 'string' ? evtById[(a as any).ref] : a;
        if (!target || !isTriggerEventUnsupported(target)) continue;
        issues.push({
          kind: 'triggerUnsupported',
          cat: t('editor.checkCatTrigger'),
          detail: `${t('editor.checkTypeNote')} ${note.id} · ${t('editor.evt.speed')}/${t('editor.evt.offset')}`,
          targetBeat: note.beat,
          targetId: note.id,
        });
      }
    }

    // 背景色是**全局**的：写在非根图层的事件轴上虽然仍生效，但属于不良写法
    // （读者会误以为它只影响该图层）→ warning，建议移到根图层（设计 §2.2 / §4.4）。
    for (const lay of chart.layers ?? []) {
      if (!lay.parentId) continue;
      for (const evt of lay.events ?? []) {
        if (evt.eventType !== 'bg_change') continue;
        issues.push({
          kind: 'bgOnNonRootLayer',
          cat: t('editor.checkCatLayer'),
          detail: t('editor.checkBgNonRoot', { layer: lay.name || lay.id }),
          targetBeat: evt.beat,
          isEvent: true,
        });
      }
    }
    issues.sort((a, b) => a.targetBeat - b.targetBeat);
    setCheckIssues(issues);
    setCheckRan(true);
    setShowCheck(true);
  };

  const jumpToIssue = (issue: CheckIssue) => {
    onSeekBeat(issue.targetBeat);
    if (issue.targetId) onSelectNote(issue.targetId);
    // 跳转后保留问题列表，便于逐条核对（关闭由「关闭」按钮负责）。
  };

  // ----- 偏移变更的全量复检（设计 §4.4）-----
  //
  // 新增/修改/删除任一 `offset_change`，都会**追溯性**改变既有音符的落点
  // （base 不动，偏移变了 → 落点变了）。所以必须在事件变更后防抖重算一遍，
  // 把越界的音符列出来并提供两种修复：
  //   - 保持原显示位置：反算 base，让落点回到**变更前**的位置；
  //   - 夹取到边界内：改 base，让落点正好落在边界上。
  type LayerTreeT = ReturnType<typeof buildLayerTree>;
  interface OffsetIssue {
    /** 头节点 note.id（用于选中/跳转）。 */
    noteId: string;
    /** 0 = 头节点；≥1 = 第 n 个子节点。 */
    nodeIdx: number;
    beat: number;
    landing: { x: number; y: number };
    /** 「保持原显示位置」要写入的 base；无快照时为 null（按钮禁用）。 */
    keepBase: { x: number; y: number } | null;
    /** 「夹取到边界内」要写入的 base。 */
    clampBase: { x: number; y: number };
  }
  const [offsetIssues, setOffsetIssues] = useState<OffsetIssue[]>([]);
  const [showOffsetIssues, setShowOffsetIssues] = useState(false);
  // 变更前每个判定单位的落点快照：key = note.id 或 note.id#i。
  const offsetSnapshotRef = useRef<{ [key: string]: { x: number; y: number } }>({});
  const offsetRecheckTimerRef = useRef<number | null>(null);

  /** 音符（或 slide 子节点）在**自己时刻**的合成落点。 */
  const landingXY = (
    tree: LayerTreeT,
    c: ChartData,
    x: number,
    y: number,
    beat: number,
    layerId?: string
  ): { x: number; y: number } => {
    const t = beatToSecondsMultiBpm(beat, c.metadata.bpm, c.metadata.offset, c.metadata.bpmlist);
    const off = layerOffsetAt(tree, noteLayerIdx(tree, { layerId }), t);
    return { x: x + off.x, y: y + off.y };
  };

  /** 变更前快照：记录每个判定单位当前的落点。 */
  const snapshotLandings = () => {
    const c = chartRef.current;
    const tree = buildLayerTree(c);
    const snap: { [key: string]: { x: number; y: number } } = {};
    for (const n of c.notes) {
      snap[n.id] = landingXY(tree, c, n.x, n.y, n.beat, n.layerId);
      (n.nodes ?? []).forEach((sn, i) => {
        snap[`${n.id}#${i + 1}`] = landingXY(tree, c, sn.x, sn.y, sn.beat, n.layerId);
      });
    }
    offsetSnapshotRef.current = snap;
  };

  const runOffsetRecheck = () => {
    const c = chartRef.current;
    const tree = buildLayerTree(c);
    const snap = offsetSnapshotRef.current;
    const issues: OffsetIssue[] = [];
    const clamp01 = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const consider = (
      baseX: number, baseY: number, beat: number, layerId: string | undefined,
      noteId: string, nodeIdx: number, key: string
    ) => {
      const landing = landingXY(tree, c, baseX, baseY, beat, layerId);
      const cx = clamp01(landing.x, X_MIN, X_MAX);
      const cy = clamp01(landing.y, Y_MIN, Y_MAX);
      if (cx === landing.x && cy === landing.y) return;
      const t = beatToSecondsMultiBpm(beat, c.metadata.bpm, c.metadata.offset, c.metadata.bpmlist);
      const off = layerOffsetAt(tree, noteLayerIdx(tree, { layerId }), t);
      const prev = snap[key];
      issues.push({
        noteId,
        nodeIdx,
        beat,
        landing,
        keepBase: prev ? { x: prev.x - off.x, y: prev.y - off.y } : null,
        clampBase: { x: baseX + (cx - landing.x), y: baseY + (cy - landing.y) },
      });
    };
    for (const n of c.notes) {
      consider(n.x, n.y, n.beat, n.layerId, n.id, 0, n.id);
      (n.nodes ?? []).forEach((sn, i) => {
        consider(sn.x, sn.y, sn.beat, n.layerId, n.id, i + 1, `${n.id}#${i + 1}`);
      });
    }
    setOffsetIssues(issues);
    setShowOffsetIssues(issues.length > 0);
  };

  /** 偏移事件变更后调用：先快照（变更前的落点），再防抖复检。 */
  const scheduleOffsetRecheck = () => {
    snapshotLandings();
    if (offsetRecheckTimerRef.current !== null) window.clearTimeout(offsetRecheckTimerRef.current);
    offsetRecheckTimerRef.current = window.setTimeout(() => {
      offsetRecheckTimerRef.current = null;
      runOffsetRecheck();
    }, 350);
  };

  const applyOffsetFix = (issue: OffsetIssue, mode: 'keep' | 'clamp') => {
    const base = mode === 'keep' ? issue.keepBase : issue.clampBase;
    if (!base) return;
    const c = chartRef.current;
    const notes = c.notes.map((n) => {
      if (n.id !== issue.noteId) return n;
      if (issue.nodeIdx === 0) return { ...n, x: base.x, y: base.y };
      const nodes = (n.nodes ?? []).map((sn, i) =>
        i === issue.nodeIdx - 1 ? { ...sn, x: base.x, y: base.y } : sn
      );
      return { ...n, nodes };
    });
    onUpdateChart({ ...c, notes });
    // 修复后再次复检（快照保持为「变更前」，剩余项仍可继续修）。
    if (offsetRecheckTimerRef.current !== null) window.clearTimeout(offsetRecheckTimerRef.current);
    offsetRecheckTimerRef.current = window.setTimeout(() => {
      offsetRecheckTimerRef.current = null;
      runOffsetRecheck();
    }, 50);
  };

  useEffect(
    () => () => {
      if (offsetRecheckTimerRef.current !== null) window.clearTimeout(offsetRecheckTimerRef.current);
    },
    []
  );

  // Dragging State for Floating Quick Edit and Snapping Panels
  const [panelPos, setPanelPos] = useState({ x: 0, y: 0 });
  const [snappingPos, setSnappingPos] = useState({ x: 0, y: 0 });

  // 批量删除二次确认：第一次点击“删除”进入武装状态，第二次才真正删除。
  const [deleteArmed, setDeleteArmed] = useState(false);
  // 选中变化时自动解除删除确认状态。
  useEffect(() => { setDeleteArmed(false); }, [selectedNoteIds, isMultiSelect]);

  // 批量编辑“功能”下拉当前项：持久 state，多选集合变化（面板重新挂载）
  // 时仍保留上一次选择，不必每次重新设置。
  const [batchOp, setBatchOp] = useState<BatchOp>('ToTap');

  // 手动双击检测（iOS Safari 的 onDoubleClick 不可靠）：两次 click 间隔
  // <300ms 视为双击，用于切换多选模式。
  const lastSelectTapRef = useRef(0);
  const handleSelectToolClick = () => {
    const now = performance.now();
    if (now - lastSelectTapRef.current < 300) {
      lastSelectTapRef.current = 0;
      onToggleMultiSelect();
    } else {
      lastSelectTapRef.current = now;
      onSetActiveTool('select');
    }
  };

  const selectedBaseId = selectedNoteId ? selectedNoteId.split('#')[0] : null;
  // O(n)：仅在 chart / 选中项变化时重算（预览播放不再每帧触发重渲染）。
  const selectedNote = useMemo(
    () => chart.notes.find((n) => n.id === selectedBaseId),
    [chart.notes, selectedBaseId]
  );

  // Live-drag override: while a note is being dragged (in 2D or 3D) the canvas
  // pushes the current position here every frame so these input boxes show the
  // real-time value without waiting for the throttled/on-release chart commit.
  // Subscribing only re-renders this panel — App and the canvases stay untouched.
  const liveDrag = useLiveDrag();

  // O(n) 全谱遍历：仅在 chart 变化时重算。
  const chartMaxBeat = useMemo(() => getMaxBeat(chart), [chart]);
  const maxBeat = useMemo(() => Math.max(16, chartMaxBeat) + 4, [chartMaxBeat]);
  const playableCount = useMemo(() => countPlayableNotes(chart), [chart]);

  const validBatchRange =
    batchSelection.startBeat !== null && batchSelection.endBeat !== null
      ? {
          start: Math.min(batchSelection.startBeat, batchSelection.endBeat),
          end: Math.max(batchSelection.startBeat, batchSelection.endBeat),
        }
      : null;

  // O(n)：依赖用原始值（validBatchRange 每次渲染都是新对象，不能作为 useMemo 依赖）。
  const notesInBatch = useMemo(() => {
    if (batchSelection.startBeat === null || batchSelection.endBeat === null) return [];
    const lo = Math.min(batchSelection.startBeat, batchSelection.endBeat) - 0.001;
    const hi = Math.max(batchSelection.startBeat, batchSelection.endBeat) + 0.001;
    return chart.notes.filter((n) => n.beat >= lo && n.beat <= hi);
  }, [chart.notes, batchSelection.startBeat, batchSelection.endBeat]);

  const handleUpdateMeta = (field: 'bpm' | 'offset', value: number) => {
    onUpdateChart({ ...chart, metadata: { ...chart.metadata, [field]: value } });
  };

  // ---- BPM List Editing Helpers ----
  const getBpmList = (): BpmPoint[] => chart.metadata.bpmlist ?? [];

  const handleAddBpmPoint = () => {
    const snappedBeat = Math.round(editorTimeStore.getSnapshot().beat / snapSubdivision) * snapSubdivision;
    if (snappedBeat <= 0) return;
    const currentBpm = getBpmAtBeatLocal(snappedBeat);
    const newPoint: BpmPoint = { beat: snappedBeat, bpm: currentBpm };
    const bpmlist = [...getBpmList(), newPoint].sort((a, b) => a.beat - b.beat);
    onUpdateChart({ ...chart, metadata: { ...chart.metadata, bpmlist } });
  };

  const handleUpdateBpmPoint = (idx: number, updates: Partial<BpmPoint>) => {
    const bpmlist = getBpmList()
      .map((p, i) => (i === idx ? { ...p, ...updates } : p))
      .sort((a, b) => a.beat - b.beat)
      .filter((p) => p.beat > 0);
    onUpdateChart({ ...chart, metadata: { ...chart.metadata, bpmlist: bpmlist.length > 0 ? bpmlist : undefined } });
  };

  const handleDeleteBpmPoint = (idx: number) => {
    const bpmlist = getBpmList().filter((_, i) => i !== idx);
    onUpdateChart({ ...chart, metadata: { ...chart.metadata, bpmlist: bpmlist.length > 0 ? bpmlist : undefined } });
  };

  const getBpmAtBeatLocal = (beat: number): number => {
    const bpmlist = getBpmList();
    if (bpmlist.length === 0) return chart.metadata.bpm;
    let bpm = chart.metadata.bpm;
    for (const p of bpmlist) {
      if (p.beat > beat) break;
      bpm = p.bpm;
    }
    return bpm;
  };

  // ---- 图层（Layer）Editing Helpers ----
  const layerList: LayerData[] = chart.layers ?? [];
  const layerNoteCount = (id: string) => chart.notes.filter((n) => (n.layerId ?? '') === id).length;

  const setLayers = (layers: LayerData[]) =>
    onUpdateChart({ ...chart, layers: layers.length > 0 ? layers : undefined });

  const handleAddLayer = (asChild: boolean) => {
    const id = `lyr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const name = `${t('editor.layer.newName')} ${layerList.length + 1}`;
    // 仅当当前隔离的是显式图层时才作为其子图层；总览/默认根 → 新建根图层。
    const parent = asChild && editorLayerId ? editorLayerId : undefined;
    setLayers([...layerList, parent ? { id, parentId: parent, name } : { id, name }]);
    onEditorLayerChange(id);
  };

  const handleDeleteLayer = (id: string) => {
    if (!window.confirm(t('editor.layer.confirmDelete'))) return;
    // 级联删除：收集该图层及其全部后代；其中的音符一并删除。
    const doomed = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const l of layerList) {
        if (l.parentId && doomed.has(l.parentId) && !doomed.has(l.id)) {
          doomed.add(l.id);
          grew = true;
        }
      }
    }
    const next = layerList.filter((l) => !doomed.has(l.id));
    onUpdateChart({
      ...chart,
      layers: next.length > 0 ? next : undefined,
      notes: chart.notes.filter((n) => !n.layerId || !doomed.has(n.layerId)),
    });
    if (editorLayerId && doomed.has(editorLayerId)) onEditorLayerChange(null);
  };

  const handleRenameLayer = (id: string) => {
    const cur = layerList.find((l) => l.id === id)?.name ?? '';
    const name = window.prompt(t('editor.layer.renamePrompt'), cur);
    if (name === null) return;
    const trimmed = name.trim();
    setLayers(layerList.map((l) => (l.id === id ? { ...l, name: trimmed || l.name } : l)));
  };

  // 图层树行（根 → 子，带缩进）。根 = 无 parentId；悬挂/循环引用已由解析层修复。
  const layerTreeRows: Array<{ l: LayerData; depth: number }> = [];
  {
    const byParent = new Map<string | undefined, LayerData[]>();
    for (const l of layerList) {
      const key = l.parentId || undefined;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(l);
    }
    const walk = (parent: string | undefined, depth: number) => {
      for (const l of byParent.get(parent) ?? []) {
        layerTreeRows.push({ l, depth });
        walk(l.id, depth + 1);
      }
    };
    walk(undefined, 0);
  }

  // ---- Event Editing Helpers ----
  // 事件容器：默认根图层的时间轴 = 顶层 events（旧格式）；显式图层 = layers[i].events。
  // 事件面板显示全部容器合并后的列表；增删改按 id 在所有容器中定位。
  // 事件容器：总览与默认根图层都视为「默认根」= 顶层 events（旧格式）；
  // 选中显式图层 = 该图层的 events。事件面板只显示当前容器（不合并、不加标签）。
  const eventTargetLayerId = editorLayerId ?? '';
  const eventTargetName =
    eventTargetLayerId === ''
      ? t('editor.layer.defaultRoot')
      : layerList.find((l) => l.id === eventTargetLayerId)?.name || eventTargetLayerId;

  /** 当前图层时间轴的事件。 */
  const getEvents = (): EventData[] => {
    if (eventTargetLayerId === '') return chart.events ?? [];
    return layerList.find((l) => l.id === eventTargetLayerId)?.events ?? [];
  };

  const handleAddEvent = (type: EventType) => {
    // 偏移事件：先快照「变更前落点」，再在变更生效后防抖全量复检（§4.4）。
    if (type === 'offset_change') scheduleOffsetRecheck();
    const snappedBeat = Math.round(editorTimeStore.getSnapshot().beat / snapSubdivision) * snapSubdivision;
    const newEvent: EventData = {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'event',
      eventType: type,
      beat: snappedBeat,
      ...(type === 'speed_change' ? { speed: 1.0 } : {}),
      ...(type === 'text_display' ? { text: 'New Text', textDuration: 2 } : {}),
      ...(type === 'note_color_change' ? { noteColor: '#00f0ff' } : {}),
      ...(type === 'bg_change' ? { gradientStart: '#050c1e', gradientEnd: '#1b072c' } : {}),
      ...(type === 'offset_change' ? { offsetX: 0, offsetY: 0, duration: 0, easing: 'linear' } : {}),
    };
    // 默认根图层（或目标图层已不存在）→ 顶层 events；显式图层 → 该图层的 events。
    const targetIsLayer =
      eventTargetLayerId !== '' && layerList.some((l) => l.id === eventTargetLayerId);
    if (!targetIsLayer) {
      const events = [...(chart.events ?? []), newEvent].sort((a, b) => a.beat - b.beat);
      onUpdateChart({ ...chart, events });
      return;
    }
    const layers = layerList.map((l) =>
      l.id === eventTargetLayerId
        ? { ...l, events: [...(l.events ?? []), newEvent].sort((a, b) => a.beat - b.beat) }
        : l
    );
    onUpdateChart({ ...chart, layers });
  };

  const handleUpdateEvent = (id: string, updates: Partial<EventData>) => {
    const prevEvt = getEvents().find((e) => e.id === id);
    if (prevEvt?.eventType === 'offset_change' || updates.eventType === 'offset_change') {
      scheduleOffsetRecheck();
    }
    let topHit = false;
    let nextTop = chart.events;
    if (nextTop?.some((e) => e.id === id)) {
      topHit = true;
      nextTop = nextTop
        .map((e) => (e.id === id ? { ...e, ...updates } : e))
        .sort((a, b) => a.beat - b.beat);
    }
    let layerHit = false;
    const nextLayers = layerList.map((l) => {
      if (!l.events?.some((e) => e.id === id)) return l;
      layerHit = true;
      return {
        ...l,
        events: l.events
          .map((e) => (e.id === id ? { ...e, ...updates } : e))
          .sort((a, b) => a.beat - b.beat),
      };
    });
    if (!topHit && !layerHit) return;
    const updated: ChartData = { ...chart };
    if (topHit) updated.events = nextTop;
    if (layerHit) updated.layers = nextLayers;
    onUpdateChart(updated);
  };

  const handleDeleteEvent = (id: string) => {
    if (getEvents().find((e) => e.id === id)?.eventType === 'offset_change') {
      scheduleOffsetRecheck();
    }
    let topHit = false;
    const topEvents = chart.events ?? [];
    const nextTop = topEvents.filter((e) => e.id !== id);
    if (nextTop.length !== topEvents.length) topHit = true;
    let layerHit = false;
    const nextLayers = layerList.map((l) => {
      if (!l.events?.some((e) => e.id === id)) return l;
      layerHit = true;
      const ne = l.events.filter((e) => e.id !== id);
      return { ...l, events: ne.length > 0 ? ne : undefined };
    });
    if (!topHit && !layerHit) return;
    const updated: ChartData = { ...chart };
    /* ⚠️ 删最后一个事件时不能用 `delete updated.events`：上层 onUpdateChart 是
       `{ ...prev, ...updated }` 的浅合并 —— **缺键等于不覆盖**，旧数组会原样留着，
       表现为"最后一个事件删不掉"。必须显式写成 undefined 才会被覆盖
       （与图层内事件的写法一致；undefined 在序列化时会被丢弃，符合可选字段语义）。 */
    if (topHit) updated.events = nextTop.length > 0 ? nextTop : undefined;
    if (layerHit) updated.layers = nextLayers;
    onUpdateChart(updated);
  };

  // 起点/终点按谱师点击的顺序原样保留，不做数值调转（否则谱师先点终点再点起点时，
  // 界面上的起/终点会被偷偷对调，容易困惑）。实际操作区间由 validBatchRange 用
  // Math.min/max 归一化，所以 start>end 时仍按 [end,start] 执行。
  const handleSetBatchStart = () => {
    const newStart = Math.round(editorTimeStore.getSnapshot().beat * 100) / 100;
    onSetBatchSelection({ startBeat: newStart, endBeat: batchSelection.endBeat });
  };

  const handleSetBatchEnd = () => {
    const newEnd = Math.round(editorTimeStore.getSnapshot().beat * 100) / 100;
    onSetBatchSelection({ startBeat: batchSelection.startBeat, endBeat: newEnd });
  };

  const handleBatchClone = () => {
    if (!validBatchRange || notesInBatch.length === 0) return;
    const deltaBeat = editorTimeStore.getSnapshot().beat - validBatchRange.start;

    const clonedNotes: NoteData[] = notesInBatch.map((n, idx) => ({
      ...n,
      id: `clone-${Date.now().toString().slice(-4)}-${idx}`,
      beat: Math.round((n.beat + deltaBeat) * 1000) / 1000,
      nodes: n.nodes?.map((sn) => ({ ...sn, beat: Math.round((sn.beat + deltaBeat) * 1000) / 1000 })),
    }));

    const updatedNotes = [...chart.notes, ...clonedNotes].sort((a, b) => a.beat - b.beat);
    onUpdateChart({ ...chart, notes: updatedNotes });
  };

  const handleBatchDelete = () => {
    if (!validBatchRange) return;
    const remaining = chart.notes.filter(
      (n) => n.beat < validBatchRange.start - 0.001 || n.beat > validBatchRange.end + 0.001
    );
    onUpdateChart({ ...chart, notes: remaining });
    onSetBatchSelection({ startBeat: null, endBeat: null });
    setConfirmBatchDelete(false);
    onSelectNote(null);
  };

  const handleBatchFlipX = () => {
    if (!validBatchRange || notesInBatch.length === 0) return;
    const flipIds = new Set(notesInBatch.map((n) => n.id));
    const updatedNotes = chart.notes.map((n) =>
      flipIds.has(n.id)
        ? { ...n, x: -n.x, nodes: n.nodes?.map((sn) => ({ ...sn, x: -sn.x })) }
        : n
    );
    onUpdateChart({ ...chart, notes: updatedNotes });
  };

  const handleBatchFlipY = () => {
    if (!validBatchRange || notesInBatch.length === 0) return;
    const flipIds = new Set(notesInBatch.map((n) => n.id));
    const updatedNotes = chart.notes.map((n) =>
      flipIds.has(n.id)
        ? { ...n, y: -n.y, nodes: n.nodes?.map((sn) => ({ ...sn, y: -sn.y })) }
        : n
    );
    onUpdateChart({ ...chart, notes: updatedNotes });
  };

  // 对区间内所有音符应用放置规则 DSL：头节点完整应用；子节点应用位置类字段
  // （beat/x/y/angle/easing，color 子节点无字段自动忽略）。
  const handleBatchApplyRule = () => {
    if (!validBatchRange || notesInBatch.length === 0) return;
    const dsl = editorDsl;
    const ruleIds = new Set(notesInBatch.map((n) => n.id));
    // DSL 出口的 ±2.4/±1.5 裁剪必须针对**显示坐标**：按每个单位自己的 beat 取偏移传入。
    const dslTree = buildLayerTree(chart);
    const dslMeta = chart.metadata;
    const offAt = (n: NoteData, beat: number) =>
      layerOffsetAt(
        dslTree,
        noteLayerIdx(dslTree, n),
        beatToSecondsMultiBpm(beat, dslMeta.bpm, dslMeta.offset, dslMeta.bpmlist)
      );
    const updatedNotes = chart.notes.map((n) => {
      if (!ruleIds.has(n.id)) return n;
      const applied = applyDslToNote(n, dsl, offAt(n, n.beat));
      if (!n.nodes || n.nodes.length === 0) return applied;
      // 子节点逐个应用 DSL（以自身位置 + 头节点缺省参数构造临时 note）。
      const nodes = n.nodes.map((sn) => {
        const tmp = applyDslToNote(
          { ...applied, beat: sn.beat, x: sn.x, y: sn.y, angle: sn.angle ?? applied.angle, easing: sn.easing ?? applied.easing, nodes: undefined },
          dsl,
          offAt(n, sn.beat),
        );
        const out: SlideNodeData = {
          beat: tmp.beat,
          x: tmp.x,
          y: tmp.y,
        };
        if (tmp.angle != null) out.angle = tmp.angle;
        if (tmp.easing != null) out.easing = tmp.easing;
        return out;
      });
      return { ...applied, nodes };
    });
    onUpdateChart({ ...chart, notes: updatedNotes });
  };

  // ---- 批量编辑弹窗功能实现 ----
  // 多选集合可包含头节点 id（"id"）与子节点 id（"id#i"）。批量操作按“单位”执行：
  // 每个被选中的头节点或子节点都视为一个独立 note（子节点的缺省参数继承自其头节点）。
  type SelUnit = {
    /** 精确 id（头节点 id 或 "id#i"）。 */
    id: string;
    isChild: boolean;
    beat: number;
    x: number;
    y: number;
    type: NoteType;
    /** 子节点继承自头节点的颜色。 */
    color?: string;
    /** 子节点自身角度或继承头节点角度。 */
    angle?: number;
    /** 子节点自身缓动或继承头节点缓动。 */
    easing?: EasingType;
    /** 所属链头节点 id。 */
    headId: string;
    /** 子节点 1 基序号（仅子节点有）。 */
    childIndex?: number;
  };

  // 将多选集合解析为排序后的“单位”列表。
  const selectedUnits: SelUnit[] = (() => {
    const selSet = new Set(selectedNoteIds);
    const units: SelUnit[] = [];
    for (const n of chart.notes) {
      const color = n.color;
      if (selSet.has(n.id)) {
        units.push({ id: n.id, isChild: false, beat: n.beat, x: n.x, y: n.y, type: n.type, color, angle: n.angle, easing: n.easing, headId: n.id });
      }
      if (n.nodes) {
        n.nodes.forEach((nd, i) => {
          const cid = `${n.id}#${i + 1}`;
          if (selSet.has(cid)) {
            units.push({
              id: cid, isChild: true, beat: nd.beat, x: nd.x, y: nd.y, type: n.type,
              color, angle: nd.angle ?? n.angle, easing: nd.easing ?? n.easing,
              headId: n.id, childIndex: i + 1,
            });
          }
        });
      }
    }
    return units.sort((a, b) => a.beat - b.beat);
  })();

  // 批量编辑弹窗显示条件：多选模式（含 Ctrl 临时）下选中 ≥1；或不论模式选中 ≥2。
  // （修改要求：多选模式下选中单个也弹出批量编辑框。）
  const batchEditActive = (isMultiSelect && selectedUnits.length >= 1) || selectedUnits.length >= 2;

  /** 对多选集合执行批量操作。全部一次性走 onUpdateChart 提交。
   *  语义：按“单位”执行——每个被选中的头节点或子节点都是一个独立 note。 */
  const applyBatchOp = (op: BatchOp) => {
    if (selectedUnits.length < 1) return;
    // 精确 id 集合（头节点 id 或 "id#i"）。
    const selIds = new Set(selectedNoteIds);
    // 填充步进：跟随吸附设置；“自由”（吸附值 0.01）视为 1/16。
    // “自由”是吸附下拉中的哨兵值，其数值 0.01 是编辑用的最小步长，并非用户想要的实际填充间隔。
    const SNAP_FREE = 0.01;
    const snap = Math.abs(snapSubdivision - SNAP_FREE) < 0.00001 || snapSubdivision <= 0 ? 1 / 16 : snapSubdivision;

    // ---- 克隆（Clone）：把选中的单位克隆一份到当前时间点 ----
    // 选中单位中时间最早的作为 0 时刻：克隆体 beat = currentBeat + (原 beat - 最早 beat)。
    // 子节点处理与类型转换类似：按“选中/未选中”拆连续段，选中段整体克隆为新链，
    // 保持段内相邻连接；克隆出的新头节点缺省参数继承自原头节点。
    if (op === 'Clone') {
      const baseBeat = selectedUnits[0].beat; // 最早选中单位的 beat
      const dBeat = editorTimeStore.getSnapshot().beat - baseBeat;
      const affectedChains = new Set<string>();
      for (const id of selIds) affectedChains.add(id.indexOf('#') >= 0 ? id.split('#')[0] : id);

      const cloneChain = (head: NoteData): NoteData[] => {
        const units: Array<{ id: string; beat: number; x: number; y: number; angle?: number; easing?: EasingType; selected: boolean }> = [
          { id: head.id, beat: head.beat, x: head.x, y: head.y, angle: head.angle, easing: head.easing, selected: selIds.has(head.id) },
          ...(head.nodes ?? []).map((nd, i) => ({
            id: `${head.id}#${i + 1}`, beat: nd.beat, x: nd.x, y: nd.y, angle: nd.angle, easing: nd.easing, selected: selIds.has(`${head.id}#${i + 1}`),
          })),
        ];
        const runs: Array<typeof units> = [];
        for (const u of units) {
          const last = runs[runs.length - 1];
          if (last && last[0].selected === u.selected) last.push(u);
          else runs.push([u]);
        }
        const out: NoteData[] = [];
        for (const run of runs) {
          if (run.length === 0 || !run[0].selected) continue;
          const first = run[0];
          const note: NoteData = {
            id: `clone-${Math.random().toString(36).slice(2, 10)}`,
            beat: first.beat + dBeat,
            x: first.x,
            y: first.y,
            type: head.type,
            ...(head.color != null ? { color: head.color } : {}),
            ...((first.angle ?? head.angle) != null ? { angle: first.angle ?? head.angle } : {}),
            ...((first.easing ?? head.easing) != null ? { easing: first.easing ?? head.easing } : {}),
          };
          const children = run.slice(1).map((u) => ({
            beat: u.beat + dBeat,
            x: u.x,
            y: u.y,
            ...(u.angle != null ? { angle: u.angle } : {}),
            ...(u.easing != null ? { easing: u.easing } : {}),
          }));
          if (children.length > 0) note.nodes = children;
          out.push(note);
        }
        return out;
      };

      const cloned: NoteData[] = [];
      for (const n of chart.notes) {
        if (affectedChains.has(n.id)) cloned.push(...cloneChain(n));
      }
      if (cloned.length === 0) return;
      const updatedNotes = [...chart.notes, ...cloned].sort((a, b) => a.beat - b.beat);
      onUpdateChart({ ...chart, notes: updatedNotes });
      // 克隆后保持克隆源选中（克隆体不选入，便于连续克隆调整）。
      onSelectNotes(selectedNoteIds);
      return;
    }

    // ---- 删除（Delete）：删除选中的单位 ----
    // 子节点处理与类型转换类似：按“选中/未选中”拆连续段，选中段整体删除；
    // 剩下的有相邻则连，被断开产生的新链头（原为子节点）缺省参数继承自原头节点。
    // 二次确认由 UI（deleteArmed）负责，这里直接执行。
    if (op === 'Delete') {
      const affectedChains = new Set<string>();
      for (const id of selIds) affectedChains.add(id.indexOf('#') >= 0 ? id.split('#')[0] : id);

      const deleteFromChain = (head: NoteData): NoteData[] => {
        const units: Array<{ id: string; beat: number; x: number; y: number; angle?: number; easing?: EasingType; selected: boolean }> = [
          { id: head.id, beat: head.beat, x: head.x, y: head.y, angle: head.angle, easing: head.easing, selected: selIds.has(head.id) },
          ...(head.nodes ?? []).map((nd, i) => ({
            id: `${head.id}#${i + 1}`, beat: nd.beat, x: nd.x, y: nd.y, angle: nd.angle, easing: nd.easing, selected: selIds.has(`${head.id}#${i + 1}`),
          })),
        ];
        const runs: Array<typeof units> = [];
        for (const u of units) {
          const last = runs[runs.length - 1];
          if (last && last[0].selected === u.selected) last.push(u);
          else runs.push([u]);
        }
        const out: NoteData[] = [];
        for (const run of runs) {
          if (run.length === 0 || run[0].selected) continue; // 选中段删除
          const first = run[0];
          const isOriginalHead = first.id === head.id;
          const note: NoteData = {
            id: isOriginalHead ? head.id : `${head.id}-${Math.random().toString(36).slice(2, 8)}`,
            beat: first.beat,
            x: first.x,
            y: first.y,
            type: head.type,
            ...(head.color != null ? { color: head.color } : {}),
            ...((first.angle ?? head.angle) != null ? { angle: first.angle ?? head.angle } : {}),
            ...((first.easing ?? head.easing) != null ? { easing: first.easing ?? head.easing } : {}),
          };
          const children = run.slice(1).map((u) => ({
            beat: u.beat,
            x: u.x,
            y: u.y,
            ...(u.angle != null ? { angle: u.angle } : {}),
            ...(u.easing != null ? { easing: u.easing } : {}),
          }));
          if (children.length > 0) note.nodes = children;
          out.push(note);
        }
        return out;
      };

      const updatedNotes: NoteData[] = [];
      for (const n of chart.notes) {
        if (affectedChains.has(n.id)) updatedNotes.push(...deleteFromChain(n));
        else updatedNotes.push(n);
      }
      updatedNotes.sort((a, b) => a.beat - b.beat);
      onUpdateChart({ ...chart, notes: updatedNotes });
      onSelectNotes(null);
      return;
    }

    // ---- 类型转换（ToTap / ToTouch / ToSlide）：仅改动选中的节点 ----
    // 把一条链按“选中/未选中”拆成连续段：选中段转换为新类型并保持相邻连接；
    // 断开处前后拆开，剩下的有相邻则连；被断开产生的新链头（原为子节点）
    // 缺省参数（color/angle/easing）继承自原头节点。
    if (op === 'ToTap' || op === 'ToTouch' || op === 'ToSlide') {
      const nt: NoteType = op === 'ToTap' ? 'tap' : op === 'ToTouch' ? 'touch' : 'slide';
      const affectedChains = new Set<string>();
      for (const id of selIds) affectedChains.add(id.indexOf('#') >= 0 ? id.split('#')[0] : id);

      const convertChain = (head: NoteData): NoteData[] => {
        // 目标类型与链当前类型相同 → 无需转换，整条链原样保留，不做拆分。
        if (nt === head.type) return [head];
        const units: Array<{ id: string; beat: number; x: number; y: number; angle?: number; easing?: EasingType; selected: boolean }> = [
          { id: head.id, beat: head.beat, x: head.x, y: head.y, angle: head.angle, easing: head.easing, selected: selIds.has(head.id) },
          ...(head.nodes ?? []).map((nd, i) => ({
            id: `${head.id}#${i + 1}`, beat: nd.beat, x: nd.x, y: nd.y, angle: nd.angle, easing: nd.easing, selected: selIds.has(`${head.id}#${i + 1}`),
          })),
        ];
        const runs: Array<typeof units> = [];
        for (const u of units) {
          const last = runs[runs.length - 1];
          if (last && last[0].selected === u.selected) last.push(u);
          else runs.push([u]);
        }
        const out: NoteData[] = [];
        for (const run of runs) {
          if (run.length === 0) continue;
          const first = run[0];
          const isOriginalHead = first.id === head.id;
          const type = run[0].selected ? nt : head.type;
          // 拆分出的新链头使用随机唯一 id，避免与历史拆分结果重复。
          const nid = isOriginalHead ? head.id : `${head.id}-${Math.random().toString(36).slice(2, 8)}`;
          const note: NoteData = {
            id: nid,
            beat: first.beat,
            x: first.x,
            y: first.y,
            type,
            ...(head.color != null ? { color: head.color } : {}),
            ...((first.angle ?? head.angle) != null ? { angle: first.angle ?? head.angle } : {}),
            ...((first.easing ?? head.easing) != null ? { easing: first.easing ?? head.easing } : {}),
          };
          const children = run.slice(1).map((u) => ({
            beat: u.beat,
            x: u.x,
            y: u.y,
            ...(u.angle != null ? { angle: u.angle } : {}),
            ...(u.easing != null ? { easing: u.easing } : {}),
          }));
          if (children.length > 0) note.nodes = children;
          out.push(note);
        }
        return out;
      };

      const updatedNotes: NoteData[] = [];
      for (const n of chart.notes) {
        if (affectedChains.has(n.id)) updatedNotes.push(...convertChain(n));
        else updatedNotes.push(n);
      }
      updatedNotes.sort((a, b) => a.beat - b.beat);
      onUpdateChart({ ...chart, notes: updatedNotes });
      // 结构已变，清空多选避免残留失效 id。
      onSelectNotes(null);
      return;
    }

    // ---- MkChain：把选中的单位按 beat 桥接成一条链（全部同一 type 才生效）----
    // 本质是“桥接/拼接”：将选中的节点按时间排序串成一条链。
    //  - 选中节点排序 s0..sn。
    //  - s0 的原前驱链段（s0 之前未选中的连续节点）保留为新链头部。
    //  - sn 的原后继链段（sn 之后未选中的连续节点）保留为新链尾部。
    //  - s0..sn 之间逐一建立连接。
    //  - 被绕过的节点（s0 之后、sn 之前，以及各选中节点的旧相邻节点）断开，
    //    按原链连续段自成链。
    // 例：ACE(A→C→E) + BDF(B→D→F)，选 C、D → A-C-D-F，B、E 独立。
    if (op === 'MkChain') {
      const types = new Set(selectedUnits.map((u) => u.type));
      if (types.size !== 1 || selectedUnits.length < 2) return;
      const sorted = [...selectedUnits].sort((a, b) => a.beat - b.beat);
      const s0 = sorted[0];
      const sn = sorted[sorted.length - 1];

      // 链节点序列（id/beat/x/y/angle/easing）。
      type ChainU = { id: string; beat: number; x: number; y: number; angle?: number; easing?: EasingType };
      const chainUnits = (head: NoteData): ChainU[] => [
        { id: head.id, beat: head.beat, x: head.x, y: head.y, angle: head.angle, easing: head.easing },
        ...(head.nodes ?? []).map((nd, i) => ({
          id: `${head.id}#${i + 1}`, beat: nd.beat, x: nd.x, y: nd.y, angle: nd.angle, easing: nd.easing,
        })),
      ];
      const toNode = (u: ChainU): SlideNodeData => ({
        beat: u.beat,
        x: u.x,
        y: u.y,
        ...(u.angle != null ? { angle: u.angle } : {}),
        ...(u.easing != null ? { easing: u.easing } : {}),
      });

      // s0 的前缀链段：s0 所在链中位于 s0 之前的连续未选中节点。
      const s0Head = chart.notes.find((n) => n.id === s0.headId)!;
      const s0Chain = chainUnits(s0Head);
      const s0Idx = s0Chain.findIndex((u) => u.id === s0.id);
      const prefix = s0Idx > 0 ? s0Chain.slice(0, s0Idx) : [];
      // sn 的后缀链段：sn 所在链中位于 sn 之后的连续未选中节点。
      const snHead = chart.notes.find((n) => n.id === sn.headId)!;
      const snChain = chainUnits(snHead);
      const snIdx = snChain.findIndex((u) => u.id === sn.id);
      const suffix = snIdx >= 0 && snIdx < snChain.length - 1 ? snChain.slice(snIdx + 1) : [];

      // 主链头：有前缀段则沿用其首节点（保持原 id）；否则为 s0。
      const headFromPrefix = prefix.length > 0;
      const headId = headFromPrefix
        ? prefix[0].id
        : (s0.isChild ? `${s0.headId}-${Math.random().toString(36).slice(2, 8)}` : s0.id);
      const headUnit = headFromPrefix ? prefix[0] : s0;
      const children: SlideNodeData[] = [
        ...(headFromPrefix ? prefix.slice(1) : []),
        ...(headFromPrefix ? sorted : sorted.slice(1)).map((u) => ({
          beat: u.beat,
          x: u.x,
          y: u.y,
          ...(u.angle != null ? { angle: u.angle } : {}),
          ...(u.easing != null ? { easing: u.easing } : {}),
        })),
        ...suffix,
      ];
      const newHead: NoteData = {
        id: headId,
        beat: headUnit.beat,
        x: headUnit.x,
        y: headUnit.y,
        type: s0.type,
        // 颜色/角度/缓动缺省参数继承自 s0 所在链头。
        ...(s0Head.color != null ? { color: s0Head.color } : {}),
        ...((headUnit.angle ?? s0Head.angle) != null ? { angle: headUnit.angle ?? s0Head.angle } : {}),
        ...((headUnit.easing ?? s0Head.easing) != null ? { easing: headUnit.easing ?? s0Head.easing } : {}),
        ...(children.length > 0 ? { nodes: children } : {}),
      };

      // 受影响链重建：移除所有选中节点 + 已进主链的前缀/后缀节点，
      // 其余未选中节点按原链连续段成链（被绕过的 B、E 各自独立）。
      const affectedHeads = new Set(selectedUnits.map((u) => u.headId));
      const takenIds = new Set<string>([
        ...sorted.map((u) => u.id),
        ...prefix.map((u) => u.id),
        ...suffix.map((u) => u.id),
      ]);
      const updatedNotes: NoteData[] = [];
      for (const n of chart.notes) {
        if (!affectedHeads.has(n.id)) { updatedNotes.push(n); continue; }
        const units = chainUnits(n).map((u) => ({ ...u, taken: takenIds.has(u.id) }));
        // 整条链都被取走 → 无残留。
        if (units.every((u) => u.taken)) continue;
        // 连续未取走段成链。
        const runs: Array<Array<ChainU & { taken: boolean }>> = [];
        let cur: Array<ChainU & { taken: boolean }> = [];
        for (const u of units) {
          if (u.taken) { if (cur.length) { runs.push(cur); cur = []; } }
          else cur.push(u);
        }
        if (cur.length) runs.push(cur);
        for (const run of runs) {
          const first = run[0];
          const isOrigHead = first.id === n.id;
          const note: NoteData = {
            id: isOrigHead ? n.id : `${n.id}-${Math.random().toString(36).slice(2, 8)}`,
            beat: first.beat,
            x: first.x,
            y: first.y,
            type: n.type,
            ...(n.color != null ? { color: n.color } : {}),
            ...((first.angle ?? n.angle) != null ? { angle: first.angle ?? n.angle } : {}),
            ...((first.easing ?? n.easing) != null ? { easing: first.easing ?? n.easing } : {}),
          };
          const children = run.slice(1).map((u) => toNode(u));
          if (children.length > 0) note.nodes = children;
          updatedNotes.push(note);
        }
      }
      updatedNotes.push(newHead);
      updatedNotes.sort((a, b) => a.beat - b.beat);
      onUpdateChart({ ...chart, notes: updatedNotes });
      onSelectNotes([newHead.id]);
      return;
    }

    // ---- 拆散链（SplitChain）：断开选中节点对之间的连接 ----
    // 语义：只断开“选中的相邻节点对”之间的连接，其余连接保留。
    // 必须选中链中至少两个连接的相邻节点才有效；整链断开需选全链
    // （每个相邻对都选中 → 全部连接断开 → 所有节点独立）。
    // 例：链 H-C1-C2-C3，选 C1、C2 → 只断 C1-C2 → [H-C1] 与 [C2-C3] 两条链。
    if (op === 'SplitChain') {
      const affectedChains = new Set<string>();
      for (const id of selIds) affectedChains.add(id.indexOf('#') >= 0 ? id.split('#')[0] : id);
      // 只处理含 ≥1 个“相邻选中对”的链（即至少一处连接被断开）。
      const validChains = new Set<string>();
      for (const chainId of affectedChains) {
        const head = chart.notes.find((n) => n.id === chainId);
        if (!head) continue;
        const selectedMask = [
          selIds.has(head.id),
          ...(head.nodes ?? []).map((_, i) => selIds.has(`${head.id}#${i + 1}`)),
        ];
        let hasCut = false;
        for (let i = 1; i < selectedMask.length; i++) {
          if (selectedMask[i - 1] && selectedMask[i]) { hasCut = true; break; }
        }
        if (hasCut) validChains.add(chainId);
      }
      if (validChains.size === 0) return;

      const splitChain = (head: NoteData): NoteData[] => {
        const units: Array<{ id: string; beat: number; x: number; y: number; angle?: number; easing?: EasingType; selected: boolean }> = [
          { id: head.id, beat: head.beat, x: head.x, y: head.y, angle: head.angle, easing: head.easing, selected: selIds.has(head.id) },
          ...(head.nodes ?? []).map((nd, i) => ({
            id: `${head.id}#${i + 1}`, beat: nd.beat, x: nd.x, y: nd.y, angle: nd.angle, easing: nd.easing, selected: selIds.has(`${head.id}#${i + 1}`),
          })),
        ];
        // 断点集合：在单位 i 与 i+1 之间断开，当且仅当两者都选中。
        const cutAfter = new Set<number>();
        for (let i = 0; i < units.length - 1; i++) {
          if (units[i].selected && units[i + 1].selected) cutAfter.add(i);
        }
        // 按断点把链切成连续段，每段保留为一条链（单节点段为独立 note）。
        const runs: Array<typeof units> = [];
        let cur: typeof units = [];
        for (let i = 0; i < units.length; i++) {
          cur.push(units[i]);
          if (cutAfter.has(i)) { runs.push(cur); cur = []; }
        }
        if (cur.length > 0) runs.push(cur);

        const out: NoteData[] = [];
        for (const run of runs) {
          if (run.length === 0) continue;
          const first = run[0];
          const isOriginalHead = first.id === head.id;
          const note: NoteData = {
            id: isOriginalHead ? head.id : `${head.id}-${Math.random().toString(36).slice(2, 8)}`,
            beat: first.beat,
            x: first.x,
            y: first.y,
            type: head.type,
            ...(head.color != null ? { color: head.color } : {}),
            ...((first.angle ?? head.angle) != null ? { angle: first.angle ?? head.angle } : {}),
            ...((first.easing ?? head.easing) != null ? { easing: first.easing ?? head.easing } : {}),
          };
          const children = run.slice(1).map((u) => ({
            beat: u.beat,
            x: u.x,
            y: u.y,
            ...(u.angle != null ? { angle: u.angle } : {}),
            ...(u.easing != null ? { easing: u.easing } : {}),
          }));
          if (children.length > 0) note.nodes = children;
          out.push(note);
        }
        return out;
      };

      const updatedNotes: NoteData[] = [];
      for (const n of chart.notes) {
        if (validChains.has(n.id)) updatedNotes.push(...splitChain(n));
        else updatedNotes.push(n);
      }
      updatedNotes.sort((a, b) => a.beat - b.beat);
      onUpdateChart({ ...chart, notes: updatedNotes });
      onSelectNotes(null);
      return;
    }

    // ---- FlipX / FlipY：只翻转被选中的单位（头或子）----
    if (op === 'FlipX' || op === 'FlipY') {
      const flipX = op === 'FlipX';
      const updatedNotes = chart.notes.map((n) => {
        let next = n;
        let changed = false;
        if (selIds.has(n.id)) {
          next = { ...n, x: flipX ? -n.x : n.x, y: !flipX ? -n.y : n.y };
          changed = true;
        }
        if (n.nodes) {
          const nodes = n.nodes.map((sn, i) => {
            if (!selIds.has(`${n.id}#${i + 1}`)) return sn;
            changed = true;
            return { ...sn, x: flipX ? -sn.x : sn.x, y: !flipX ? -sn.y : sn.y };
          });
          if (changed) next = { ...next, nodes };
        }
        return changed ? next : n;
      });
      onUpdateChart({ ...chart, notes: updatedNotes });
      return;
    }

    // ---- UseRule：对每个选中单位应用放置规则 DSL ----
    // 头节点：完整应用；子节点：应用位置类字段（beat/x/y/angle/easing）。
    // 子节点无 color 字段，DSL 对颜色的改动自动忽略（无害）。
    if (op === 'UseRule') {
      const dsl = editorDsl;
      // 同区间规则：裁剪按显示坐标做，故逐个单位取偏移传入（见 §4.4）。
      const dslTree2 = buildLayerTree(chart);
      const dslMeta2 = chart.metadata;
      const offAt2 = (n: NoteData, beat: number) =>
        layerOffsetAt(
          dslTree2,
          noteLayerIdx(dslTree2, n),
          beatToSecondsMultiBpm(beat, dslMeta2.bpm, dslMeta2.offset, dslMeta2.bpmlist)
        );
      const updatedNotes = chart.notes.map((n) => {
        let next = n;
        let changed = false;
        if (selIds.has(n.id)) {
          next = applyDslToNote(n, dsl, offAt2(n, n.beat));
          changed = true;
        }
        if (n.nodes) {
          const nodes = n.nodes.map((sn, i) => {
            const cid = `${n.id}#${i + 1}`;
            if (!selIds.has(cid)) return sn;
            changed = true;
            // 以子节点自身位置 + 头节点缺省参数构造临时 note 应用 DSL。
            const tmp = applyDslToNote(
              { ...n, beat: sn.beat, x: sn.x, y: sn.y, angle: sn.angle ?? n.angle, easing: sn.easing ?? n.easing, nodes: undefined },
              dsl,
              offAt2(n, sn.beat),
            );
            const out: SlideNodeData = {
              beat: tmp.beat,
              x: tmp.x,
              y: tmp.y,
            };
            if (tmp.angle != null) out.angle = tmp.angle;
            if (tmp.easing != null) out.easing = tmp.easing;
            return out;
          });
          if (changed) next = { ...next, nodes };
        }
        return changed ? next : n;
      });
      onUpdateChart({ ...chart, notes: updatedNotes });
      return;
    }

    // ---- Fill 系列：在相邻选中单位之间按 snap 步进插入新音符 ----
    // 新音符为独立头节点，继承前一个单位的 type/color/angle/easing，坐标按缓动插值。
    const easingFn: (t: number) => number =
      op === 'FillL' ? (t) => t
      : op === 'FillSI' ? EASING_FNS['sine-in']
      : op === 'FillSO' ? EASING_FNS['sine-out']
      : op === 'FillSIO' ? EASING_FNS['sine-io']
      : (t) => t;
    const newNotes: NoteData[] = [];
    for (let i = 0; i < selectedUnits.length - 1; i++) {
      const a = selectedUnits[i];
      const b = selectedUnits[i + 1];
      const beatStep = snap;
      let beat = Math.round((a.beat + beatStep) / beatStep) * beatStep;
      while (beat < b.beat - 1e-6) {
        const t = (beat - a.beat) / (b.beat - a.beat || 1);
        const e = easingFn(Math.max(0, Math.min(1, t)));
        const nx = a.x + (b.x - a.x) * e;
        const ny = a.y + (b.y - a.y) * e;
        const note: NoteData = {
          id: `fill-${Date.now().toString().slice(-5)}-${newNotes.length}-${i}`,
          beat: Math.round(beat * 1000) / 1000,
          x: Math.round(nx * 1000) / 1000,
          y: Math.round(ny * 1000) / 1000,
          type: a.type,
          ...(a.color != null ? { color: a.color } : {}),
          ...(a.angle != null ? { angle: a.angle } : {}),
          ...(a.easing != null ? { easing: a.easing } : {}),
        };
        newNotes.push(note);
        beat += beatStep;
      }
    }
    if (newNotes.length > 0) {
      const updatedNotes = [...chart.notes, ...newNotes].sort((a, b) => a.beat - b.beat);
      onUpdateChart({ ...chart, notes: updatedNotes });
    }
  };

  /** 批量编辑弹窗的删除按钮：需二次确认。第一次点击武装，第二次执行。 */
  const handlePanelBatchDelete = () => {
    if (selectedUnits.length < 1) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setDeleteArmed(false);
    applyBatchOp('Delete');
  };

  const handleModifySelected = (patch: Partial<NoteData>) => {
    if (!selectedBaseId) return;
    const updatedNotes = chart.notes.map((n) => (n.id === selectedBaseId ? { ...n, ...patch } : n));
    onUpdateChart({ ...chart, notes: updatedNotes });
  };

  const handlePatchSlideNode = (childIdx: number, patch: Partial<SlideNodeData>) => {
    if (!selectedNote || !selectedNote.nodes) return;
    const nodes = selectedNote.nodes.map((sn, i) => (i === childIdx ? { ...sn, ...patch } : sn));
    handleModifySelected({ nodes });
  };

  // Click a node box in the chain editor (only on blank area — see row onClick):
  // first click selects the node, a second click on the already-selected node
  // seeks the playhead to its beat.
  const handleNodeClick = (subId: string, beat: number) => {
    if (selectedNoteId === subId) {
      onSeekBeat(beat);
    } else {
      onSelectNote(subId);
    }
  };

  // Cycle the note type through Tap → Touch → Slide (and back) in a single button.
  const TYPE_CYCLE: NoteType[] = ['tap', 'touch', 'slide'];
  const cycleType = () => {
    const idx = TYPE_CYCLE.indexOf(selectedNote!.type);
    const next = TYPE_CYCLE[(idx + 1) % TYPE_CYCLE.length];
    handleModifySelected({ type: next });
  };

  const handleAddSlideNode = () => {
    if (!selectedNote) return;
    const nodes = selectedNote.nodes ?? [];
    const last = nodes.length > 0 ? nodes[nodes.length - 1] : { beat: selectedNote.beat, x: selectedNote.x, y: selectedNote.y };
    const newNode = { beat: Math.round((last.beat + 1) * 1000) / 1000, x: last.x, y: last.y };
    handleModifySelected({ nodes: [...nodes, newNode] });
  };

  const handleRemoveSlideNode = (childIdx: number) => {
    if (!selectedNote || !selectedNote.nodes) return;
    const nodes = selectedNote.nodes.filter((_, i) => i !== childIdx);
    handleModifySelected({ nodes });
    onSelectNote(selectedNote.id);
  };

  const handleDeleteSelected = () => {
    if (!selectedBaseId) return;
    const updatedNotes = chart.notes.filter((n) => n.id !== selectedBaseId);
    onUpdateChart({ ...chart, notes: updatedNotes });
    onSelectNote(null);
  };

  // Remove the head node: promote the first child to become the new head (its
  // explicit angle/easing win, otherwise it inherits the old head's effective
  // values so behavior is unchanged). If there are no children, deleting the
  // head deletes the entire chain.
  const handleRemoveHeadNode = () => {
    if (!selectedNote) return;
    const nodes = selectedNote.nodes ?? [];
    if (nodes.length === 0) {
      handleDeleteSelected();
      return;
    }
    const [newHead, ...rest] = nodes;
    handleModifySelected({
      beat: newHead.beat,
      x: newHead.x,
      y: newHead.y,
      angle: newHead.angle ?? selectedNote.angle,
      easing: newHead.easing ?? selectedNote.easing,
      nodes: rest,
    });
    // A child node was selected → its index shifts down by one (node #1 became head).
    if (selectedNoteId && selectedNoteId !== selectedNote.id) {
      const hashIdx = selectedNoteId.indexOf('#');
      if (hashIdx >= 0) {
        const k = parseInt(selectedNoteId.slice(hashIdx + 1), 10);
        if (!Number.isNaN(k)) {
          onSelectNote(k <= 1 ? selectedNote.id : `${selectedNote.id}#${k - 1}`);
        }
      }
    }
  };

  const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      try {
        await onUploadAudioFile(e.target.files[0]);
        setFileError(null);
      } catch (err) {
        setFileError(err instanceof Error ? err.message : t('editor.audioDecodeError'));
      }
    }
  };

  const handleChartUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const reader = new FileReader();
      reader.onload = (evt) => {
        const text = evt.target?.result as string;
        const res = parseAndValidateChart(text);
        if (res.valid && res.chart) {
          onUpdateChart(res.chart);
          setFileError(null);
        } else {
          setFileError(res.error || t('editor.fileParseError'));
        }
      };
      reader.readAsText(file);
    }
  };

  /** 歌曲媒体挂载（bg.jpg / bga.mp4 / story.js）：透传给 App 侧存储与预览。 */
  const handleMediaUpload = async (
    kind: 'bgImage' | 'bgVideo' | 'storyboard',
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !onAttachMedia) return;
    try {
      await onAttachMedia(kind, file);
      setFileError(null);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDownloadJson = () => {
    const blob = new Blob([exportChartJson(chart)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${chart.metadata.title.toLowerCase().replace(/\s+/g, '_')}_chart.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /**
   * 「导出 zip」：把**当前未保存**的谱面交给 App 整包导出。
   * 传exportChartJson(chart) 而非让App 从 idb 读 —— 编辑器里的改动可能还没落盘，
   * 导出的包理应是"我眼前这份"。
   */
  const [exportingZip, setExportingZip] = useState(false);
  const handleExportZip = async () => {
    if (!onExportZip || exportingZip) return;
    setExportingZip(true);
    try {
      await onExportZip(exportChartJson(chart));
      setFileError(null);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : String(err));
    } finally {
      setExportingZip(false);
    }
  };

  // Panel drag via window listeners — robust in WebViews where
  // setPointerCapture is dropped when the element re-renders mid-drag.
  const onPanelPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const posX = panelPos.x;
    const posY = panelPos.y;
    const move = (ev: PointerEvent) => {
      setPanelPos({ x: posX + (ev.clientX - startX), y: posY + (ev.clientY - startY) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  // Snapping Panel Drag Handlers
  const onSnapPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const posX = snappingPos.x;
    const posY = snappingPos.y;
    const move = (ev: PointerEvent) => {
      setSnappingPos({ x: posX + (ev.clientX - startX), y: posY + (ev.clientY - startY) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const toolBtnCls = (tool: EditorTool) =>
    `py-2 px-1 rounded-lg border font-bold text-center transition cursor-pointer flex flex-col items-center gap-1 ${
      activeTool === tool
        ? (tool === 'select' && isMultiSelect
            // 多选模式：select 工具高亮由青色变为金色发光
            ? 'bg-amber-500/20 border-amber-400/60 text-amber-200 shadow-[0_0_16px_rgba(251,191,36,0.3),inset_0_1px_0_rgba(255,255,255,0.14)]'
            : 'bg-cyan-500/20 border-cyan-400/60 text-cyan-200 shadow-[0_0_16px_rgba(34,211,238,0.25),inset_0_1px_0_rgba(255,255,255,0.14)]')
        : 'glass-sub border-white/10 text-white/70 hover:text-white hover:bg-white/[0.08]'
    }`;

  const toggleSection = (key: keyof typeof sectionOpen) => {
    setSectionOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // View-mode buttons highlight by viewMode (independent of the editor tool).
  const viewBtnCls =
    'py-2 px-1 rounded-lg border font-bold text-center transition cursor-pointer flex flex-col items-center gap-1 glass-sub border-white/10 text-white/70 hover:text-white hover:bg-white/[0.08]';
  const viewBtnSelectedCls =
    'py-2 px-1 rounded-lg border font-bold text-center transition cursor-pointer flex flex-col items-center gap-1 bg-cyan-500/20 border-cyan-400/60 text-cyan-200 shadow-[0_0_16px_rgba(34,211,238,0.25),inset_0_1px_0_rgba(255,255,255,0.14)]';

  const sectionClass = 'rounded-xl glass-sub border-white/10 overflow-hidden';
  const sectionHeaderClass = 'w-full px-3 py-2 flex items-center justify-between text-left font-bold text-white/85 hover:bg-white/[0.06] transition cursor-pointer';

  // Collapsed Tool Selector Icons
  const collapsedToolIcon = (tool: EditorTool) => {
    const isSelected = activeTool === tool;
    // 多选模式下 select 工具高亮金色发光（其余工具仍青色）。
    const selectGold = tool === 'select' && isMultiSelect;
    const baseCls = `w-8 h-8 rounded-lg flex items-center justify-center border transition cursor-pointer ${
      isSelected
        ? (selectGold
            ? 'bg-amber-500/20 border-amber-400/60 text-amber-200 shadow-[0_0_14px_rgba(251,191,36,0.3)]'
            : 'bg-cyan-500/20 border-cyan-400/60 text-cyan-200 shadow-[0_0_14px_rgba(34,211,238,0.25)]')
        : 'border-transparent text-white/55 hover:bg-white/[0.08] hover:text-white'
    }`;

    switch (tool) {
      case 'select':
        return (
          <button
            key={tool}
            onClick={handleSelectToolClick}
            className={baseCls}
            title={t('editor.select') + ' (R) · ' + t('editor.multiSelect')}
          >
            <Move size={16} />
          </button>
        );
      case 'place-tap':
        return (
          <button key={tool} onClick={() => onSetActiveTool(tool)} className={baseCls} title={t('editor.placeTap') + ' (Q)'}>
            <span className="w-3.5 h-3.5 border-2 border-cyan-300 block" />
          </button>
        );
      case 'place-touch':
        return (
          <button key={tool} onClick={() => onSetActiveTool(tool)} className={baseCls} title={t('editor.placeTouch') + ' (W)'}>
            <span className="w-3.5 h-3.5 rounded-full border-2 border-sky-300 block" />
          </button>
        );
      case 'place-slide':
        return (
          <button key={tool} onClick={() => onSetActiveTool(tool)} className={baseCls} title={t('editor.placeSlide') + ' (E)'}>
            <span className="w-3 h-3 border-2 border-cyan-300 block rotate-45" />
          </button>
        );
      case 'quick-create':
        return (
          <button key={tool} onClick={() => onSetActiveTool(tool)} className={baseCls} title={t('editor.quickCreate')}>
            <Zap size={15} />
          </button>
        );
    }
  };

  return (
    <div className="absolute inset-0 pointer-events-none z-20 font-rajdhani select-none">
      {/* 1. Collapsible Left Sidebar */}
      <div
        className={`absolute top-0 bottom-0 left-0 transition-all duration-300 pointer-events-auto flex flex-col bg-white/[0.05] editor-sidebar-glass border-r border-white/12 text-white shadow-2xl z-30 overflow-hidden ${
          isSidebarExpanded ? 'w-80' : 'w-12'
        }`}
        style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.14)' }}
      >
        {/* 标题绝对定位 + 不换行：宽度动画期间不重排；折叠按钮在流内 ml-auto，
         *  展开时随容器变宽滑向右侧（原始设计的正常行为）。 */}
        <div className="relative flex items-center h-12 p-3 border-b border-white/10 bg-white/[0.03]">
          {isSidebarExpanded && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center gap-2 whitespace-nowrap">
              <div className="w-6 h-6 rounded bg-cyan-500/20 text-cyan-300 flex items-center justify-center font-bold text-xs border border-cyan-400/40">
                ED
              </div>
              <span className="font-bold font-orbitron text-sm tracking-wider text-white/90">
                {t('editor.editorTitle')}
              </span>
            </div>
          )}
          <button
            onClick={() => setIsSidebarExpanded(!isSidebarExpanded)}
            className={`p-1 rounded-lg hover:bg-white/10 text-cyan-300 transition cursor-pointer ${isSidebarExpanded ? 'ml-auto' : 'mx-auto'}`}
            title={isSidebarExpanded ? t('editor.collapseSidebar') : t('editor.expandSidebar')}
          >
            {isSidebarExpanded ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
          </button>
        </div>

        {/* Vertical Tool Selector when collapsed */}
        {!isSidebarExpanded && (
          <div className="flex-1 flex flex-col items-center py-4 gap-4">
            <div className="text-[9px] font-bold text-cyan-300 font-orbitron uppercase tracking-widest leading-none rotate-90 my-2">
              TOOLS
            </div>
            {['select', 'place-tap', 'place-touch', 'place-slide', ...(viewMode === '2d' ? [] : (['quick-create'] as EditorTool[]))].map((t) =>
              collapsedToolIcon(t as EditorTool)
            )}
          </div>
        )}

        {isSidebarExpanded && (
          <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs w-80 shrink-0">
            {/* Beat HUD */}
            <div className="p-3 rounded-xl glass-sub border-white/12" style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)' }}>
              <div className="text-[10px] uppercase font-bold text-white/50">{t('editor.curBeat')}</div>
              <div className="text-3xl font-black font-orbitron gradient-text bg-gradient-to-r from-cyan-300 to-amber-300">
                <LiveBeat />
              </div>
              <div className="flex justify-between items-center text-[11px] text-white/70 mt-1 font-mono">
                <span>{t('editor.time')}: <LiveTime /></span>
                <span>{playableCount} {t('editor.notes')}</span>
              </div>
            </div>

            {/* === View Section (3D / 2D) === */}
            <div className={sectionClass}>
              <button onClick={() => toggleSection('view')} className={sectionHeaderClass}>
                <span className="flex items-center gap-1.5"><Box size={12} /> {t('editor.view')}</span>
                <span className="text-cyan-300/80">{sectionOpen.view ? '−' : '+'}</span>
              </button>
              {sectionOpen.view && (
                <div className="p-3 space-y-2 border-t border-white/10">
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={() => onSetViewMode('3d')}
                      className={viewMode === '3d' ? viewBtnSelectedCls : viewBtnCls}
                    >
                      <Box size={14} /><span>{t('editor.view3d')}</span>
                    </button>
                    <button
                      onClick={() => onSetViewMode('2d')}
                      className={viewMode === '2d' ? viewBtnSelectedCls : viewBtnCls}
                    >
                      <LayoutGrid size={14} /><span>{t('editor.view2d')}</span>
                    </button>
                  </div>

                  {viewMode === '2d' && (
                    <div className="pt-1 space-y-2 border-t border-white/10">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-white/70">{t('editor.snapCols')}</span>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => onSetVlineCount(Math.max(3, vlineCount - 2))}
                            className="w-6 h-6 rounded glass-btn text-sm leading-none flex items-center justify-center cursor-pointer"
                          >−</button>
                          <span className="w-8 text-center text-xs font-mono">{vlineCount}</span>
                          <button
                            onClick={() => onSetVlineCount(Math.min(49, vlineCount + 2))}
                            className="w-6 h-6 rounded glass-btn text-sm leading-none flex items-center justify-center cursor-pointer"
                          >+</button>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-white/70">{t('editor.timelineZoom')}</span>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => onSetPxPerBeat(Math.max(20, pxPerBeat - 8))}
                            className="w-6 h-6 rounded glass-btn text-sm leading-none flex items-center justify-center cursor-pointer"
                          >−</button>
                          <span className="w-10 text-center text-xs font-mono">{pxPerBeat}</span>
                          <button
                            onClick={() => onSetPxPerBeat(Math.min(220, pxPerBeat + 8))}
                            className="w-6 h-6 rounded glass-btn text-sm leading-none flex items-center justify-center cursor-pointer"
                          >+</button>
                        </div>
                      </div>
                      <label className="flex items-center gap-1.5 text-[11px] text-white/70 cursor-pointer pt-1">
                        <input
                          type="checkbox"
                          checked={!!preview3D}
                          onChange={() => onTogglePreview3D?.()}
                          className="accent-cyan-400"
                        />
                        {t('editor.preview3d')}
                      </label>
                      {/* 音频波形：勾选后 2D 画布按时间轴叠加半透明波形。仅当已加载
                          真实音频文件（非自带合成器）时才有样本数据可画。 */}
                      <label className="flex items-center gap-1.5 text-[11px] text-white/70 cursor-pointer pt-1">
                        <input
                          type="checkbox"
                          checked={!!showWaveform}
                          onChange={() => onToggleShowWaveform?.()}
                          className="accent-cyan-400"
                        />
                        {t('editor.showWaveform')}
                      </label>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className={sectionClass}>
              <button onClick={() => toggleSection('tools')} className={sectionHeaderClass}>
                <span className="flex items-center gap-1.5"><MousePointer2 size={12} /> {t('editor.modeTools')}</span>
                <span className="text-cyan-300/80">{sectionOpen.tools ? '−' : '+'}</span>
              </button>
              {sectionOpen.tools && (
                <div className="p-3 space-y-1.5 border-t border-white/10">
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={handleSelectToolClick}
                      className={toolBtnCls('select')}
                      title={t('editor.select') + ' (R) · ' + t('editor.multiSelect')}
                    >
                      <Move size={14} /><span>{isMultiSelect ? t('editor.multiSelect') : t('editor.select')}</span>
                    </button>
                    {viewMode !== '2d' && (
                      <button onClick={() => onSetActiveTool('quick-create')} className={toolBtnCls('quick-create')}><Zap size={14} /><span>{t('editor.quickCreate')}</span></button>
                    )}
                    <button onClick={() => onSetActiveTool('place-tap')} className={toolBtnCls('place-tap')} title={t('editor.placeTap') + ' (Q)'}><span className="w-3.5 h-3.5 border-2 border-cyan-300 block" /><span>{t('editor.placeTap')}</span></button>
                    <button onClick={() => onSetActiveTool('place-touch')} className={toolBtnCls('place-touch')} title={t('editor.placeTouch') + ' (W)'}><span className="w-3.5 h-3.5 rounded-full border-2 border-sky-300 block" /><span>{t('editor.placeTouch')}</span></button>
                    <button onClick={() => onSetActiveTool('place-slide')} className={toolBtnCls('place-slide')} title={t('editor.placeSlide') + ' (E)'}><span className="w-3.5 h-3.5 border-2 border-cyan-300 block rotate-45" /><span>{t('editor.placeSlide')}</span></button>
                  </div>
                  {viewMode === '2d' ? (
                    <p className="text-[10px] text-white/50">
                      {t('editor.explain2d')}
                      {activeTool === 'select'
                        ? t('editor.explainSelect2d')
                        : t('editor.explainPlace2d')}
                    </p>
                  ) : (
                    <p className="text-[10px] text-white/50">
                      {activeTool === 'quick-create'
                        ? t('editor.explainQuickCreate')
                        : activeTool === 'select'
                        ? t('editor.explainSelect3d')
                        : activeTool === 'place-slide'
                        ? t('editor.explainSlide')
                        : t('editor.explainPlace3d')}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* === Play Test Section === */}
            <div className={sectionClass}>
              <button onClick={() => toggleSection('playtest')} className={sectionHeaderClass}>
                <span className="flex items-center gap-1.5"><Zap size={12} /> {t('editor.playTestMode')}</span>
                <span className="text-cyan-300/80">{sectionOpen.playtest ? '−' : '+'}</span>
              </button>
              {sectionOpen.playtest && (
                <div className="p-3 space-y-2 border-t border-white/10">
                  <p className="text-[10px] text-white/50">
                    {t('editor.playTestDesc')}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => onStartPlayTest(true)}
                      className="py-2 px-2 rounded glass-btn-primary text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer"
                      style={cssVars({ '--hud-accent': '#f59e0b' })}
                    >
                      <Play size={12} /> {t('editor.startHere')}
                    </button>
                    <button
                      onClick={() => onStartPlayTest(false)}
                      className="py-2 px-2 rounded glass-btn-primary text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer"
                    >
                      <RotateCcw size={12} /> {t('editor.fromStart')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* === Layers Section（图层） === */}
            <div className={sectionClass}>
              <button onClick={() => toggleSection('layers')} className={sectionHeaderClass}>
                <span className="flex items-center gap-1.5"><Layers size={12} /> {t('editor.layers')}</span>
                <span className="text-cyan-300/80">{sectionOpen.layers ? '−' : '+'}</span>
              </button>
              {sectionOpen.layers && (
                <div className="p-3 space-y-2 border-t border-white/10">
                  <div className="grid grid-cols-2 gap-1.5">
                    <button onClick={() => handleAddLayer(false)} className="py-1.5 px-2 rounded glass-btn border-cyan-400/40 text-cyan-300 hover:text-cyan-200 text-[11px] transition cursor-pointer">
                      {t('editor.layer.addRoot')}
                    </button>
                    <button
                      onClick={() => handleAddLayer(true)}
                      disabled={!editorLayerId}
                      className="py-1.5 px-2 rounded glass-btn border-cyan-400/40 text-cyan-300 hover:text-cyan-200 text-[11px] transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {t('editor.layer.addChild')}
                    </button>
                  </div>
                  <button
                    onClick={() => onEditorLayerChange(null)}
                    className={`w-full text-left rounded px-2 py-1 text-[11px] transition cursor-pointer border ${editorLayerId === null ? 'bg-cyan-500/20 border-cyan-400/40 text-cyan-200' : 'border-transparent text-white/70 hover:bg-white/5'}`}
                  >
                    {t('editor.layer.overview')} <span className="text-white/40">({chart.notes.length})</span>
                  </button>
                  <div className="space-y-1">
                    {/* 默认根图层：所有不带 layerId 的音符（旧格式形态，不可删除） */}
                    <button
                      onClick={() => onEditorLayerChange(editorLayerId === '' ? null : '')}
                      className={`w-full text-left rounded px-2 py-1 text-[11px] transition cursor-pointer border ${editorLayerId === '' ? 'bg-cyan-500/20 border-cyan-400/40 text-cyan-200' : 'border-transparent text-white/70 hover:bg-white/5'}`}
                    >
                      {t('editor.layer.defaultRoot')} <span className="text-white/40">({layerNoteCount('')})</span>
                    </button>
                    {layerTreeRows.map(({ l, depth }) => (
                      <div
                        key={l.id}
                        className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] transition border ${editorLayerId === l.id ? 'bg-cyan-500/20 border-cyan-400/40 text-cyan-200' : 'border-transparent text-white/70 hover:bg-white/5'}`}
                        style={{ marginLeft: depth * 12 }}
                      >
                        <button
                          onClick={() => onEditorLayerChange(editorLayerId === l.id ? null : l.id)}
                          className="flex-1 text-left truncate cursor-pointer"
                          title={l.id}
                        >
                          {l.name || l.id} <span className="text-white/40">({layerNoteCount(l.id)})</span>
                        </button>
                        {/* 音符色/速率已去掉 UI：均由事件（note_color_change / speed_change）驱动，
                            图层字段仅作旧谱兼容。 */}
                        <button onClick={() => handleRenameLayer(l.id)} className="px-1 text-white/40 hover:text-cyan-300 cursor-pointer" title={t('editor.layer.renamePrompt')}>✎</button>
                        <button onClick={() => handleDeleteLayer(l.id)} className="px-1 text-white/40 hover:text-red-300 cursor-pointer" title="✕">✕</button>
                      </div>
                    ))}
                  </div>
                  <p className="text-[9px] text-white/40 leading-snug">{t('editor.layer.hint')}</p>
                </div>
              )}
            </div>

            {/* === Events Section === */}
            <div className={sectionClass}>
              <button onClick={() => toggleSection('events')} className={sectionHeaderClass}>
                <span className="flex items-center gap-1.5"><Music size={12} /> {t('editor.events')}</span>
                <span className="text-cyan-300/80">{sectionOpen.events ? '−' : '+'}</span>
              </button>
              {sectionOpen.events && (
                <div className="p-3 space-y-2 border-t border-white/10">
                  <div className="text-[10px] text-white/50">
                    {t('editor.addEventAtBeat')} (<LiveBeat />) · {t('editor.evt.target')}
                    <span className="text-cyan-300"> {eventTargetName}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button onClick={() => handleAddEvent('speed_change')} className="py-1.5 px-2 rounded glass-btn border-purple-400/40 text-purple-300 hover:text-purple-200 text-[11px] transition cursor-pointer">
                      {t('editor.evt.speed')}
                    </button>
                    <button onClick={() => handleAddEvent('text_display')} className="py-1.5 px-2 rounded glass-btn border-amber-400/40 text-amber-300 hover:text-amber-200 text-[11px] transition cursor-pointer">
                      {t('editor.evt.text')}
                    </button>
                    <button onClick={() => handleAddEvent('note_color_change')} className="py-1.5 px-2 rounded glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 text-[11px] transition cursor-pointer">
                      {t('editor.evt.noteColor')}
                    </button>
                    <button onClick={() => handleAddEvent('bg_change')} className="py-1.5 px-2 rounded glass-btn border-cyan-400/40 text-cyan-300 hover:text-emerald-200 text-[11px] transition cursor-pointer">
                      {t('editor.evt.bg')}
                    </button>
                    <button onClick={() => handleAddEvent('offset_change')} className="py-1.5 px-2 rounded glass-btn border-pink-400/40 text-pink-300 hover:text-pink-200 text-[11px] transition cursor-pointer">
                      {t('editor.evt.offset')}
                    </button>
                  </div>

                  <div className="pt-2 border-t border-white/10 space-y-1.5 max-h-64 overflow-y-auto">
                      <div className="text-[10px] text-white/50">
                        {t('editor.eventList')} ({getEvents().length})
                      </div>
                      {getEvents().length === 0 && (
                        <div className="text-[10px] text-white/40 italic py-2 text-center">
                          {t('editor.noEvents')}
                        </div>
                      )}
                    {getEvents().map((evt) => (
                      <EventRow
                        key={evt.id}
                        event={evt}
                        onSeek={() => onSeekBeat(evt.beat)}
                        onUpdate={(updates) => handleUpdateEvent(evt.id, updates)}
                        onDelete={() => handleDeleteEvent(evt.id)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* === 高级功能：放置规则 === */}
            <div className={sectionClass}>
              <button onClick={() => toggleSection('rules')} className={sectionHeaderClass}>
                <span className="flex items-center gap-1.5"><Wand2 size={12} /> {t('editor.rules')}</span>
                <span className="text-cyan-300/80">{sectionOpen.rules ? '−' : '+'}</span>
              </button>
              {sectionOpen.rules && (
                <div className="p-3 space-y-2 border-t border-white/10">
                  <p className="text-[10px] text-white/50">{t('editor.rulesHint')}</p>
                  <textarea
                    value={editorDsl}
                    onChange={(e) => onEditorDslChange(e.target.value)}
                    spellCheck={false}
                    rows={8}
                    wrap="off"
                    className="w-full glass-input border border-white/12 rounded px-2 py-1.5 text-[11px] font-mono text-cyan-100 leading-relaxed resize-y whitespace-pre overflow-x-auto"
                    placeholder={'beat % 0.5 == 0 : color = "#ff0000"'}
                  />
                  {ruleErrors.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[10px] text-red-300/90">{t('editor.rulesErrors')}</div>
                      {ruleErrors.map((err) => (
                        <div key={err.line} className="text-[10px] text-red-300/80 font-mono">
                          {t('editor.rulesLineError', { n: err.line, msg: err.message })}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className={sectionClass}>
              <button onClick={() => toggleSection('metadata')} className={sectionHeaderClass}>
                <span className="flex items-center gap-1.5"><Settings2 size={12} /> {t('editor.metadata')}</span>
                <span className="text-cyan-300/80">{sectionOpen.metadata ? '−' : '+'}</span>
              </button>
              {sectionOpen.metadata && (
                <div className="p-3 space-y-2 border-t border-white/10">
                  <div><label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fTitle')}</label><input type="text" value={chart.metadata.title} onChange={(e) => onUpdateChart({ ...chart, metadata: { ...chart.metadata, title: e.target.value } })} className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200" /></div>
                  <div><label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fArtist')}</label><input type="text" value={chart.metadata.artist} onChange={(e) => onUpdateChart({ ...chart, metadata: { ...chart.metadata, artist: e.target.value } })} className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200" /></div>
                  <div><label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fDifficulty')}</label><input type="text" value={chart.metadata.difficulty} onChange={(e) => onUpdateChart({ ...chart, metadata: { ...chart.metadata, difficulty: e.target.value } })} className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200" /></div>
                  <div><label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fCover')}</label><input type="text" value={chart.metadata.jacket || ''} onChange={(e) => onUpdateChart({ ...chart, metadata: { ...chart.metadata, jacket: e.target.value || undefined } })} className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200" /></div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[10px] text-white/50">{t('editor.fNoteColor')}<input type="color" value={chart.metadata.noteColor || '#00f0ff'} onChange={(e) => onUpdateChart({ ...chart, metadata: { ...chart.metadata, noteColor: e.target.value } })} className="mt-1 w-full h-8 bg-transparent cursor-pointer" /></label>
                    <label className="text-[10px] text-white/50">{t('editor.fAccent')}<input type="color" value={chart.metadata.bgScheme.accentColor || '#00f0ff'} onChange={(e) => onUpdateChart({ ...chart, metadata: { ...chart.metadata, bgScheme: { ...chart.metadata.bgScheme, accentColor: e.target.value } } })} className="mt-1 w-full h-8 bg-transparent cursor-pointer" /></label>
                    <label className="text-[10px] text-white/50">{t('editor.fBgStart')}<input type="color" value={chart.metadata.bgScheme.gradientStart || '#050c1e'} onChange={(e) => onUpdateChart({ ...chart, metadata: { ...chart.metadata, bgScheme: { ...chart.metadata.bgScheme, gradientStart: e.target.value } } })} className="mt-1 w-full h-8 bg-transparent cursor-pointer" /></label>
                    <label className="text-[10px] text-white/50">{t('editor.fBgEnd')}<input type="color" value={chart.metadata.bgScheme.gradientEnd || '#1b072c'} onChange={(e) => onUpdateChart({ ...chart, metadata: { ...chart.metadata, bgScheme: { ...chart.metadata.bgScheme, gradientEnd: e.target.value } } })} className="mt-1 w-full h-8 bg-transparent cursor-pointer" /></label>
                  </div>
                  {/* 背景媒体（图片/视频）不再属于谱面：由歌曲目录约定文件
                     （bg.jpg / bga.mp4）提供，随歌曲走，便于打包分享与离线游玩。 */}
                  <div className="grid grid-cols-2 gap-2 pt-1 text-[11px] text-white/70">
                    {(['bloom', 'particles', 'projection', 'gridLines'] as const).map((k) => <label key={k} className="flex items-center gap-1.5"><input type="checkbox" checked={!!chart.metadata.effectToggles[k]} onChange={(e) => onUpdateChart({ ...chart, metadata: { ...chart.metadata, effectToggles: { ...chart.metadata.effectToggles, [k]: e.target.checked } } })} className="accent-cyan-400" />{k}</label>)}
                  </div>
                </div>
              )}
            </div>

            <div className={sectionClass}>
              <button onClick={() => toggleSection('timing')} className={sectionHeaderClass}>
                <span className="flex items-center gap-1.5"><Clock size={12} /> {t('editor.timing')}</span>
                <span className="text-cyan-300/80">{sectionOpen.timing ? '−' : '+'}</span>
              </button>
              {sectionOpen.timing && (
                <div className="p-3 border-t border-white/10 space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div><label className="text-[10px] text-white/50">{t('editor.bpmBase')}</label><NumField value={chart.metadata.bpm} placeholder="120" min={30} max={400} step={1} onCommit={(v) => handleUpdateMeta('bpm', v ?? 0)} className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200 font-mono" /></div>
                    <div><label className="text-[10px] text-white/50">{t('editor.offsetSec')}</label><NumField value={chart.metadata.offset} placeholder="0" step="0.01" onCommit={(v) => handleUpdateMeta('offset', v ?? 0)} className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200 font-mono" /></div>
                  </div>
                  <div className="border-t border-white/10 pt-2">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] text-cyan-300 font-bold">{t('editor.bpmChanges')}</span>
                      <LiveBeatGate>{(beat) => (
                        <button
                          onClick={handleAddBpmPoint}
                          disabled={beat <= 0}
                          className="text-[10px] px-2 py-0.5 rounded bg-cyan-600/50 hover:bg-cyan-600 text-white font-bold transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                        >
                          {t('editor.addAtCurrentBeat')}
                        </button>
                      )}</LiveBeatGate>
                    </div>
                    {getBpmList().length === 0 ? (
                      <div className="text-[10px] text-white/40 italic">{t('editor.noBpmChange')}</div>
                    ) : (
                      <div className="space-y-1.5 max-h-40 overflow-y-auto">
                        {getBpmList().map((p, idx) => (
                          <div key={idx} className="flex items-center gap-1.5 text-[11px]">
                            <NumField
                              value={p.beat}
                              placeholder="0.01"
                              step={snapSubdivision} min={0.01}
                              onCommit={(v) => handleUpdateBpmPoint(idx, { beat: v ?? 0 })}
                              className="w-16 glass-input border border-white/12 rounded px-1.5 py-0.5 text-cyan-200 font-mono"
                            />
                            <span className="text-white/40">拍 →</span>
                            <NumField
                              value={p.bpm}
                              placeholder="120"
                              min={30} max={400} step={1}
                              onCommit={(v) => handleUpdateBpmPoint(idx, { bpm: v ?? 0 })}
                              className="w-16 glass-input border border-white/12 rounded px-1.5 py-0.5 text-cyan-200 font-mono"
                            />
                            <span className="text-white/40">BPM</span>
                            <button
                              onClick={() => handleDeleteBpmPoint(idx)}
                              className="ml-auto text-red-400 hover:text-red-300 text-xs cursor-pointer"
                              title={t('editor.delete')}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                      <div className="mt-2 text-[10px] text-white/40 font-mono">
                        {t('editor.curBeatBpm')}: <LiveBeatGate>{(beat) => getBpmAtBeatLocal(beat).toFixed(0)}</LiveBeatGate>
                        {' | '}
                        {t('editor.totalDuration')}: {beatToSecondsMultiBpm(chartMaxBeat, chart.metadata.bpm, chart.metadata.offset, getBpmList()).toFixed(2)}s
                      </div>
                  </div>
                </div>
              )}
            </div>

            <div className={sectionClass}>
              <button onClick={() => toggleSection('batch')} className={sectionHeaderClass}>
                <span className="flex items-center gap-1.5"><BoxSelect size={12} /> {t('editor.rangeOp')}</span>
                <span className="text-cyan-300/80">{sectionOpen.batch ? '−' : '+'}</span>
              </button>
              {sectionOpen.batch && <div className="p-3 space-y-2.5 border-t border-white/10"><div className="flex justify-end">{validBatchRange && <span className="text-[10px] text-cyan-400 font-mono">{t('editor.batchNotes', { n: notesInBatch.length })}</span>}</div><div className="grid grid-cols-2 gap-2"><button onClick={handleSetBatchStart} className="py-1.5 px-2 rounded glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 transition cursor-pointer text-center">{t('editor.batchStart')}: {batchSelection.startBeat !== null ? `B${batchSelection.startBeat}` : t('editor.batchUnset')}</button><button onClick={handleSetBatchEnd} className="py-1.5 px-2 rounded glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 transition cursor-pointer text-center">{t('editor.batchEnd')}: {batchSelection.endBeat !== null ? `B${batchSelection.endBeat}` : t('editor.batchUnset')}</button></div>{validBatchRange && <div className="space-y-2 pt-1 border-t border-white/10"><div className="text-[10px] text-white/70 font-mono">{t('editor.batchRange')}: [{validBatchRange.start.toFixed(2)} ~ {validBatchRange.end.toFixed(2)}]</div><div className="grid grid-cols-2 gap-2"><button onClick={handleBatchClone} className="py-1.5 rounded glass-btn border-cyan-400/40 text-cyan-300 hover:text-emerald-200 flex items-center justify-center gap-1 font-bold transition cursor-pointer"><Copy size={12} /> {t('editor.clone')}</button>{!confirmBatchDelete ? <button onClick={() => setConfirmBatchDelete(true)} className="py-1.5 rounded glass-btn border-red-400/40 text-red-300 hover:text-red-200 flex items-center justify-center gap-1 font-bold transition cursor-pointer"><Trash2 size={12} /> {t('editor.delete')}</button> : <button onClick={handleBatchDelete} className="py-1.5 rounded bg-red-600 text-white font-bold animate-pulse text-center cursor-pointer">{t('editor.confirmQ')}</button>}</div><div className="grid grid-cols-2 gap-2 pt-1"><button onClick={handleBatchFlipX} className="py-1.5 rounded glass-btn border-fuchsia-400/40 text-fuchsia-300 hover:text-fuchsia-200 flex items-center justify-center gap-1 font-bold transition cursor-pointer"><FlipHorizontal size={12} /> {t('editor.flipX')}</button><button onClick={handleBatchFlipY} className="py-1.5 rounded glass-btn border-fuchsia-400/40 text-fuchsia-300 hover:text-fuchsia-200 flex items-center justify-center gap-1 font-bold transition cursor-pointer"><FlipVertical size={12} /> {t('editor.flipY')}</button></div><div className="grid grid-cols-2 gap-2 pt-1"><button onClick={() => onSelectNotes(notesInBatch.map((n) => n.id))} disabled={notesInBatch.length === 0} className={`py-1.5 rounded glass-btn border-emerald-400/40 text-emerald-300 hover:text-emerald-200 flex items-center justify-center gap-1 font-bold transition ${notesInBatch.length === 0 ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}><BoxSelect size={12} /> {t('editor.selectAll')}</button><button onClick={handleBatchApplyRule} disabled={notesInBatch.length === 0} className={`py-1.5 rounded glass-btn border-violet-400/40 text-violet-300 hover:text-violet-200 flex items-center justify-center gap-1 font-bold transition ${notesInBatch.length === 0 ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}><Wand2 size={12} /> {t('editor.applyRule')}</button></div></div>}</div>}
            </div>

            <div className={sectionClass}>
              <button onClick={() => toggleSection('importExport')} className={sectionHeaderClass}>
                <span className="flex items-center gap-1.5"><FileDown size={12} /> {t('editor.importExport')}</span>
                <span className="text-cyan-300/80">{sectionOpen.importExport ? '−' : '+'}</span>
              </button>
              {sectionOpen.importExport && <div className="p-3 space-y-1.5 border-t border-white/10">{fileError && <div className="text-red-400 text-[10px]">{fileError}</div>}<label className="block w-full text-center py-1.5 rounded glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 cursor-pointer font-bold"><Upload size={12} className="inline mr-1" /> {t('editor.importAudio')}<input type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac" onChange={handleAudioUpload} className="hidden" /></label><label className="block w-full text-center py-1.5 rounded glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 cursor-pointer font-bold"><Upload size={12} className="inline mr-1" /> {t('editor.importChartJson')}<input type="file" accept=".json,application/json" onChange={handleChartUpload} className="hidden" /></label><button onClick={handleDownloadJson} className="w-full py-1.5 rounded glass-btn-primary font-bold transition cursor-pointer"><Download size={12} className="inline mr-1" /> {t('editor.exportJson')}</button>{onExportZip && <><button onClick={handleExportZip} disabled={exportingZip} className="w-full py-1.5 rounded glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 transition cursor-pointer font-bold disabled:opacity-50 disabled:cursor-wait"><Download size={12} className="inline mr-1" /> {exportingZip ? t('songcard.loading') : t('editor.exportZip')}</button><p className="text-[10px] text-white/40 leading-snug">{t('editor.exportZipHint')}</p></>}<div className="pt-1 mt-1 border-t border-white/10 space-y-1.5"><p className="text-[10px] text-white/40 leading-snug">{t('editor.attachMediaHint')}</p>{([['bgImage', t('editor.attachBgImage'), 'image/*'], ['bgVideo', t('editor.attachBgVideo'), 'video/mp4,video/*'], ['storyboard', t('editor.attachStoryboard'), '.js,text/javascript']] as const).map(([kind, label, accept]) => (<div key={kind} className="flex items-center gap-1"><label className="flex-1 min-w-0 text-center py-1.5 rounded glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 cursor-pointer font-bold"><Upload size={12} className="inline mr-1" /> {label}<input type="file" accept={accept} onChange={(e) => handleMediaUpload(kind, e)} className="hidden" /></label>{onDetachMedia && <button onClick={() => onDetachMedia(kind)} className="shrink-0 px-2 py-1.5 rounded glass-btn border-white/15 text-white/50 hover:text-red-300 transition cursor-pointer" title={t('editor.detachMedia')}><X size={11} /></button>}</div>))}</div></div>}
            </div>

            <button
              onClick={() => { runChartCheck(); setShowCheck(true); }}
              className="glass-btn w-full py-2.5 rounded-xl text-amber-200 font-bold flex items-center justify-center gap-2 border border-amber-400/30"
            >
              <AlertTriangle size={15} />
              {t('editor.chartCheck')}
            </button>
            {showCheck && (
              <div className="mt-2 rounded-xl glass-sub border-white/12 p-3 space-y-2">
                {checkRan && (
                  <div className="space-y-1 max-h-60 overflow-y-auto pr-1">
                    {checkIssues.length === 0 ? (
                      <div className="flex items-center gap-2 text-emerald-300 text-xs py-1">
                        <CheckCircle size={14} />
                        {t('editor.chartCheckNoIssue')}
                      </div>
                    ) : (
                      <>
                        <div className="text-[11px] text-amber-200 font-bold">
                          {t('editor.chartCheckIssueCount', { n: checkIssues.length })}
                        </div>
                        {checkIssues.map((issue, idx) => (
                          <button
                            key={idx}
                            onClick={() => jumpToIssue(issue)}
                            className="w-full text-left rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 p-2 transition cursor-pointer"
                          >
                            <div className="text-[10px] font-bold text-amber-300">{issue.cat}</div>
                            <div className="text-[11px] text-white/80 font-mono">{issue.detail}</div>
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                )}
                <button
                  onClick={() => setShowCheck(false)}
                  className="w-full py-1 rounded-lg bg-white/5 hover:bg-white/10 text-white/70 text-xs transition"
                >
                  {t('editor.chartCheckClose')}
                </button>
              </div>
            )}
            {/* 偏移变更的全量复检结果（§4.4）：防抖自动重算，列出越界音符与两种修复 */}
            {showOffsetIssues && offsetIssues.length > 0 && (
              <div className="mt-2 rounded-xl glass-sub border-pink-400/25 p-3 space-y-2">
                <div className="text-[11px] text-pink-200 font-bold">
                  {t('editor.offsetRecheckTitle', { n: offsetIssues.length })}
                </div>
                <div className="text-[9px] text-white/40 leading-snug">
                  {t('editor.offsetRecheckHint')}
                </div>
                <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
                  {offsetIssues.map((it, idx) => (
                    <div key={idx} className="rounded-lg bg-white/5 border border-white/10 p-2 space-y-1">
                      <button
                        onClick={() => { onSeekBeat(it.beat); onSelectNote(it.noteId); }}
                        className="w-full text-left cursor-pointer"
                      >
                        <div className="text-[10px] font-bold text-pink-300">
                          {it.nodeIdx === 0 ? t('editor.checkTypeNote') : t('editor.nodeN', { n: it.nodeIdx })}
                          {' '}{it.noteId}
                        </div>
                        <div className="text-[11px] text-white/80 font-mono">
                          x={it.landing.x.toFixed(2)}, y={it.landing.y.toFixed(2)}
                        </div>
                      </button>
                      <div className="flex gap-1">
                        <button
                          onClick={() => applyOffsetFix(it, 'keep')}
                          disabled={!it.keepBase}
                          className="flex-1 py-1 rounded bg-white/5 hover:bg-white/10 text-[10px] text-cyan-200 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {t('editor.offsetFixKeep')}
                        </button>
                        <button
                          onClick={() => applyOffsetFix(it, 'clamp')}
                          className="flex-1 py-1 rounded bg-white/5 hover:bg-white/10 text-[10px] text-cyan-200 transition cursor-pointer"
                        >
                          {t('editor.offsetFixClamp')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => setShowOffsetIssues(false)}
                  className="w-full py-1 rounded-lg bg-white/5 hover:bg-white/10 text-white/70 text-xs transition"
                >
                  {t('editor.chartCheckClose')}
                </button>
              </div>
            )}
            <button
              onClick={onSaveToLocal}
              className="glass-btn w-full py-2.5 rounded-xl text-cyan-200 font-bold"
            >
              {t('editor.saveToLocal')}
            </button>
            <button onClick={onExitEditor} className="glass-btn w-full py-2.5 rounded-xl text-white/80 font-bold">
              {t('editor.exitEditor')}
            </button>
          </div>
        )}
      </div>

      {/* 2. Draggable & Semi-Transparent Floating Note Chain Editor.
          Tap / Touch / Slide all share this chain-based editor: a chain is a
          head node plus optional child nodes, and the whole chain can be
          switched between the three note types.
          多选集合满足批量编辑条件时，此处改为显示“批量编辑”弹窗。 */}
      {selectedNote && !batchEditActive && (
        <div
          className="glass-panel-strong absolute pointer-events-auto border-cyan-400/40 rounded-2xl p-4 text-white z-40 w-[26rem] max-h-[50vh] overflow-y-auto select-none"
          style={{
            transform: `translate(${panelPos.x}px, ${panelPos.y}px)`,
            left: '24rem',
            top: '1rem',
          }}
        >
          <div className="flex items-center justify-between mb-3 border-b border-cyan-500/20 pb-2">
            <div className="flex items-center gap-2">
              {/* Drag Handle */}
              <div
                onPointerDown={onPanelPointerDown}
                className="w-5 h-5 flex items-center justify-center text-cyan-400/50 hover:text-cyan-400 active:text-cyan-300 cursor-grab active:cursor-grabbing mr-1 select-none shrink-0 animate-pulse"
                style={{ touchAction: 'none' }}
                title={t('editor.dragPanel')}
              >
                <Compass size={14} />
              </div>
              <span
                className={
                  selectedNote.type === 'touch'
                    ? 'w-3 h-3 border-2 border-cyan-300 rounded-full block'
                    : selectedNote.type === 'slide'
                      ? 'w-3 h-3 border-2 border-cyan-300 rotate-45 block'
                      : 'w-3 h-3 border-2 border-cyan-300 block'
                }
              />
              <span className="font-bold text-sm text-cyan-300 font-orbitron">{t('editor.noteChain')}</span>
              <span className="text-[10px] text-white/50 font-mono">#{selectedNote.id}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={cycleType}
                title={t('editor.cycleType')}
                className="flex items-center gap-1 rounded overflow-hidden border border-cyan-400/40 bg-cyan-500/20 px-2 py-0.5 text-[10px] font-bold text-white cursor-pointer hover:bg-cyan-500/35 transition"
              >
                <RefreshCw size={11} />
                {selectedNote.type === 'tap' ? '■ Tap' : selectedNote.type === 'touch' ? '● Touch' : '◆ Slide'}
              </button>
              <input
                type="color"
                value={selectedNote.color || chart.metadata.noteColor || '#00f0ff'}
                onChange={(e) => handleModifySelected({ color: e.target.value })}
                className="w-6 h-6 bg-transparent cursor-pointer rounded border border-cyan-400/40"
                title={t('editor.setChainColor')}
                onDoubleClick={() => handleModifySelected({ color: undefined })}
              />
              <button onClick={handleDeleteSelected} className="p-1.5 rounded-lg bg-red-950/60 border border-red-500/40 text-red-300 hover:bg-red-800 hover:text-white transition cursor-pointer" title={t('editor.deleteChain')}>
                <Trash2 size={14} />
              </button>
              <button onClick={() => onSelectNote(null)} className="p-1 text-white/50 hover:text-white">
                <X size={16} />
              </button>
            </div>
          </div>

          {/* 链属性（默认收起）：真实性三态（假音符一定不计分）/ 图层 / 坐标参考系 / 触发器 */}
          <div className="mb-1.5 rounded-lg glass-sub border-white/10">
            <button
              onClick={() => setChainPropsOpen(!chainPropsOpen)}
              className="w-full flex items-center justify-between px-2 py-1.5 text-[10px] text-white/60 hover:text-white/90 transition cursor-pointer"
            >
              <span>{t('editor.chainProps')}</span>
              <span className="text-cyan-300/80">{chainPropsOpen ? '−' : '+'}</span>
            </button>
            {chainPropsOpen && (
              <div className="p-2 pt-0 space-y-2">
                {/* 真实性三态：真（正常判定计分）/ 假（不判定不计分，纯视觉）/ 不计分（判定但不计分）。 */}
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-white/50 w-16 shrink-0">{t('editor.authenticity')}</span>
                  {(['real', 'fake', 'noScore'] as const).map((v) => {
                    const cur = selectedNote.fake ? 'fake' : selectedNote.noScore ? 'noScore' : 'real';
                    const on = cur === v;
                    const label = v === 'real' ? t('editor.note.real') : v === 'fake' ? t('editor.note.fake') : t('editor.note.noScore');
                    return (
                      <button
                        key={v}
                        onClick={() => handleModifySelected(
                          v === 'real' ? { fake: false, noScore: false } : v === 'fake' ? { fake: true, noScore: true } : { fake: false, noScore: true },
                        )}
                        className={`px-2 py-0.5 rounded text-[10px] border transition cursor-pointer ${on ? 'bg-white/20 border-white/50 text-white' : 'bg-transparent border-white/20 text-white/40 hover:text-white/70'}`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                {/* 图层（原头部下拉，移入链属性） */}
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-white/50 w-16 shrink-0">{t('editor.layer.moveTo')}</span>
                  <GlassDropdown<string>
                    value={selectedNote.layerId ?? ''}
                    options={[
                      { value: '', label: t('editor.layer.defaultRoot') },
                      ...layerList.map((l) => ({ value: l.id, label: l.name || l.id })),
                    ]}
                    onChange={(v) => handleModifySelected({ layerId: v || undefined })}
                    className="flex-1 min-w-0"
                  />
                </div>
                {/* 坐标参考系：屏幕坐标（默认，所见即所得）/ 基坐标（存储值，可越界） */}
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-white/50 w-16 shrink-0">{t('editor.coordFrame')}</span>
                  <GlassDropdown<'screen' | 'base'>
                    value={coordFrame}
                    options={[
                      { value: 'screen', label: t('editor.coordScreen') },
                      { value: 'base', label: t('editor.coordBase') },
                    ]}
                    onChange={setCoordFrame}
                    className="flex-1 min-w-0"
                  />
                </div>
                {/* 音符触发器（§3.4）：命中 / 漏掉时触发的事件。
                    MVP：每条只配一个内联动作；按判定等级细分与 { ref } 引用走 JSON。 */}
                <div className="space-y-1">
                  <div className="text-[10px] text-white/50">{t('editor.note.trigger')}</div>
            {(['hit', 'miss'] as const).map((kind) => {
              const evt = triggerEventOf(selectedNote, kind);
              const type = evt?.eventType ?? '';
              const setType = (v: string) => {
                if (!v) return setTriggerEvent(kind, undefined);
                if (v === 'text_display') return setTriggerEvent(kind, { eventType: 'text_display', text: evt?.text ?? 'Text' });
                if (v === 'note_color_change') return setTriggerEvent(kind, { eventType: 'note_color_change', noteColor: evt?.noteColor ?? '#ff2df7' });
                return setTriggerEvent(kind, { eventType: 'bg_change', gradientStart: evt?.gradientStart ?? '#050c1e', gradientEnd: evt?.gradientEnd ?? '#2d0a3e' });
              };
              return (
                <div key={kind} className="flex items-center gap-1.5">
                  <span className="text-[10px] text-white/50 w-8 shrink-0">
                    {kind === 'hit' ? t('editor.triggerOnHit') : t('editor.triggerOnMiss')}
                  </span>
                  <GlassDropdown<string>
                    value={type}
                    options={[
                      { value: '', label: t('editor.triggerNone') },
                      { value: 'text_display', label: t('editor.evt.text') },
                      { value: 'note_color_change', label: t('editor.evt.noteColor') },
                      { value: 'bg_change', label: t('editor.evt.bg') },
                    ]}
                    onChange={setType}
                  />
                  {type === 'text_display' && (
                    <input
                      type="text"
                      value={evt?.text ?? ''}
                      onChange={(e) => setTriggerEvent(kind, { eventType: 'text_display', text: e.target.value })}
                      className="flex-1 min-w-0 glass-input border border-white/12 rounded px-1 py-0.5 text-[10px]"
                    />
                  )}
                  {type === 'note_color_change' && (
                    <input
                      type="color"
                      value={evt?.noteColor ?? '#ff2df7'}
                      onChange={(e) => setTriggerEvent(kind, { eventType: 'note_color_change', noteColor: e.target.value })}
                      className="w-6 h-5 bg-transparent cursor-pointer rounded border border-white/20"
                    />
                  )}
                  {type === 'bg_change' && (
                    <>
                      <input
                        type="color"
                        value={evt?.gradientStart ?? '#050c1e'}
                        onChange={(e) => setTriggerEvent(kind, { eventType: 'bg_change', gradientStart: e.target.value, gradientEnd: evt?.gradientEnd ?? '#2d0a3e' })}
                        className="w-6 h-5 bg-transparent cursor-pointer rounded border border-white/20"
                      />
                      <input
                        type="color"
                        value={evt?.gradientEnd ?? '#2d0a3e'}
                        onChange={(e) => setTriggerEvent(kind, { eventType: 'bg_change', gradientStart: evt?.gradientStart ?? '#050c1e', gradientEnd: e.target.value })}
                        className="w-6 h-5 bg-transparent cursor-pointer rounded border border-white/20"
                      />
                    </>
                  )}
                </div>
              );
            })}
                </div>
              </div>
            )}
          </div>

          {/* Head node box — click anywhere in the row (text, padding) to select
              (first click) or seek (second click on the already-selected head).
              Clicks on inputs/buttons are ignored so editing never jumps.
              The angle/easing row is boxed INSIDE, exactly like child nodes. */}
          <div
            onClick={(e) => { const el = e.target as HTMLElement; if (el.tagName === 'INPUT' || el.tagName === 'BUTTON') return; handleNodeClick(selectedNote.id, selectedNote.beat); }}
            className={`grid grid-cols-12 gap-1.5 items-center p-2 rounded-lg mb-1.5 text-xs font-mono ${
              selectedNoteId === selectedNote.id ? 'bg-cyan-500/15 border border-cyan-400/50' : 'glass-sub border-white/10'
            }`}
          >
            <span className="col-span-2 text-white/70">{t('editor.headNode')}</span>
            <NumField
              value={liveDrag && liveDrag.id === selectedNote.id && liveDrag.beat !== undefined ? liveDrag.beat : selectedNote.beat}
              onCommit={(v) => handleModifySelected({ beat: v ?? 0 })}
              step={snapSubdivision}
              placeholder="0"
              className="col-span-3 glass-input border border-white/12 rounded px-1.5 py-0.5 text-cyan-300 w-full placeholder:text-white/25"
            />
            <NumField
              value={toFrameX(liveDrag && liveDrag.id === selectedNote.id ? liveDrag.x : selectedNote.x, selectedNote.layerId, selectedNote.beat)}
              onCommit={(v) => handleModifySelected({ x: toBaseX(v ?? 0, selectedNote.layerId, selectedNote.beat) })}
              step={0.1}
              {...(coordFrame === 'screen' ? { min: -2.4, max: 2.4 } : {})}
              placeholder="0"
              className="col-span-3 glass-input border border-white/12 rounded px-1.5 py-0.5 text-cyan-300 w-full placeholder:text-white/25"
            />
            <NumField
              value={toFrameY(liveDrag && liveDrag.id === selectedNote.id ? liveDrag.y : selectedNote.y, selectedNote.layerId, selectedNote.beat)}
              onCommit={(v) => handleModifySelected({ y: toBaseY(v ?? 0, selectedNote.layerId, selectedNote.beat) })}
              step={0.1}
              {...(coordFrame === 'screen' ? { min: -1.5, max: 1.5 } : {})}
              placeholder="0"
              className="col-span-3 glass-input border border-white/12 rounded px-1.5 py-0.5 text-cyan-300 w-full placeholder:text-white/25"
            />
            <button
              onClick={(e) => { e.stopPropagation(); handleRemoveHeadNode(); }}
              className="col-span-1 flex justify-center text-red-400 hover:text-red-300 cursor-pointer"
              title={t('editor.deleteHeadNode')}
            >
              <Trash2 size={13} />
            </button>
            {/* Angle + easing for the head (global default). Boxed inside the node.
                Shown only when the head is the selected node. */}
            {selectedNoteId === selectedNote.id && (
              <AngleEasingRow
                labelAngle={t('editor.angle')}
                labelEasing={t('editor.easing')}
                angle={selectedNote.angle ?? null}
                easing={selectedNote.easing ?? 'default'}
                onAngle={(v) => handleModifySelected({ angle: v ?? undefined })}
                onEasing={(v) => handleModifySelected({ easing: v === 'default' ? undefined : v })}
              />
            )}
          </div>

          {/* Child node rows — click anywhere in the row (text, padding) to select
              (first click) or seek (second click). Inputs/buttons are ignored, and
              the delete button stops propagation. */}
          {(selectedNote.nodes ?? []).map((sn, i) => {
            const cl = liveDrag && liveDrag.id === `${selectedNote.id}#${i + 1}` ? liveDrag : null;
            return (
            <div
              key={i}
              onClick={(e) => { const el = e.target as HTMLElement; if (el.tagName === 'INPUT' || el.tagName === 'BUTTON') return; handleNodeClick(`${selectedNote.id}#${i + 1}`, sn.beat); }}
              className={`grid grid-cols-12 gap-1.5 items-center p-2 rounded-lg mb-1.5 text-xs font-mono ${
                selectedNoteId === `${selectedNote.id}#${i + 1}` ? 'bg-cyan-500/15 border border-cyan-400/50' : 'glass-sub border-white/10'
              }`}
            >
              <span className="col-span-2 text-white/70">{t('editor.nodeN', { n: i + 1 })}</span>
              <NumField
                value={cl && cl.beat !== undefined ? cl.beat : sn.beat}
                onCommit={(v) => handlePatchSlideNode(i, { beat: v ?? 0 })}
                step={snapSubdivision}
                placeholder="0"
                className="col-span-3 glass-input border border-white/12 rounded px-1.5 py-0.5 text-cyan-300 w-full placeholder:text-white/25"
              />
              <NumField
                value={toFrameX(cl ? cl.x : sn.x, selectedNote.layerId, sn.beat)}
                onCommit={(v) => handlePatchSlideNode(i, { x: toBaseX(v ?? 0, selectedNote.layerId, sn.beat) })}
                step={0.1}
                {...(coordFrame === 'screen' ? { min: -2.4, max: 2.4 } : {})}
                placeholder="0"
                className="col-span-3 glass-input border border-white/12 rounded px-1.5 py-0.5 text-cyan-300 w-full placeholder:text-white/25"
              />
              <NumField
                value={toFrameY(cl ? cl.y : sn.y, selectedNote.layerId, sn.beat)}
                onCommit={(v) => handlePatchSlideNode(i, { y: toBaseY(v ?? 0, selectedNote.layerId, sn.beat) })}
                step={0.1}
                {...(coordFrame === 'screen' ? { min: -1.5, max: 1.5 } : {})}
                placeholder="0"
                className="col-span-3 glass-input border border-white/12 rounded px-1.5 py-0.5 text-cyan-300 w-full placeholder:text-white/25"
              />
              <button
                onClick={(e) => { e.stopPropagation(); handleRemoveSlideNode(i); }}
                className="col-span-1 flex justify-center text-red-400 hover:text-red-300 cursor-pointer"
              >
                <Trash2 size={13} />
              </button>
              {/* Angle + easing for this node, shown only when it is selected.
                  Empty = 缺省(inherits head → 0); 'default' = inherits head → linear. */}
              {selectedNoteId === `${selectedNote.id}#${i + 1}` && (
                <AngleEasingRow
                  labelAngle={t('editor.angle')}
                  labelEasing={t('editor.easing')}
                  angle={sn.angle ?? null}
                  easing={sn.easing ?? 'default'}
                  onAngle={(v) => handlePatchSlideNode(i, { angle: v ?? undefined })}
                  onEasing={(v) => handlePatchSlideNode(i, { easing: v === 'default' ? undefined : v })}
                />
              )}
            </div>
            );
          })}

          <div className="grid grid-cols-12 gap-1.5 text-[10px] text-white/40 font-mono px-2 mb-2">
            <span className="col-span-2" />
            <span className="col-span-3">Beat</span>
            <span className="col-span-3">X·{coordFrame === 'screen' ? t('editor.coordScreen') : t('editor.coordBase')}</span>
            <span className="col-span-3">Y·{coordFrame === 'screen' ? t('editor.coordScreen') : t('editor.coordBase')}</span>
            <span className="col-span-1" />
          </div>

          <button
            onClick={handleAddSlideNode}
            className="w-full py-1.5 rounded-lg border-2 border-dashed border-cyan-500/40 hover:bg-cyan-500/10 text-cyan-300 font-bold text-xs transition cursor-pointer flex items-center justify-center gap-1"
          >
            <Plus size={13} /> {t('editor.appendNode')}
          </button>
        </div>
      )}

      {/* 2b. Batch Edit Panel — shown when the batch-edit condition is active.
          Reuses the same draggable container as the note chain editor. */}
      {batchEditActive && (() => {
        const batchOpOptions: Array<{ value: BatchOp; label: string }> = [
          { value: 'ToTap', label: t('editor.opToTap') },
          { value: 'ToTouch', label: t('editor.opToTouch') },
          { value: 'ToSlide', label: t('editor.opToSlide') },
          { value: 'MkChain', label: t('editor.opMkChain') },
          { value: 'SplitChain', label: t('editor.opSplitChain') },
          { value: 'FillL', label: t('editor.opFillL') },
          { value: 'FillSI', label: t('editor.opFillSI') },
          { value: 'FillSO', label: t('editor.opFillSO') },
          { value: 'FillSIO', label: t('editor.opFillSIO') },
          { value: 'FlipX', label: t('editor.flipX') },
          { value: 'FlipY', label: t('editor.flipY') },
          { value: 'UseRule', label: t('editor.opUseRule') },
        ];
        const marqueeOptions: Array<{ value: MarqueeMode; label: string }> = [
          { value: 'normal', label: t('editor.mmNormal') },
          { value: 'add', label: t('editor.mmAdd') },
          { value: 'subtract', label: t('editor.mmSubtract') },
          { value: 'intersect', label: t('editor.mmIntersect') },
        ];
        return (
          <div
            className="glass-panel-strong absolute pointer-events-auto border-amber-400/40 rounded-2xl p-4 text-white z-40 w-[24rem] select-none"
            style={{
              transform: `translate(${panelPos.x}px, ${panelPos.y}px)`,
              left: '24rem',
              top: '1rem',
            }}
          >
            <div className="flex items-center justify-between mb-3 border-b border-amber-500/20 pb-2">
              <div className="flex items-center gap-2">
                <div
                  onPointerDown={onPanelPointerDown}
                  className="w-5 h-5 flex items-center justify-center text-amber-400/50 hover:text-amber-400 active:text-amber-300 cursor-grab active:cursor-grabbing mr-1 select-none shrink-0 animate-pulse"
                  style={{ touchAction: 'none' }}
                  title={t('editor.dragPanel')}
                >
                  <Compass size={14} />
                </div>
                <BoxSelect size={14} className="text-amber-300" />
                <span className="font-bold text-sm text-amber-300 font-orbitron">{t('editor.batchEdit')}</span>
                <span className="text-[10px] text-white/50 font-mono">
                  {t('editor.batchSelected', { n: selectedUnits.length })}
                </span>
              </div>
              <button onClick={() => onSelectNotes(null)} className="p-1 text-white/50 hover:text-white">
                <X size={16} />
              </button>
            </div>

            {/* 功能下拉 + 执行按钮 */}
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] text-white/60 font-mono shrink-0">{t('editor.batchOp')}</span>
              <BatchOpStateful
                value={batchOp}
                options={batchOpOptions}
                onSelect={(op) => setBatchOp(op)}
                onExecute={(op) => applyBatchOp(op)}
                executeLabel={t('editor.execute')}
              />
            </div>

            {/* 克隆 / 删除动作按钮 */}
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={() => applyBatchOp('Clone')}
                disabled={selectedUnits.length < 1}
                className="flex-1 py-1 rounded-lg glass-btn border-emerald-400/40 text-emerald-300 hover:text-emerald-200 flex items-center justify-center gap-1.5 font-bold transition cursor-pointer text-[11px] disabled:opacity-40 disabled:cursor-not-allowed"
                title={t('editor.cloneTitle')}
              >
                <Copy size={12} /> {t('editor.clone')}
              </button>
              <button
                onClick={() => handlePanelBatchDelete()}
                disabled={selectedUnits.length < 1}
                className={`flex-1 py-1 rounded-lg glass-btn flex items-center justify-center gap-1.5 font-bold transition text-[11px] disabled:opacity-40 disabled:cursor-not-allowed ${
                  deleteArmed
                    ? 'border-red-400/70 bg-red-500/30 text-red-100'
                    : 'border-red-400/40 text-red-300 hover:text-red-200'
                }`}
                title={t('editor.deleteNote')}
              >
                <Trash2 size={12} /> {deleteArmed ? t('editor.confirmQ') : t('editor.delete')}
              </button>
            </div>

            {/* 框选方式下拉（仅 2D） */}
            {viewMode === '2d' && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-white/60 font-mono shrink-0">{t('editor.marqueeMode')}</span>
                <GlassDropdown
                  value={marqueeMode}
                  options={marqueeOptions}
                  onChange={(m) => onSetMarqueeMode(m)}
                  className="flex-1"
                  accent="amber"
                />
              </div>
            )}
          </div>
        );
      })()}

      {/* 3. Draggable & Semi-Transparent Right Scrub & Snap Panel */}
      <div
        className="glass-panel absolute pointer-events-auto border-white/15 rounded-2xl p-2.5 flex flex-col items-center gap-2 z-30 transition-colors select-none"
        style={{
          transform: `translate(${snappingPos.x}px, ${snappingPos.y}px)`,
          right: '1rem',
          top: '25%',
        }}
      >
        <div
          onPointerDown={onSnapPointerDown}
          className="w-full h-3 flex items-center justify-center text-cyan-400/40 hover:text-cyan-400 active:text-cyan-300 cursor-grab active:cursor-grabbing border-b border-white/10 pb-1 select-none animate-pulse shrink-0"
          style={{ touchAction: 'none' }}
          title={t('editor.snapFine')}
        >
          <Compass size={12} />
        </div>

        <div className="relative w-full flex flex-col items-center">
          <GlassDropdown<string>
            value={String(RATE_OPTIONS.find((o) => Math.abs(o.value - playbackRate) < 0.00001)?.value ?? '1')}
            options={RATE_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
            onChange={(v) => onSetPlaybackRate(parseFloat(v))}
            trigger={RATE_OPTIONS.find((o) => Math.abs(o.value - playbackRate) < 0.00001)?.label ?? '1x'}
            triggerClassName={`min-w-16 px-3 py-2 rounded-xl glass-btn border-cyan-400/40 text-cyan-200 font-mono font-black text-sm hover:text-cyan-100 transition cursor-pointer shadow-lg shadow-cyan-500/10 ${playbackRate !== 1 ? 'ring-1 ring-cyan-400/60' : ''}`}
            triggerTitle={t('editor.rateBtn')}
            align="right"
            panelClassName="w-28 p-1.5 space-y-1"
          />
        </div>

        <div className="relative w-full flex flex-col items-center mt-2">
          <GlassDropdown<string>
            value={String(SNAP_CHOICES.find((o) => Math.abs(o.val - snapSubdivision) < 0.00001)?.val ?? '')}
            options={SNAP_CHOICES.map((o) => ({
              value: String(o.val),
              label: o.val === 0.01 ? t('editor.free') : `${o.label} ${beatUnit}`,
            }))}
            onChange={(v) => onSetSnapSubdivision(parseFloat(v))}
            trigger={SNAP_CHOICES.find((o) => Math.abs(o.val - snapSubdivision) < 0.00001)?.label ?? t('editor.snap')}
            triggerClassName="min-w-16 px-3 py-2 rounded-xl glass-btn border-cyan-400/40 text-cyan-200 font-mono font-black text-sm hover:text-cyan-100 transition cursor-pointer shadow-lg shadow-cyan-500/10"
            triggerTitle={t('editor.snapBtn')}
            align="right"
            panelClassName="w-28 p-1.5 space-y-1"
          />
        </div>

        <div className="text-[9px] text-white/40 font-mono leading-none mt-0.5">{t('editor.tune')}</div>
        <LiveBeatGate>{(beat) => (<>
        <button
          onClick={() => onSeekBeat(Math.floor((beat - 1e-6) / snapSubdivision) * snapSubdivision)}
          className="w-10 h-10 rounded-xl glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 flex items-center justify-center font-bold text-sm transition cursor-pointer"
          title={t('editor.snapPrev')}
        >
          ▲ -
        </button>

        <div className="text-xs font-mono font-bold text-amber-300 py-0.5">
          {beat.toFixed(2)}
        </div>

        <button
          onClick={() => onSeekBeat(Math.ceil((beat + 1e-6) / snapSubdivision) * snapSubdivision)}
          className="w-10 h-10 rounded-xl glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 flex items-center justify-center font-bold text-sm transition cursor-pointer"
          title={t('editor.snapNext')}
        >
          ▼ +
        </button>
        </>)}</LiveBeatGate>
      </div>

      {/* 4. Bottom Timeline Scrub Bar (Adjusts left offset based on expanded sidebar state to avoid overlap) */}
      {/* 左偏移用内联样式而非 left-[21rem] 任意值类：避免 Tailwind JIT 未编译
       * 新增任意值类时 left 失效（退化为右锚定+内容收缩宽度）。21rem=20rem(w-80)+1rem，
       * 4rem=3rem(w-12)+1rem，两种状态下与侧边栏的间隙恒为 1rem。 */}
      <div
        className="glass-panel-strong absolute bottom-4 right-16 pointer-events-auto border-white/15 rounded-2xl px-3 py-1.5 z-30 flex items-center gap-3 transition-all duration-300"
        style={{ left: isSidebarExpanded ? '21rem' : '4rem' }}
      >
        <button
          onClick={onTogglePlay}
          className="w-10 h-10 rounded-xl glass-btn-primary flex items-center justify-center hover:scale-105 active:scale-95 transition cursor-pointer shrink-0"
        >
          {isPlaying ? <Pause size={18} /> : <Play size={18} />}
        </button>

        {/* 拍数与总长已画进条内，此处不再占独立信息行（见 EditorHeatScrubber）。 */}
        <div className="flex-1 min-w-0 self-stretch">
          <EditorHeatScrubber
            chart={chart}
            maxBeat={maxBeat}
            snapSubdivision={snapSubdivision}
            onSeek={onSeekBeat}
          />
        </div>
      </div>
    </div>
  );
};

// === Event Row Sub-component ===
interface EventRowProps {
  event: EventData;
  onSeek: () => void;
  onUpdate: (updates: Partial<EventData>) => void;
  onDelete: () => void;
}

const EventRow: React.FC<EventRowProps> = ({ event, onSeek, onUpdate, onDelete }) => {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();

  const typeLabel: Record<EventType, string> = {
    speed_change: t('editor.evt.speed'),
    text_display: t('editor.evt.text'),
    note_color_change: t('editor.evt.noteColor'),
    bg_change: t('editor.evt.bg'),
    offset_change: t('editor.evt.offset'),
  };

  const typeColor: Record<EventType, { border: string; text: string }> = {
    speed_change: { border: 'border-purple-400/40', text: 'text-purple-300 hover:text-purple-200' },
    text_display: { border: 'border-amber-400/40', text: 'text-amber-300 hover:text-amber-200' },
    note_color_change: { border: 'border-cyan-400/40', text: 'text-cyan-300 hover:text-cyan-200' },
    bg_change: { border: 'border-cyan-400/40', text: 'text-cyan-300 hover:text-emerald-200' },
    offset_change: { border: 'border-pink-400/40', text: 'text-pink-300 hover:text-pink-200' },
  };

  const color = typeColor[event.eventType];

  return (
    <div className={`glass-sub rounded border ${color.border} overflow-hidden`}>
      <div className="flex items-center gap-1.5 px-2 py-1">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[10px] text-white/50 hover:text-white w-4 text-center"
        >
          {expanded ? '−' : '+'}
        </button>
        <button
          onClick={onSeek}
          className={`text-[10px] font-mono ${color.text} flex-1 text-left truncate`}
          title={t('editor.jumpToBeat')}
        >
          B{(event.beat ?? 0).toFixed(2)} · {typeLabel[event.eventType]}
        </button>
        <button
          onClick={onDelete}
          className="text-[10px] text-red-400 hover:text-red-300"
          title={t('editor.deleteEvent')}
        >
          <X size={12} />
        </button>
      </div>
      {expanded && (
        <div className="px-2 pb-2 space-y-1.5 border-t border-white/10">
          <div>
            <label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fieldBeat')}</label>
            <NumField
              value={event.beat}
              placeholder="0"
              step="0.25"
              onCommit={(v) => onUpdate({ beat: v ?? 0 })}
              className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200 text-xs font-mono"
            />
          </div>
          {event.eventType === 'speed_change' && (
            <div>
              <label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fieldSpeed')}</label>
              <NumField
                value={event.speed}
                placeholder="1"
                step="any"
                min={0.1}
                max={5}
                onCommit={(v) => onUpdate({ speed: v ?? undefined })}
                className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200 text-xs font-mono"
              />
            </div>
          )}
          {event.eventType === 'speed_change' && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fieldSpeedTrans')}</label>
                  <NumField
                    value={event.duration ?? 0}
                    placeholder="0"
                    step="any"
                    min={0}
                    onCommit={(v) => onUpdate({ duration: Math.max(0, v ?? 0) })}
                    className="w-full glass-input border border-white/12 rounded px-2 py-1 text-purple-200 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fieldEasing')}</label>
                  <GlassDropdown<EasingType>
                    value={event.easing ?? 'linear'}
                    options={EASING_TYPES.map((es) => ({ value: es, label: es }))}
                    onChange={(v) => onUpdate({ easing: v })}
                  />
                </div>
              </div>
              <p className="text-[9px] text-white/40 leading-snug">{t('editor.speedTransHint')}</p>
            </>
          )}
          {event.eventType === 'text_display' && (
            <>
              <div>
                <label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fieldText')}</label>
                <input
                  type="text"
                  value={event.text ?? ''}
                  onChange={(e) => onUpdate({ text: e.target.value })}
                  className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200 text-xs"
                />
              </div>
              <div>
                <label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fieldDuration')}</label>
                <NumField
                  value={event.textDuration}
                  placeholder="2"
                  step="0.5"
                  min={0}
                  onCommit={(v) => onUpdate({ textDuration: v ?? undefined })}
                  className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200 text-xs font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fieldX')}</label>
                  <NumField
                    value={event.x}
                    placeholder="0"
                    step="any"
                    onCommit={(v) => onUpdate({ x: v ?? undefined })}
                    className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fieldY')}</label>
                  <NumField
                    value={event.y}
                    placeholder="-0.33"
                    step="any"
                    onCommit={(v) => onUpdate({ y: v ?? undefined })}
                    className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200 text-xs font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fieldFontSize')}</label>
                  <NumField
                    value={event.fontSize}
                    placeholder="36"
                    step="2"
                    min={8}
                    max={120}
                    onCommit={(v) => onUpdate({ fontSize: v ?? undefined })}
                    className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fieldTextColor')}</label>
                  <input
                    type="color"
                    value={event.color || '#ffffff'}
                    onChange={(e) => onUpdate({ color: e.target.value })}
                    className="w-full h-7 bg-transparent cursor-pointer"
                  />
                </div>
              </div>
            </>
          )}
          {event.eventType === 'note_color_change' && (
            <div>
              <label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fieldNoteColor')}</label>
              <input
                type="color"
                value={event.noteColor || '#00f0ff'}
                onChange={(e) => onUpdate({ noteColor: e.target.value })}
                className="w-full h-7 bg-transparent cursor-pointer"
              />
            </div>
          )}
          {event.eventType === 'bg_change' && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fieldBgStart')}</label>
                  <input
                    type="color"
                    value={event.gradientStart || '#050c1e'}
                    onChange={(e) => onUpdate({ gradientStart: e.target.value })}
                    className="w-full h-7 bg-transparent cursor-pointer"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fieldBgEnd')}</label>
                  <input
                    type="color"
                    value={event.gradientEnd || '#1b072c'}
                    onChange={(e) => onUpdate({ gradientEnd: e.target.value })}
                    className="w-full h-7 bg-transparent cursor-pointer"
                  />
                </div>
              </div>
              {/* bg_change 只改渐变色；媒体背景由歌曲目录约定文件提供，事件不再切换。 */}
            </>
          )}
          {event.eventType === 'offset_change' && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fieldOffsetX')}</label>
                  <NumField
                    value={event.offsetX ?? 0}
                    placeholder="0"
                    step="any"
                    onCommit={(v) => onUpdate({ offsetX: v ?? 0 })}
                    className="w-full glass-input border border-white/12 rounded px-2 py-1 text-pink-200 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fieldOffsetY')}</label>
                  <NumField
                    value={event.offsetY ?? 0}
                    placeholder="0"
                    step="any"
                    onCommit={(v) => onUpdate({ offsetY: v ?? 0 })}
                    className="w-full glass-input border border-white/12 rounded px-2 py-1 text-pink-200 text-xs font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fieldTransDuration')}</label>
                  <NumField
                    value={event.duration ?? 0}
                    placeholder="0"
                    step="any"
                    min={0}
                    onCommit={(v) => onUpdate({ duration: Math.max(0, v ?? 0) })}
                    className="w-full glass-input border border-white/12 rounded px-2 py-1 text-pink-200 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-white/50 block mb-0.5">{t('editor.fieldEasing')}</label>
                  <GlassDropdown<EasingType>
                    value={event.easing ?? 'linear'}
                    options={EASING_TYPES.map((es) => ({ value: es, label: es }))}
                    onChange={(v) => onUpdate({ easing: v })}
                  />
                </div>
              </div>
              <p className="text-[9px] text-white/40 leading-snug">{t('editor.offsetHint')}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
};
