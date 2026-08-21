import React, { useState, useRef, useEffect } from 'react';
import { cssVars } from '../utils/style';
import { createPortal } from 'react-dom';
import { ChartData, NoteData, EventData, EventType, BpmPoint, EasingType, NoteType, SlideNodeData, NOTE_X_RANGE, NOTE_Y_RANGE } from '../types/game';
import { exportChartJson, parseAndValidateChart } from '../utils/chartParser';
import { countPlayableNotes, getMaxBeat, beatToSecondsMultiBpm } from '../utils/beatTime';
import { EASING_TYPES, EASING_FNS } from '../utils/easing';
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
} from 'lucide-react';
import { useI18n } from '../i18n';
import { lintDsl, applyDslToNote } from '../utils/editorRules';
import { useLiveDrag } from '../liveDragStore';

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
  currentBeat: number;
  currentTimeSec: number;
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

/** Self-styled frosted-glass dropdown for the easing value (no native <select>,
 *  so it follows the editor's dark glass theme). Includes a "default" option
 *  that removes the key (inherits the head node's value). The popup is rendered
 *  through a portal to <body> with fixed positioning so it FLOATS above the
 *  editor panel (which has overflow/transform and would otherwise clip/resize it). */
const EasingSelect: React.FC<{
  value: EasingType | 'default';
  onChange: (v: EasingType | 'default') => void;
}> = ({ value, onChange }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!open) return;
    setRect(btnRef.current?.getBoundingClientRect() ?? null);
    // Close on page scroll/resize: the panel can move, and since we position
    // against the viewport the menu would otherwise detach from the trigger.
    // Ignore the popup's own internal scroll (otherwise the list disappears
    // when the user tries to scroll it).
    const close = (e?: Event) => {
      const t = (e?.target as Node | null) ?? null;
      if (t && popRef.current && popRef.current.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  const options: Array<{ value: EasingType | 'default'; label: string }> = [
    { value: 'default', label: t('editor.default') },
    ...EASING_TYPES.map((et) => ({ value: et, label: et })),
  ];
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <div className="col-span-4 relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full glass-input border rounded px-1.5 py-0.5 text-amber-300 text-left cursor-pointer flex items-center justify-between ${
          open ? 'border-cyan-400/60' : 'border-white/12'
        }`}
      >
        <span>{current.label}</span>
        <span className="text-white/40 text-[9px]">▾</span>
      </button>
      {open && rect &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[60]" onMouseDown={() => setOpen(false)} />
            <div
              ref={popRef}
              className="fixed z-[61] glass-panel-strong rounded-xl border-white/15 p-1 space-y-0.5 max-h-44 overflow-y-auto"
              style={{ left: rect.left, top: rect.bottom + 4, minWidth: rect.width }}
            >
              {options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => { onChange(o.value); setOpen(false); }}
                  className={`w-full text-left px-2 py-1.5 rounded-lg text-[11px] font-mono transition cursor-pointer ${
                    o.value === value
                      ? 'bg-cyan-500/25 text-cyan-200'
                      : 'text-white/70 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
};

/** Generic frosted-glass dropdown (portal-based, same pattern as EasingSelect).
 *  Used by the batch-edit panel for the function selector and marquee mode. */
function GlassDropdown<T extends string>({
  value,
  options,
  onChange,
  className,
  accent = 'cyan',
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  className?: string;
  accent?: 'cyan' | 'amber';
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!open) return;
    setRect(btnRef.current?.getBoundingClientRect() ?? null);
    // 关闭下拉：页面滚动 / 窗口缩放时关闭；但忽略下拉自身列表滚动
    // （避免“滚动到底部时下拉直接消失”）。
    const close = (e?: Event) => {
      const t = (e?.target as Node | null) ?? null;
      if (t && popRef.current && popRef.current.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  const current = options.find((o) => o.value === value) ?? options[0];
  const textCls = accent === 'amber' ? 'text-amber-300' : 'text-cyan-300';
  const selCls = accent === 'amber' ? 'bg-amber-500/25 text-amber-200' : 'bg-cyan-500/25 text-cyan-200';
  return (
    <div className={`relative ${className ?? ''}`}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full glass-input border rounded px-1.5 py-0.5 ${textCls} text-left cursor-pointer flex items-center justify-between text-[11px] font-mono ${
          open ? (accent === 'amber' ? 'border-amber-400/60' : 'border-cyan-400/60') : 'border-white/12'
        }`}
      >
        <span className="truncate">{current?.label}</span>
        <span className="text-white/40 text-[9px] shrink-0">▾</span>
      </button>
      {open && rect &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[60]" onMouseDown={() => setOpen(false)} />
            <div
              ref={popRef}
              className="fixed z-[61] glass-panel-strong rounded-xl border-white/15 p-1 space-y-0.5 max-h-52 overflow-y-auto"
              style={{ left: rect.left, top: rect.bottom + 4, width: rect.width, minWidth: 120, maxWidth: 260 }}
            >
              {options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => { onChange(o.value); setOpen(false); }}
                  className={`w-full text-left px-2 py-1.5 rounded-lg text-[11px] font-mono transition cursor-pointer ${
                    o.value === value
                      ? selCls
                      : 'text-white/70 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  <span className="block truncate">{o.label}</span>
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

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



export const VisualChartEditor: React.FC<VisualChartEditorProps> = ({
  chart,
  currentBeat,
  currentTimeSec,
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
  onStartPlayTest,
  viewMode,
  onSetViewMode,
  preview3D,
  onTogglePreview3D,
  onApplyQuickCreateDelta: _onApplyQuickCreateDelta,
  editorDsl,
  onEditorDslChange,
}) => {
  const { t, lang } = useI18n();
  const beatUnit = lang === 'en' ? 'beat' : '拍';
  const ruleErrors = lintDsl(editorDsl);
  // onApplyQuickCreateDelta is wired up from the parent so GameCanvas can
  // push its batch-note payloads through the same prop surface even though
  // the overlay component itself never fires it. Silence "unused variable".
  void _onApplyQuickCreateDelta;
  const [isSidebarExpanded, setIsSidebarExpanded] = useState(true);
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [snapMenuOpen, setSnapMenuOpen] = useState(false);
  const [rateMenuOpen, setRateMenuOpen] = useState(false);

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
    events: false,
    rules: false,
    metadata: false,
    timing: false,
    batch: false,
    importExport: false,
  });

  // ----- Chart integrity check -----
  type CheckKind = 'negativeBeat' | 'chainOrder' | 'coordRange';
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
  const [checkIssues, setCheckIssues] = useState<CheckIssue[]>([]);
  const [showCheck, setShowCheck] = useState(false);
  const [checkRan, setCheckRan] = useState(false);

  const runChartCheck = () => {
    const issues: CheckIssue[] = [];
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
      if (note.x < X_MIN - 1e-6 || note.x > X_MAX + 1e-6 || note.y < Y_MIN - 1e-6 || note.y > Y_MAX + 1e-6) {
        issues.push({
          kind: 'coordRange',
          cat: t('editor.checkCatCoord'),
          detail: `${t('editor.checkTypeNote')} ${note.id} · x=${note.x.toFixed(2)}, y=${note.y.toFixed(2)}`,
          targetBeat: note.beat,
          targetId: note.id,
        });
      }
      if (note.nodes && note.nodes.length) {
        let prevBeat = note.beat;
        let prevLabel = t('editor.headNode');
        for (let i = 0; i < note.nodes.length; i++) {
          const sn = note.nodes[i];
          if (sn.beat < prevBeat - 1e-6) {
            issues.push({
              kind: 'chainOrder',
              cat: t('editor.checkCatChainOrder'),
              detail: `${t('editor.checkTypeNote')} ${note.id} · ${t('editor.nodeN', { n: i + 1 })} (${t('editor.beat')} ${sn.beat.toFixed(2)}) < ${prevLabel} (${prevBeat.toFixed(2)})`,
              targetBeat: sn.beat,
              targetId: note.id,
            });
          }
          prevBeat = sn.beat;
          prevLabel = `${t('editor.nodeN', { n: i + 1 })}`;
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
    issues.sort((a, b) => a.targetBeat - b.targetBeat);
    setCheckIssues(issues);
    setCheckRan(true);
    setShowCheck(true);
  };

  const jumpToIssue = (issue: CheckIssue) => {
    onSeekBeat(issue.targetBeat);
    if (issue.targetId) onSelectNote(issue.targetId);
    setShowCheck(false);
  };

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
  const selectedNote = chart.notes.find((n) => n.id === selectedBaseId);

  // Live-drag override: while a note is being dragged (in 2D or 3D) the canvas
  // pushes the current position here every frame so these input boxes show the
  // real-time value without waiting for the throttled/on-release chart commit.
  // Subscribing only re-renders this panel — App and the canvases stay untouched.
  const liveDrag = useLiveDrag();

  const maxBeat = Math.max(16, getMaxBeat(chart)) + 4;

  const validBatchRange =
    batchSelection.startBeat !== null && batchSelection.endBeat !== null
      ? {
          start: Math.min(batchSelection.startBeat, batchSelection.endBeat),
          end: Math.max(batchSelection.startBeat, batchSelection.endBeat),
        }
      : null;

  const notesInBatch = validBatchRange
    ? chart.notes.filter((n) => n.beat >= validBatchRange.start - 0.001 && n.beat <= validBatchRange.end + 0.001)
    : [];

  const handleUpdateMeta = (field: 'bpm' | 'offset', value: number) => {
    onUpdateChart({ ...chart, metadata: { ...chart.metadata, [field]: value } });
  };

  // ---- BPM List Editing Helpers ----
  const getBpmList = (): BpmPoint[] => chart.metadata.bpmlist ?? [];

  const handleAddBpmPoint = () => {
    const snappedBeat = Math.round(currentBeat / snapSubdivision) * snapSubdivision;
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

  // ---- Event Editing Helpers ----
  const getEvents = (): EventData[] => chart.events ?? [];

  const handleAddEvent = (type: EventType) => {
    const snappedBeat = Math.round(currentBeat / snapSubdivision) * snapSubdivision;
    const newEvent: EventData = {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'event',
      eventType: type,
      beat: snappedBeat,
      ...(type === 'speed_change' ? { speed: 1.0 } : {}),
      ...(type === 'text_display' ? { text: 'New Text', textDuration: 2 } : {}),
      ...(type === 'note_color_change' ? { noteColor: '#00f0ff' } : {}),
      ...(type === 'bg_change' ? { gradientStart: '#050c1e', gradientEnd: '#1b072c' } : {}),
    };
    const events = [...getEvents(), newEvent].sort((a, b) => a.beat - b.beat);
    onUpdateChart({ ...chart, events });
  };

  const handleUpdateEvent = (id: string, updates: Partial<EventData>) => {
    const events = getEvents()
      .map((e) => (e.id === id ? { ...e, ...updates } : e))
      .sort((a, b) => a.beat - b.beat);
    onUpdateChart({ ...chart, events });
  };

  const handleDeleteEvent = (id: string) => {
    const events = getEvents().filter((e) => e.id !== id);
    onUpdateChart({ ...chart, events: events.length > 0 ? events : undefined });
  };

  // 起点/终点按谱师点击的顺序原样保留，不做数值调转（否则谱师先点终点再点起点时，
  // 界面上的起/终点会被偷偷对调，容易困惑）。实际操作区间由 validBatchRange 用
  // Math.min/max 归一化，所以 start>end 时仍按 [end,start] 执行。
  const handleSetBatchStart = () => {
    const newStart = Math.round(currentBeat * 100) / 100;
    onSetBatchSelection({ startBeat: newStart, endBeat: batchSelection.endBeat });
  };

  const handleSetBatchEnd = () => {
    const newEnd = Math.round(currentBeat * 100) / 100;
    onSetBatchSelection({ startBeat: batchSelection.startBeat, endBeat: newEnd });
  };

  const handleBatchClone = () => {
    if (!validBatchRange || notesInBatch.length === 0) return;
    const deltaBeat = currentBeat - validBatchRange.start;

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
    const updatedNotes = chart.notes.map((n) => {
      if (!ruleIds.has(n.id)) return n;
      const applied = applyDslToNote(n, dsl);
      if (!n.nodes || n.nodes.length === 0) return applied;
      // 子节点逐个应用 DSL（以自身位置 + 头节点缺省参数构造临时 note）。
      const nodes = n.nodes.map((sn) => {
        const tmp = applyDslToNote(
          { ...applied, beat: sn.beat, x: sn.x, y: sn.y, angle: sn.angle ?? applied.angle, easing: sn.easing ?? applied.easing, nodes: undefined },
          dsl,
        );
        const out: SlideNodeData = {
          beat: tmp.beat,
          x: Math.max(-NOTE_X_RANGE, Math.min(NOTE_X_RANGE, tmp.x)),
          y: Math.max(-NOTE_Y_RANGE, Math.min(NOTE_Y_RANGE, tmp.y)),
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
      const dBeat = currentBeat - baseBeat;
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
      const updatedNotes = chart.notes.map((n) => {
        let next = n;
        let changed = false;
        if (selIds.has(n.id)) {
          next = applyDslToNote(n, dsl);
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
            );
            const out: SlideNodeData = {
              beat: tmp.beat,
              x: Math.max(-2.4, Math.min(2.4, tmp.x)),
              y: Math.max(-1.5, Math.min(1.5, tmp.y)),
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

  const handleDownloadJson = () => {
    const blob = new Blob([exportChartJson(chart)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${chart.metadata.title.toLowerCase().replace(/\s+/g, '_')}_chart.json`;
    a.click();
    URL.revokeObjectURL(url);
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
        className={`absolute top-0 bottom-0 left-0 transition-all duration-300 pointer-events-auto flex flex-col bg-white/[0.05] backdrop-blur-xl border-r border-white/12 text-white shadow-2xl z-30 ${
          isSidebarExpanded ? 'w-80' : 'w-12'
        }`}
        style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.14)' }}
      >
        <div className="flex items-center p-3 border-b border-white/10 bg-white/[0.03]">
          {isSidebarExpanded && (
            <div className="flex items-center gap-2">
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
          <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
            {/* Beat HUD */}
            <div className="p-3 rounded-xl glass-sub border-white/12" style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)' }}>
              <div className="text-[10px] uppercase font-bold text-white/50">{t('editor.curBeat')}</div>
              <div className="text-3xl font-black font-orbitron gradient-text bg-gradient-to-r from-cyan-300 to-amber-300">
                {currentBeat.toFixed(2)}
              </div>
              <div className="flex justify-between items-center text-[11px] text-white/70 mt-1 font-mono">
                <span>{t('editor.time')}: {currentTimeSec.toFixed(3)}s</span>
                <span>{countPlayableNotes(chart)} {t('editor.notes')}</span>
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

            {/* === Events Section === */}
            <div className={sectionClass}>
              <button onClick={() => toggleSection('events')} className={sectionHeaderClass}>
                <span className="flex items-center gap-1.5"><Music size={12} /> {t('editor.events')}</span>
                <span className="text-cyan-300/80">{sectionOpen.events ? '−' : '+'}</span>
              </button>
              {sectionOpen.events && (
                <div className="p-3 space-y-2 border-t border-white/10">
                  <div className="text-[10px] text-white/50">
                    {t('editor.addEventAtBeat')} ({currentBeat.toFixed(2)}):
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
                      <button
                        onClick={handleAddBpmPoint}
                        disabled={currentBeat <= 0}
                        className="text-[10px] px-2 py-0.5 rounded bg-cyan-600/50 hover:bg-cyan-600 text-white font-bold transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                      >
                        {t('editor.addAtCurrentBeat')}
                      </button>
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
                        {t('editor.curBeatBpm')}: {getBpmAtBeatLocal(currentBeat).toFixed(0)}
                        {' | '}
                        {t('editor.totalDuration')}: {beatToSecondsMultiBpm(getMaxBeat(chart), chart.metadata.bpm, chart.metadata.offset, getBpmList()).toFixed(2)}s
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
              {sectionOpen.importExport && <div className="p-3 space-y-1.5 border-t border-white/10">{fileError && <div className="text-red-400 text-[10px]">{fileError}</div>}<label className="block w-full text-center py-1.5 rounded glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 cursor-pointer font-bold"><Upload size={12} className="inline mr-1" /> {t('editor.importAudio')}<input type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac" onChange={handleAudioUpload} className="hidden" /></label><label className="block w-full text-center py-1.5 rounded glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 cursor-pointer font-bold"><Upload size={12} className="inline mr-1" /> {t('editor.importChartJson')}<input type="file" accept=".json,application/json" onChange={handleChartUpload} className="hidden" /></label><button onClick={handleDownloadJson} className="w-full py-1.5 rounded glass-btn-primary font-bold transition cursor-pointer"><Download size={12} className="inline mr-1" /> {t('editor.exportJson')}</button></div>}
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
              value={liveDrag && liveDrag.id === selectedNote.id ? liveDrag.x : selectedNote.x}
              onCommit={(v) => handleModifySelected({ x: v ?? 0 })}
              step={0.1} min={-2.4} max={2.4}
              placeholder="0"
              className="col-span-3 glass-input border border-white/12 rounded px-1.5 py-0.5 text-cyan-300 w-full placeholder:text-white/25"
            />
            <NumField
              value={liveDrag && liveDrag.id === selectedNote.id ? liveDrag.y : selectedNote.y}
              onCommit={(v) => handleModifySelected({ y: v ?? 0 })}
              step={0.1} min={-1.5} max={1.5}
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
                value={cl ? cl.x : sn.x}
                onCommit={(v) => handlePatchSlideNode(i, { x: v ?? 0 })}
                step={0.1} min={-2.4} max={2.4}
                placeholder="0"
                className="col-span-3 glass-input border border-white/12 rounded px-1.5 py-0.5 text-cyan-300 w-full placeholder:text-white/25"
              />
              <NumField
                value={cl ? cl.y : sn.y}
                onCommit={(v) => handlePatchSlideNode(i, { y: v ?? 0 })}
                step={0.1} min={-1.5} max={1.5}
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
            <span className="col-span-3">X</span>
            <span className="col-span-3">Y</span>
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
          <button
            onClick={() => { setRateMenuOpen((v) => !v); setSnapMenuOpen(false); }}
            className={`min-w-16 px-3 py-2 rounded-xl glass-btn border-cyan-400/40 text-cyan-200 font-mono font-black text-sm hover:text-cyan-100 transition cursor-pointer shadow-lg shadow-cyan-500/10 ${playbackRate !== 1 ? 'ring-1 ring-cyan-400/60' : ''}`}
            title={t('editor.rateBtn')}
          >
            {RATE_OPTIONS.find((o) => Math.abs(o.value - playbackRate) < 0.00001)?.label ?? '1x'}
          </button>
          {rateMenuOpen && (
            <div className="glass-panel-strong absolute top-11 right-0 w-28 p-1.5 rounded-xl border-white/15 z-50 space-y-1">
              {RATE_OPTIONS.map(({ label, value }) => {
                const active = Math.abs(playbackRate - value) < 0.00001;
                return (
                  <button
                    key={value}
                    onClick={() => { onSetPlaybackRate(value); setRateMenuOpen(false); }}
                    className={`w-full px-2 py-1.5 rounded-lg text-left text-[11px] font-mono transition cursor-pointer ${active ? 'bg-cyan-500/25 text-cyan-200' : 'text-white/70 hover:bg-white/10 hover:text-white'}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="relative w-full flex flex-col items-center mt-2">
          <button
            onClick={() => { setSnapMenuOpen((v) => !v); setRateMenuOpen(false); }}
            className="min-w-16 px-3 py-2 rounded-xl glass-btn border-cyan-400/40 text-cyan-200 font-mono font-black text-sm hover:text-cyan-100 transition cursor-pointer shadow-lg shadow-cyan-500/10"
            title={t('editor.snapBtn')}
          >
            {[
              { label: '1/1', val: 1 }, { label: '1/2', val: 0.5 }, { label: '1/3', val: 0.333333333333 },
              { label: '1/4', val: 0.25 }, { label: '1/6', val: 0.166666666667 }, { label: '1/8', val: 0.125 },
              { label: '1/12', val: 0.083333333333 }, { label: '1/16', val: 0.0625 }, { label: 'Free', val: 0.01 },
            ].find((o) => Math.abs(o.val - snapSubdivision) < 0.00001)?.label ?? t('editor.snap')}
          </button>
          {snapMenuOpen && (
            <div className="glass-panel-strong absolute top-11 right-0 w-28 p-1.5 rounded-xl border-white/15 z-50 space-y-1">
              {[
                { label: `1/1 ${beatUnit}`, val: 1 }, { label: `1/2 ${beatUnit}`, val: 0.5 }, { label: `1/3 ${beatUnit}`, val: 0.333333333333 },
                { label: `1/4 ${beatUnit}`, val: 0.25 }, { label: `1/6 ${beatUnit}`, val: 0.166666666667 }, { label: `1/8 ${beatUnit}`, val: 0.125 },
                { label: `1/12 ${beatUnit}`, val: 0.083333333333 }, { label: `1/16 ${beatUnit}`, val: 0.0625 }, { label: t('editor.free'), val: 0.01 },
              ].map(({ label, val }) => {
                const active = Math.abs(snapSubdivision - val) < 0.00001;
                return (
                  <button
                    key={val}
                    onClick={() => { onSetSnapSubdivision(val); setSnapMenuOpen(false); }}
                    className={`w-full px-2 py-1.5 rounded-lg text-left text-[11px] font-mono transition cursor-pointer ${active ? 'bg-cyan-500/25 text-cyan-200' : 'text-white/70 hover:bg-white/10 hover:text-white'}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="text-[9px] text-white/40 font-mono leading-none mt-0.5">{t('editor.tune')}</div>
        <button
          onClick={() => onSeekBeat(Math.floor((currentBeat - 1e-6) / snapSubdivision) * snapSubdivision)}
          className="w-10 h-10 rounded-xl glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 flex items-center justify-center font-bold text-sm transition cursor-pointer"
          title={t('editor.snapPrev')}
        >
          ▲ -
        </button>

        <div className="text-xs font-mono font-bold text-amber-300 py-0.5">
          {currentBeat.toFixed(2)}
        </div>

        <button
          onClick={() => onSeekBeat(Math.ceil((currentBeat + 1e-6) / snapSubdivision) * snapSubdivision)}
          className="w-10 h-10 rounded-xl glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 flex items-center justify-center font-bold text-sm transition cursor-pointer"
          title={t('editor.snapNext')}
        >
          ▼ +
        </button>
      </div>

      {/* 4. Bottom Timeline Scrub Bar (Adjusts left offset based on expanded sidebar state to avoid overlap) */}
      <div
        className={`glass-panel-strong absolute bottom-4 right-20 pointer-events-auto border-white/15 rounded-2xl px-5 py-3 z-30 flex items-center gap-4 transition-all duration-300 ${
          isSidebarExpanded ? 'left-[21.5rem]' : 'left-16'
        }`}
      >
        <button
          onClick={onTogglePlay}
          className="w-10 h-10 rounded-xl glass-btn-primary flex items-center justify-center hover:scale-105 active:scale-95 transition cursor-pointer shrink-0"
        >
          {isPlaying ? <Pause size={18} /> : <Play size={18} />}
        </button>

        <button
          onClick={() => onSeekBeat(0)}
          className="p-2 rounded-xl glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 transition cursor-pointer shrink-0"
          title={t('editor.resetStart')}
        >
          <RotateCcw size={16} />
        </button>

        <div className="flex-1 flex flex-col gap-1">
          <div className="flex justify-between text-[11px] font-mono text-white/70">
            <span className="text-cyan-300 font-bold">Beat {currentBeat.toFixed(2)}</span>
            <span>{t('editor.totalLen')}: Beat {getMaxBeat(chart).toFixed(2)}</span>
          </div>
          <input
            type="range"
            min="0"
            max={maxBeat}
            step={snapSubdivision}
            value={currentBeat}
            onChange={(e) => onSeekBeat(parseFloat(e.target.value) || 0)}
            className="w-full accent-cyan-400 cursor-pointer h-2 bg-white/10 rounded-lg"
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
  };

  const typeColor: Record<EventType, { border: string; text: string }> = {
    speed_change: { border: 'border-purple-400/40', text: 'text-purple-300 hover:text-purple-200' },
    text_display: { border: 'border-amber-400/40', text: 'text-amber-300 hover:text-amber-200' },
    note_color_change: { border: 'border-cyan-400/40', text: 'text-cyan-300 hover:text-cyan-200' },
    bg_change: { border: 'border-cyan-400/40', text: 'text-cyan-300 hover:text-emerald-200' },
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
                <p>*{t('editor.notImpl')}</p>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
