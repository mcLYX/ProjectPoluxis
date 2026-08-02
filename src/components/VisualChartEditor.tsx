import React, { useState, useRef } from 'react';
import { ChartData, NoteData, EventData, EventType, BpmPoint } from '../types/game';
import { exportChartJson, parseAndValidateChart } from '../utils/chartParser';
import { countPlayableNotes, getMaxBeat, beatToSecondsMultiBpm } from '../utils/beatTime';
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
} from 'lucide-react';

export type EditorTool = 'select' | 'place-tap' | 'place-touch' | 'place-slide' | 'quick-create';

export interface BatchSelection {
  startBeat: number | null;
  endBeat: number | null;
}

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
  snapSubdivision: number;
  playbackRate: number;
  onSetPlaybackRate: (rate: number) => void;
  onUpdateChart: (updated: ChartData) => void;
  onSeekBeat: (beat: number) => void;
  onTogglePlay: () => void;
  onSetActiveTool: (tool: EditorTool) => void;
  onSelectNote: (id: string | null) => void;
  onSetBatchSelection: (sel: BatchSelection) => void;
  onSetSnapSubdivision: (snap: number) => void;
  /** 2D editor: number of vertical grid lines (incl. edges) -> X snap columns. */
  vlineCount: number;
  onSetVlineCount: (n: number) => void;
  /** 2D editor: vertical pixels between adjacent integer beats (time-axis zoom). */
  pxPerBeat: number;
  onSetPxPerBeat: (n: number) => void;
  onUploadAudioFile: (file: File) => void;
  onExitEditor: () => void;
  onStartPlayTest: (fromCurrentBeat: boolean) => void;
  /** '3d' = default perspective view; '2d' = top-down falling-editor view. */
  viewMode: '3d' | '2d';
  onSetViewMode: (mode: '3d' | '2d') => void;
  onApplyQuickCreateDelta?: (delta: QuickCreateDelta) => void;
}

export const VisualChartEditor: React.FC<VisualChartEditorProps> = ({
  chart,
  currentBeat,
  currentTimeSec,
  isPlaying,
  activeTool,
  selectedNoteId,
  batchSelection,
  snapSubdivision,
  playbackRate,
  onSetPlaybackRate,
  onUpdateChart,
  onSeekBeat,
  onTogglePlay,
  onSetActiveTool,
  onSelectNote,
  onSetBatchSelection,
  onSetSnapSubdivision,
  vlineCount,
  onSetVlineCount,
  pxPerBeat,
  onSetPxPerBeat,
  onUploadAudioFile,
  onExitEditor,
  onStartPlayTest,
  viewMode,
  onSetViewMode,
  onApplyQuickCreateDelta: _onApplyQuickCreateDelta,
}) => {
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
  const [sectionOpen, setSectionOpen] = useState({
    view: true,
    tools: true,
    playtest: true,
    events: false,
    metadata: true,
    timing: false,
    batch: false,
    importExport: false,
  });

  // Dragging State for Floating Quick Edit and Snapping Panels
  const [panelPos, setPanelPos] = useState({ x: 0, y: 0 });
  const [snappingPos, setSnappingPos] = useState({ x: 0, y: 0 });

  const panelDragStart = useRef<{ startX: number; startY: number; posX: number; posY: number } | null>(null);
  const snapDragStart = useRef<{ startX: number; startY: number; posX: number; posY: number } | null>(null);

  const selectedBaseId = selectedNoteId ? selectedNoteId.split('#')[0] : null;
  const selectedNote = chart.notes.find((n) => n.id === selectedBaseId);

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

  const handleSetBatchStart = () => {
    const newStart = Math.round(currentBeat * 100) / 100;
    let newEnd = batchSelection.endBeat;
    if (newEnd !== null && newStart > newEnd) {
      const temp = newEnd;
      newEnd = newStart;
      onSetBatchSelection({ startBeat: temp, endBeat: newEnd });
    } else {
      onSetBatchSelection({ startBeat: newStart, endBeat: newEnd });
    }
  };

  const handleSetBatchEnd = () => {
    const newEnd = Math.round(currentBeat * 100) / 100;
    let newStart = batchSelection.startBeat;
    if (newStart !== null && newEnd < newStart) {
      const temp = newStart;
      newStart = newEnd;
      onSetBatchSelection({ startBeat: newStart, endBeat: temp });
    } else {
      onSetBatchSelection({ startBeat: newStart, endBeat: newEnd });
    }
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

  const handleModifySelected = (patch: Partial<NoteData>) => {
    if (!selectedBaseId) return;
    const updatedNotes = chart.notes.map((n) => (n.id === selectedBaseId ? { ...n, ...patch } : n));
    onUpdateChart({ ...chart, notes: updatedNotes });
  };

  const handlePatchSlideNode = (childIdx: number, patch: Partial<{ beat: number; x: number; y: number }>) => {
    if (!selectedNote || selectedNote.type !== 'slide' || !selectedNote.nodes) return;
    const nodes = selectedNote.nodes.map((sn, i) => (i === childIdx ? { ...sn, ...patch } : sn));
    handleModifySelected({ nodes });
  };

  const handleAddSlideNode = () => {
    if (!selectedNote || selectedNote.type !== 'slide') return;
    const nodes = selectedNote.nodes ?? [];
    const last = nodes.length > 0 ? nodes[nodes.length - 1] : { beat: selectedNote.beat, x: selectedNote.x, y: selectedNote.y };
    const newNode = { beat: Math.round((last.beat + 1) * 1000) / 1000, x: last.x, y: last.y };
    handleModifySelected({ nodes: [...nodes, newNode] });
  };

  const handleRemoveSlideNode = (childIdx: number) => {
    if (!selectedNote || selectedNote.type !== 'slide' || !selectedNote.nodes) return;
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

  const handleAudioUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onUploadAudioFile(e.target.files[0]);
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
          setFileError(res.error || '谱面文件解析失败');
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

  // General Panel Drag Handlers
  const onPanelPointerDown = (e: React.PointerEvent) => {
    panelDragStart.current = {
      startX: e.clientX,
      startY: e.clientY,
      posX: panelPos.x,
      posY: panelPos.y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPanelPointerMove = (e: React.PointerEvent) => {
    if (!panelDragStart.current) return;
    const dx = e.clientX - panelDragStart.current.startX;
    const dy = e.clientY - panelDragStart.current.startY;
    setPanelPos({
      x: panelDragStart.current.posX + dx,
      y: panelDragStart.current.posY + dy,
    });
  };

  const onPanelPointerUp = () => {
    panelDragStart.current = null;
  };

  // Snapping Panel Drag Handlers
  const onSnapPointerDown = (e: React.PointerEvent) => {
    snapDragStart.current = {
      startX: e.clientX,
      startY: e.clientY,
      posX: snappingPos.x,
      posY: snappingPos.y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onSnapPointerMove = (e: React.PointerEvent) => {
    if (!snapDragStart.current) return;
    const dx = e.clientX - snapDragStart.current.startX;
    const dy = e.clientY - snapDragStart.current.startY;
    setSnappingPos({
      x: snapDragStart.current.posX + dx,
      y: snapDragStart.current.posY + dy,
    });
  };

  const onSnapPointerUp = () => {
    snapDragStart.current = null;
  };

  const toolBtnCls = (tool: EditorTool) =>
    `py-2 px-1 rounded-lg border font-bold text-center transition cursor-pointer flex flex-col items-center gap-1 ${
      activeTool === tool
        ? 'bg-cyan-500/20 border-cyan-400/60 text-cyan-200 shadow-[0_0_16px_rgba(34,211,238,0.25),inset_0_1px_0_rgba(255,255,255,0.14)]'
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
    const baseCls = `w-8 h-8 rounded-lg flex items-center justify-center border transition cursor-pointer ${
      isSelected
        ? 'bg-cyan-500/20 border-cyan-400/60 text-cyan-200 shadow-[0_0_14px_rgba(34,211,238,0.25)]'
        : 'border-transparent text-white/55 hover:bg-white/[0.08] hover:text-white'
    }`;

    switch (tool) {
      case 'select':
        return (
          <button key={tool} onClick={() => onSetActiveTool(tool)} className={baseCls} title="选择/移动 (Select)">
            <Move size={16} />
          </button>
        );
      case 'place-tap':
        return (
          <button key={tool} onClick={() => onSetActiveTool(tool)} className={baseCls} title="放置 Tap">
            <span className="w-3.5 h-3.5 border-2 border-cyan-300 block" />
          </button>
        );
      case 'place-touch':
        return (
          <button key={tool} onClick={() => onSetActiveTool(tool)} className={baseCls} title="放置 Touch">
            <span className="w-3.5 h-3.5 rounded-full border-2 border-sky-300 block" />
          </button>
        );
      case 'place-slide':
        return (
          <button key={tool} onClick={() => onSetActiveTool(tool)} className={baseCls} title="放置 Slide">
            <span className="w-3 h-3 border-2 border-emerald-300 block rotate-45" />
          </button>
        );
      case 'quick-create':
        return (
          <button key={tool} onClick={() => onSetActiveTool(tool)} className={baseCls} title="快速制谱">
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
                谱面编辑器
              </span>
            </div>
          )}
          <button
            onClick={() => setIsSidebarExpanded(!isSidebarExpanded)}
            className={`p-1 rounded-lg hover:bg-white/10 text-cyan-300 transition cursor-pointer ${isSidebarExpanded ? 'ml-auto' : 'mx-auto'}`}
            title={isSidebarExpanded ? '收起侧边栏' : '展开侧边栏'}
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
              <div className="text-[10px] uppercase font-bold text-white/50">当前节拍 (Current Beat)</div>
              <div className="text-3xl font-black font-orbitron text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 to-amber-300">
                {currentBeat.toFixed(2)}
              </div>
              <div className="flex justify-between items-center text-[11px] text-white/70 mt-1 font-mono">
                <span>时间: {currentTimeSec.toFixed(3)}s</span>
                <span>{countPlayableNotes(chart)} 音符</span>
              </div>
            </div>

            {/* === View Section (3D / 2D) === */}
            <div className={sectionClass}>
              <button onClick={() => toggleSection('view')} className={sectionHeaderClass}>
                <span className="flex items-center gap-1.5"><Box size={12} /> 视图</span>
                <span className="text-cyan-300/80">{sectionOpen.view ? '−' : '+'}</span>
              </button>
              {sectionOpen.view && (
                <div className="p-3 space-y-2 border-t border-white/10">
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={() => onSetViewMode('3d')}
                      className={viewMode === '3d' ? viewBtnSelectedCls : viewBtnCls}
                    >
                      <Box size={14} /><span>3D 视图</span>
                    </button>
                    <button
                      onClick={() => onSetViewMode('2d')}
                      className={viewMode === '2d' ? viewBtnSelectedCls : viewBtnCls}
                    >
                      <LayoutGrid size={14} /><span>2D 视图</span>
                    </button>
                  </div>

                  {viewMode === '2d' && (
                    <div className="pt-1 space-y-2 border-t border-white/10">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-white/70">吸附列数</span>
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
                        <span className="text-[11px] text-white/70">时间轴缩放</span>
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
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className={sectionClass}>
              <button onClick={() => toggleSection('tools')} className={sectionHeaderClass}>
                <span>编辑模式 / 放置工具</span>
                <span className="text-cyan-300/80">{sectionOpen.tools ? '−' : '+'}</span>
              </button>
              {sectionOpen.tools && (
                <div className="p-3 space-y-1.5 border-t border-white/10">
                  <div className="grid grid-cols-2 gap-1.5">
                    <button onClick={() => onSetActiveTool('select')} className={toolBtnCls('select')}><Move size={14} /><span>选择/移动</span></button>
                    {viewMode !== '2d' && (
                      <button onClick={() => onSetActiveTool('quick-create')} className={toolBtnCls('quick-create')}><Zap size={14} /><span>快速制谱</span></button>
                    )}
                    <button onClick={() => onSetActiveTool('place-tap')} className={toolBtnCls('place-tap')}><span className="w-3.5 h-3.5 border-2 border-cyan-300 block" /><span>放置 Tap</span></button>
                    <button onClick={() => onSetActiveTool('place-touch')} className={toolBtnCls('place-touch')}><span className="w-3.5 h-3.5 rounded-full border-2 border-sky-300 block" /><span>放置 Touch</span></button>
                    <button onClick={() => onSetActiveTool('place-slide')} className={toolBtnCls('place-slide')}><span className="w-3.5 h-3.5 border-2 border-emerald-300 block rotate-45" /><span>放置 Slide</span></button>
                  </div>
                  {viewMode === '2d' ? (
                    <p className="text-[10px] text-white/50">
                      上下=时间轴，左右=X 轴（放置音符按 y=0 处理）。方=TAP，圆=TOUCH，菱=SLIDE。
                      {activeTool === 'select'
                        ? '点击音符/节点选中，拖动改变时间与位置；在空白处上下拖动可平移进度。'
                        : '点击轨道在吸附网格处放置音符。'}
                    </p>
                  ) : (
                    <p className="text-[10px] text-white/50">
                      {activeTool === 'quick-create'
                        ? '跟着音乐在屏幕上敲：短按=TAP，按住>1拍不移动=SLIDE，快速滑动=TOUCH串。所有音符自动吸附节拍。'
                        : activeTool === 'select'
                        ? '点击音符/节点选中，拖动可实时改变位置'
                        : activeTool === 'place-slide'
                        ? '点击放置 Slide 头节点；保持选中可追加子节点'
                        : '直接在 3D 判定平面点击放置新音符'}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* === Play Test Section === */}
            <div className={sectionClass}>
              <button onClick={() => toggleSection('playtest')} className={sectionHeaderClass}>
                <span className="flex items-center gap-1.5"><Zap size={12} /> 试玩模式</span>
                <span className="text-cyan-300/80">{sectionOpen.playtest ? '−' : '+'}</span>
              </button>
              {sectionOpen.playtest && (
                <div className="p-3 space-y-2 border-t border-white/10">
                  <p className="text-[10px] text-white/50">
                    进入实际游戏状态测试谱面。暂停或结算时自动返回编辑器。
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => onStartPlayTest(true)}
                      className="py-2 px-2 rounded glass-btn-primary text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer"
                      style={{ ['--hud-accent' as any]: '#f59e0b' }}
                    >
                      <Play size={12} /> 从当前位置
                    </button>
                    <button
                      onClick={() => onStartPlayTest(false)}
                      className="py-2 px-2 rounded glass-btn-primary text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer"
                    >
                      <RotateCcw size={12} /> 从头开始
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* === Events Section === */}
            <div className={sectionClass}>
              <button onClick={() => toggleSection('events')} className={sectionHeaderClass}>
                <span className="flex items-center gap-1.5"><Music size={12} /> 事件编辑</span>
                <span className="text-cyan-300/80">{sectionOpen.events ? '−' : '+'}</span>
              </button>
              {sectionOpen.events && (
                <div className="p-3 space-y-2 border-t border-white/10">
                  <div className="text-[10px] text-white/50">
                    在当前拍 ({currentBeat.toFixed(2)}) 添加事件：
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button onClick={() => handleAddEvent('speed_change')} className="py-1.5 px-2 rounded glass-btn border-purple-400/40 text-purple-300 hover:text-purple-200 text-[11px] transition cursor-pointer">
                      变速
                    </button>
                    <button onClick={() => handleAddEvent('text_display')} className="py-1.5 px-2 rounded glass-btn border-amber-400/40 text-amber-300 hover:text-amber-200 text-[11px] transition cursor-pointer">
                      文字
                    </button>
                    <button onClick={() => handleAddEvent('note_color_change')} className="py-1.5 px-2 rounded glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 text-[11px] transition cursor-pointer">
                      音符色
                    </button>
                    <button onClick={() => handleAddEvent('bg_change')} className="py-1.5 px-2 rounded glass-btn border-emerald-400/40 text-emerald-300 hover:text-emerald-200 text-[11px] transition cursor-pointer">
                      背景色
                    </button>
                  </div>

                  <div className="pt-2 border-t border-white/10 space-y-1.5 max-h-64 overflow-y-auto">
                    <div className="text-[10px] text-white/50">
                      事件列表 ({getEvents().length})
                    </div>
                    {getEvents().length === 0 && (
                      <div className="text-[10px] text-white/40 italic py-2 text-center">
                        暂无事件
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

            <div className={sectionClass}>
              <button onClick={() => toggleSection('metadata')} className={sectionHeaderClass}>
                <span>歌曲元数据编辑</span>
                <span className="text-cyan-300/80">{sectionOpen.metadata ? '−' : '+'}</span>
              </button>
              {sectionOpen.metadata && (
                <div className="p-3 space-y-2 border-t border-white/10">
                  <div><label className="text-[10px] text-white/50 block mb-0.5">歌名</label><input type="text" value={chart.metadata.title} onChange={(e) => onUpdateChart({ ...chart, metadata: { ...chart.metadata, title: e.target.value || 'Untitled' } })} className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200" /></div>
                  <div><label className="text-[10px] text-white/50 block mb-0.5">艺术家</label><input type="text" value={chart.metadata.artist} onChange={(e) => onUpdateChart({ ...chart, metadata: { ...chart.metadata, artist: e.target.value || 'Unknown' } })} className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200" /></div>
                  <div><label className="text-[10px] text-white/50 block mb-0.5">难度标识</label><input type="text" value={chart.metadata.difficulty} onChange={(e) => onUpdateChart({ ...chart, metadata: { ...chart.metadata, difficulty: e.target.value || 'Custom' } })} className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200" /></div>
                  <div><label className="text-[10px] text-white/50 block mb-0.5">封面（已废弃）</label><input type="text" value={chart.metadata.jacket || ''} onChange={(e) => onUpdateChart({ ...chart, metadata: { ...chart.metadata, jacket: e.target.value || undefined } })} className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200" /></div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[10px] text-white/50">全局音符色<input type="color" value={chart.metadata.noteColor || '#00f0ff'} onChange={(e) => onUpdateChart({ ...chart, metadata: { ...chart.metadata, noteColor: e.target.value } })} className="mt-1 w-full h-8 bg-transparent cursor-pointer" /></label>
                    <label className="text-[10px] text-white/50">强调色<input type="color" value={chart.metadata.bgScheme.accentColor || '#00f0ff'} onChange={(e) => onUpdateChart({ ...chart, metadata: { ...chart.metadata, bgScheme: { ...chart.metadata.bgScheme, accentColor: e.target.value } } })} className="mt-1 w-full h-8 bg-transparent cursor-pointer" /></label>
                    <label className="text-[10px] text-white/50">背景起始<input type="color" value={chart.metadata.bgScheme.gradientStart || '#050c1e'} onChange={(e) => onUpdateChart({ ...chart, metadata: { ...chart.metadata, bgScheme: { ...chart.metadata.bgScheme, gradientStart: e.target.value } } })} className="mt-1 w-full h-8 bg-transparent cursor-pointer" /></label>
                    <label className="text-[10px] text-white/50">背景结束<input type="color" value={chart.metadata.bgScheme.gradientEnd || '#1b072c'} onChange={(e) => onUpdateChart({ ...chart, metadata: { ...chart.metadata, bgScheme: { ...chart.metadata.bgScheme, gradientEnd: e.target.value } } })} className="mt-1 w-full h-8 bg-transparent cursor-pointer" /></label>
                  </div>
                  <div className="grid grid-cols-2 gap-2 pt-1 text-[11px] text-white/70">
                    {(['bloom', 'particles', 'projection', 'gridLines'] as const).map((k) => <label key={k} className="flex items-center gap-1.5"><input type="checkbox" checked={!!chart.metadata.effectToggles[k]} onChange={(e) => onUpdateChart({ ...chart, metadata: { ...chart.metadata, effectToggles: { ...chart.metadata.effectToggles, [k]: e.target.checked } } })} className="accent-cyan-400" />{k}</label>)}
                  </div>
                </div>
              )}
            </div>

            <div className={sectionClass}>
              <button onClick={() => toggleSection('timing')} className={sectionHeaderClass}>
                <span>谱面参数设定</span>
                <span className="text-cyan-300/80">{sectionOpen.timing ? '−' : '+'}</span>
              </button>
              {sectionOpen.timing && (
                <div className="p-3 border-t border-white/10 space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div><label className="text-[10px] text-white/50">BPM（基准）</label><input type="number" min="30" max="400" step="1" value={chart.metadata.bpm} onChange={(e) => handleUpdateMeta('bpm', parseFloat(e.target.value) || 120)} className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200 font-mono" /></div>
                    <div><label className="text-[10px] text-white/50">Offset (秒)</label><input type="number" step="0.01" value={chart.metadata.offset} onChange={(e) => handleUpdateMeta('offset', parseFloat(e.target.value) || 0)} className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200 font-mono" /></div>
                  </div>
                  <div className="border-t border-white/10 pt-2">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] text-cyan-300 font-bold">BPM 变化点 (bpmlist)</span>
                      <button
                        onClick={handleAddBpmPoint}
                        disabled={currentBeat <= 0}
                        className="text-[10px] px-2 py-0.5 rounded bg-cyan-600/50 hover:bg-cyan-600 text-white font-bold transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                      >
                        + 在当前拍添加
                      </button>
                    </div>
                    {getBpmList().length === 0 ? (
                      <div className="text-[10px] text-white/40 italic">暂无 BPM 变化点，使用单一 BPM</div>
                    ) : (
                      <div className="space-y-1.5 max-h-40 overflow-y-auto">
                        {getBpmList().map((p, idx) => (
                          <div key={idx} className="flex items-center gap-1.5 text-[11px]">
                            <input
                              type="number" step={snapSubdivision} min="0.01"
                              value={p.beat}
                              onChange={(e) => handleUpdateBpmPoint(idx, { beat: parseFloat(e.target.value) || 0.01 })}
                              className="w-16 glass-input border border-white/12 rounded px-1.5 py-0.5 text-cyan-200 font-mono"
                            />
                            <span className="text-white/40">拍 →</span>
                            <input
                              type="number" min="30" max="400" step="1"
                              value={p.bpm}
                              onChange={(e) => handleUpdateBpmPoint(idx, { bpm: parseFloat(e.target.value) || 120 })}
                              className="w-16 glass-input border border-white/12 rounded px-1.5 py-0.5 text-cyan-200 font-mono"
                            />
                            <span className="text-white/40">BPM</span>
                            <button
                              onClick={() => handleDeleteBpmPoint(idx)}
                              className="ml-auto text-red-400 hover:text-red-300 text-xs cursor-pointer"
                              title="删除"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="mt-2 text-[10px] text-white/40 font-mono">
                      当前拍 BPM: {getBpmAtBeatLocal(currentBeat).toFixed(0)}
                      {' | '}
                      总时长: {beatToSecondsMultiBpm(getMaxBeat(chart), chart.metadata.bpm, chart.metadata.offset, getBpmList()).toFixed(2)}s
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className={sectionClass}>
              <button onClick={() => toggleSection('batch')} className={sectionHeaderClass}>
                <span>批量选择与操作</span>
                <span className="text-cyan-300/80">{sectionOpen.batch ? '−' : '+'}</span>
              </button>
              {sectionOpen.batch && <div className="p-3 space-y-2.5 border-t border-white/10"><div className="flex justify-end">{validBatchRange && <span className="text-[10px] text-emerald-400 font-mono">{notesInBatch.length} 个音符</span>}</div><div className="grid grid-cols-2 gap-2"><button onClick={handleSetBatchStart} className="py-1.5 px-2 rounded glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 transition cursor-pointer text-center">起点: {batchSelection.startBeat !== null ? `B${batchSelection.startBeat}` : '未设'}</button><button onClick={handleSetBatchEnd} className="py-1.5 px-2 rounded glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 transition cursor-pointer text-center">终点: {batchSelection.endBeat !== null ? `B${batchSelection.endBeat}` : '未设'}</button></div>{validBatchRange && <div className="space-y-2 pt-1 border-t border-white/10"><div className="text-[10px] text-white/70 font-mono">区间: [{validBatchRange.start.toFixed(2)} ~ {validBatchRange.end.toFixed(2)}]</div><div className="grid grid-cols-2 gap-2"><button onClick={handleBatchClone} className="py-1.5 rounded glass-btn border-emerald-400/40 text-emerald-300 hover:text-emerald-200 flex items-center justify-center gap-1 font-bold transition cursor-pointer"><Copy size={12} /> 克隆</button>{!confirmBatchDelete ? <button onClick={() => setConfirmBatchDelete(true)} className="py-1.5 rounded glass-btn border-red-400/40 text-red-300 hover:text-red-200 flex items-center justify-center gap-1 font-bold transition cursor-pointer"><Trash2 size={12} /> 删除</button> : <button onClick={handleBatchDelete} className="py-1.5 rounded bg-red-600 text-white font-bold animate-pulse text-center cursor-pointer">确认?</button>}</div></div>}</div>}
            </div>

            <div className={sectionClass}>
              <button onClick={() => toggleSection('importExport')} className={sectionHeaderClass}>
                <span>导入与导出</span>
                <span className="text-cyan-300/80">{sectionOpen.importExport ? '−' : '+'}</span>
              </button>
              {sectionOpen.importExport && <div className="p-3 space-y-1.5 border-t border-white/10">{fileError && <div className="text-red-400 text-[10px]">{fileError}</div>}<label className="block w-full text-center py-1.5 rounded glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 cursor-pointer font-bold"><Upload size={12} className="inline mr-1" /> 导入音频<input type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac" onChange={handleAudioUpload} className="hidden" /></label><label className="block w-full text-center py-1.5 rounded glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 cursor-pointer font-bold"><Upload size={12} className="inline mr-1" /> 导入谱面 JSON<input type="file" accept=".json,application/json" onChange={handleChartUpload} className="hidden" /></label><button onClick={handleDownloadJson} className="w-full py-1.5 rounded glass-btn-primary font-bold transition cursor-pointer"><Download size={12} className="inline mr-1" /> 导出 JSON</button></div>}
            </div>

            <button onClick={onExitEditor} className="glass-btn w-full py-2.5 rounded-xl text-white/80 font-bold">
              退出编辑器
            </button>
          </div>
        )}
      </div>

      {/* 2. Draggable & Semi-Transparent Floating Quick Editor */}
      {selectedNote && selectedNote.type !== 'slide' && (
        <div
          className="glass-panel-strong absolute pointer-events-auto border-cyan-400/40 rounded-2xl p-3.5 text-white flex items-center gap-4 z-40 transition-colors select-none"
          style={{
            transform: `translate(${panelPos.x}px, ${panelPos.y}px)`,
            left: '24rem',
            top: '1rem',
          }}
        >
          {/* Drag Handle */}
          <div
            onPointerDown={onPanelPointerDown}
            onPointerMove={onPanelPointerMove}
            onPointerUp={onPanelPointerUp}
            className="w-5 h-8 flex items-center justify-center text-cyan-400/50 hover:text-cyan-400 active:text-cyan-300 cursor-grab active:cursor-grabbing border-r border-white/10 pr-1.5 select-none shrink-0"
            title="拖动面板"
          >
            <Compass size={14} className="animate-pulse" />
          </div>

          <div className="flex items-center gap-2">
            <span className="font-bold text-xs text-cyan-300 font-mono">#{selectedNote.id}</span>
            <button
              onClick={() => handleModifySelected({ type: selectedNote.type === 'tap' ? 'touch' : 'tap' })}
              className="px-2.5 py-1 rounded bg-cyan-500/20 border border-cyan-500/40 text-cyan-200 text-xs font-bold hover:bg-cyan-500/40 cursor-pointer"
            >
              切换为 {selectedNote.type === 'tap' ? '● Touch' : '■ Tap'}
            </button>
          </div>

          <div className="flex items-center gap-2 text-xs font-mono">
            <span>Beat:</span>
            <input
              type="number" step={snapSubdivision} value={selectedNote.beat}
              onChange={(e) => handleModifySelected({ beat: parseFloat(e.target.value) || 0 })}
              className="w-18 glass-input border border-white/12 rounded px-2 py-0.5 text-cyan-300 font-mono"
            />
          </div>

          <div className="flex items-center gap-2 text-xs font-mono">
            <span>X:</span>
            <input
              type="number" step="0.1" min="-2.4" max="2.4" value={selectedNote.x}
              onChange={(e) => handleModifySelected({ x: parseFloat(e.target.value) || 0 })}
              className="w-14 glass-input border border-white/12 rounded px-1 py-0.5 text-cyan-300"
            />
            <span>Y:</span>
            <input
              type="number" step="0.1" min="-1.5" max="1.5" value={selectedNote.y}
              onChange={(e) => handleModifySelected({ y: parseFloat(e.target.value) || 0 })}
              className="w-14 glass-input border border-white/12 rounded px-1 py-0.5 text-cyan-300"
            />
          </div>

          <div className="flex items-center gap-1 text-xs font-mono">
            <input
              type="color"
              value={selectedNote.color || chart.metadata.noteColor || '#00f0ff'}
              onChange={(e) => handleModifySelected({ color: e.target.value })}
              className="w-6 h-6 rounded border border-cyan-500/40 bg-transparent cursor-pointer"
              title="覆盖全局音符颜色；双击重置为全局音符色"
              onDoubleClick={() => handleModifySelected({ color: undefined })}
            />
          </div>

          <button onClick={handleDeleteSelected} className="p-1.5 rounded-lg bg-red-950/60 border border-red-500/40 text-red-300 hover:bg-red-800 hover:text-white transition cursor-pointer" title="删除选中的音符">
            <Trash2 size={16} />
          </button>
          <button onClick={() => onSelectNote(null)} className="p-1 text-white/50 hover:text-white">
            <X size={16} />
          </button>
        </div>
      )}

      {/* 2b. Draggable & Semi-Transparent Floating Slide Chain Editor */}
      {selectedNote && selectedNote.type === 'slide' && (
        <div
          className="glass-panel-strong absolute pointer-events-auto border-emerald-400/40 rounded-2xl p-4 text-white z-40 w-[26rem] max-h-[50vh] overflow-y-auto select-none"
          style={{
            transform: `translate(${panelPos.x}px, ${panelPos.y}px)`,
            left: '24rem',
            top: '1rem',
          }}
        >
          <div className="flex items-center justify-between mb-3 border-b border-emerald-500/20 pb-2">
            <div className="flex items-center gap-2">
              {/* Drag Handle */}
              <div
                onPointerDown={onPanelPointerDown}
                onPointerMove={onPanelPointerMove}
                onPointerUp={onPanelPointerUp}
                className="w-5 h-5 flex items-center justify-center text-emerald-400/50 hover:text-emerald-400 active:text-emerald-300 cursor-grab active:cursor-grabbing mr-1 select-none shrink-0 animate-pulse"
                title="拖动面板"
              >
                <Compass size={14} />
              </div>
              <span className="w-3 h-3 border-2 border-emerald-300 rotate-45 block" />
              <span className="font-bold text-sm text-emerald-300 font-orbitron">Slide 链编辑</span>
              <span className="text-[10px] text-white/50 font-mono">#{selectedNote.id}</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={selectedNote.color || chart.metadata.noteColor || '#00f0ff'}
                onChange={(e) => handleModifySelected({ color: e.target.value })}
                className="w-6 h-6 bg-transparent cursor-pointer rounded border border-emerald-400/40"
                title="设置整条 Slide 链的颜色（头节点与所有子节点统一）；点击右侧可重置"
                onDoubleClick={() => handleModifySelected({ color: undefined })}
              />
              <button onClick={handleDeleteSelected} className="p-1.5 rounded-lg bg-red-950/60 border border-red-500/40 text-red-300 hover:bg-red-800 hover:text-white transition cursor-pointer" title="删除整条 Slide">
                <Trash2 size={14} />
              </button>
              <button onClick={() => onSelectNote(null)} className="p-1 text-white/50 hover:text-white">
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Head node row */}
          <div className={`grid grid-cols-12 gap-1.5 items-center p-2 rounded-lg mb-1.5 text-xs font-mono ${
            selectedNoteId === selectedNote.id ? 'bg-emerald-900/40 border border-emerald-400/50' : 'glass-sub border-white/10'
          }`}>
            <span className="col-span-2 text-emerald-300 font-bold">头节点</span>
            <input
              type="number" step={snapSubdivision} value={selectedNote.beat}
              onChange={(e) => handleModifySelected({ beat: parseFloat(e.target.value) || 0 })}
              className="col-span-3 glass-input border border-white/12 rounded px-1.5 py-0.5 text-cyan-300"
            />
            <input
              type="number" step="0.1" min="-2.4" max="2.4" value={selectedNote.x}
              onChange={(e) => handleModifySelected({ x: parseFloat(e.target.value) || 0 })}
              className="col-span-3 glass-input border border-white/12 rounded px-1.5 py-0.5 text-cyan-300"
            />
            <input
              type="number" step="0.1" min="-1.5" max="1.5" value={selectedNote.y}
              onChange={(e) => handleModifySelected({ y: parseFloat(e.target.value) || 0 })}
              className="col-span-3 glass-input border border-white/12 rounded px-1.5 py-0.5 text-cyan-300"
            />
            <span className="col-span-1" />
          </div>

          {/* Child node rows */}
          {(selectedNote.nodes ?? []).map((sn, i) => (
            <div
              key={i}
              className={`grid grid-cols-12 gap-1.5 items-center p-2 rounded-lg mb-1.5 text-xs font-mono ${
                selectedNoteId === `${selectedNote.id}#${i + 1}` ? 'bg-emerald-900/40 border border-emerald-400/50' : 'glass-sub border-white/10'
              }`}
            >
              <span className="col-span-2 text-white/70">节点 {i + 1}</span>
              <input
                type="number" step={snapSubdivision} value={sn.beat}
                onChange={(e) => handlePatchSlideNode(i, { beat: parseFloat(e.target.value) || 0 })}
                className="col-span-3 glass-input border border-white/12 rounded px-1.5 py-0.5 text-cyan-300"
              />
              <input
                type="number" step="0.1" min="-2.4" max="2.4" value={sn.x}
                onChange={(e) => handlePatchSlideNode(i, { x: parseFloat(e.target.value) || 0 })}
                className="col-span-3 glass-input border border-white/12 rounded px-1.5 py-0.5 text-cyan-300"
              />
              <input
                type="number" step="0.1" min="-1.5" max="1.5" value={sn.y}
                onChange={(e) => handlePatchSlideNode(i, { y: parseFloat(e.target.value) || 0 })}
                className="col-span-3 glass-input border border-white/12 rounded px-1.5 py-0.5 text-cyan-300"
              />
              <button onClick={() => handleRemoveSlideNode(i)} className="col-span-1 flex justify-center text-red-400 hover:text-red-300 cursor-pointer">
                <Trash2 size={13} />
              </button>
            </div>
          ))}

          <div className="grid grid-cols-12 gap-1.5 text-[10px] text-white/40 font-mono px-2 mb-2">
            <span className="col-span-2" />
            <span className="col-span-3">Beat</span>
            <span className="col-span-3">X</span>
            <span className="col-span-3">Y</span>
            <span className="col-span-1" />
          </div>

          <button
            onClick={handleAddSlideNode}
            className="w-full py-1.5 rounded-lg border-2 border-dashed border-emerald-500/40 hover:bg-emerald-500/10 text-emerald-300 font-bold text-xs transition cursor-pointer flex items-center justify-center gap-1"
          >
            <Plus size={13} /> 追加子节点
          </button>
        </div>
      )}

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
          onPointerMove={onSnapPointerMove}
          onPointerUp={onSnapPointerUp}
          className="w-full h-3 flex items-center justify-center text-cyan-400/40 hover:text-cyan-400 active:text-cyan-300 cursor-grab active:cursor-grabbing border-b border-white/10 pb-1 select-none animate-pulse shrink-0"
          title="拖动微调面板"
        >
          <Compass size={12} />
        </div>

        <div className="relative w-full flex flex-col items-center">
          <button
            onClick={() => { setRateMenuOpen((v) => !v); setSnapMenuOpen(false); }}
            className={`min-w-16 px-3 py-2 rounded-xl glass-btn border-cyan-400/40 text-cyan-200 font-mono font-black text-sm hover:text-cyan-100 transition cursor-pointer shadow-lg shadow-cyan-500/10 ${playbackRate !== 1 ? 'ring-1 ring-cyan-400/60' : ''}`}
            title="点击切换播放速度（仅编辑预览，进入试玩/游戏会恢复 1x）"
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
            title="点击切换节拍吸附"
          >
            {[
              { label: '1/1', val: 1 }, { label: '1/2', val: 0.5 }, { label: '1/3', val: 0.333333333333 },
              { label: '1/4', val: 0.25 }, { label: '1/6', val: 0.166666666667 }, { label: '1/8', val: 0.125 },
              { label: '1/12', val: 0.083333333333 }, { label: '1/16', val: 0.0625 }, { label: 'Free', val: 0.01 },
            ].find((o) => Math.abs(o.val - snapSubdivision) < 0.00001)?.label ?? 'Snap'}
          </button>
          {snapMenuOpen && (
            <div className="glass-panel-strong absolute top-11 right-0 w-28 p-1.5 rounded-xl border-white/15 z-50 space-y-1">
              {[
                { label: '1/1 拍', val: 1 }, { label: '1/2 拍', val: 0.5 }, { label: '1/3 拍', val: 0.333333333333 },
                { label: '1/4 拍', val: 0.25 }, { label: '1/6 拍', val: 0.166666666667 }, { label: '1/8 拍', val: 0.125 },
                { label: '1/12 拍', val: 0.083333333333 }, { label: '1/16 拍', val: 0.0625 }, { label: '自由', val: 0.01 },
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

        <div className="text-[9px] text-white/40 font-mono leading-none mt-0.5">微调</div>
        <button
          onClick={() => onSeekBeat(Math.max(0, Math.floor((currentBeat - 1e-6) / snapSubdivision) * snapSubdivision))}
          className="w-10 h-10 rounded-xl glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 flex items-center justify-center font-bold text-sm transition cursor-pointer"
          title="吸附到上一个节拍"
        >
          ▲ -
        </button>

        <div className="text-xs font-mono font-bold text-amber-300 py-0.5">
          {currentBeat.toFixed(2)}
        </div>

        <button
          onClick={() => onSeekBeat(Math.ceil((currentBeat + 1e-6) / snapSubdivision) * snapSubdivision)}
          className="w-10 h-10 rounded-xl glass-btn border-cyan-500/30 text-cyan-300 hover:text-cyan-200 flex items-center justify-center font-bold text-sm transition cursor-pointer"
          title="吸附到下一个节拍"
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
          title="重置到谱面起点"
        >
          <RotateCcw size={16} />
        </button>

        <div className="flex-1 flex flex-col gap-1">
          <div className="flex justify-between text-[11px] font-mono text-white/70">
            <span className="text-cyan-300 font-bold">Beat {currentBeat.toFixed(2)}</span>
            <span>总长: Beat {getMaxBeat(chart).toFixed(2)}</span>
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

  const typeLabel: Record<EventType, string> = {
    speed_change: '变速',
    text_display: '文字',
    note_color_change: '音符色',
    bg_change: '背景色',
  };

  const typeColor: Record<EventType, { border: string; text: string }> = {
    speed_change: { border: 'border-purple-400/40', text: 'text-purple-300 hover:text-purple-200' },
    text_display: { border: 'border-amber-400/40', text: 'text-amber-300 hover:text-amber-200' },
    note_color_change: { border: 'border-cyan-400/40', text: 'text-cyan-300 hover:text-cyan-200' },
    bg_change: { border: 'border-emerald-400/40', text: 'text-emerald-300 hover:text-emerald-200' },
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
          title="跳转到该拍"
        >
          B{event.beat.toFixed(2)} · {typeLabel[event.eventType]}
        </button>
        <button
          onClick={onDelete}
          className="text-[10px] text-red-400 hover:text-red-300"
          title="删除事件"
        >
          <X size={12} />
        </button>
      </div>
      {expanded && (
        <div className="px-2 pb-2 space-y-1.5 border-t border-white/10">
          <div>
            <label className="text-[10px] text-white/50 block mb-0.5">拍 (Beat)</label>
            <input
              type="number"
              step="0.25"
              value={event.beat}
              onChange={(e) => onUpdate({ beat: parseFloat(e.target.value) || 0 })}
              className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200 text-xs font-mono"
            />
          </div>
          {event.eventType === 'speed_change' && (
            <div>
              <label className="text-[10px] text-white/50 block mb-0.5">速度倍率</label>
              <input
                type="number"
                step="0.1"
                min="0.1"
                max="5"
                value={event.speed ?? 1}
                onChange={(e) => onUpdate({ speed: parseFloat(e.target.value) || 1 })}
                className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200 text-xs font-mono"
              />
            </div>
          )}
          {event.eventType === 'text_display' && (
            <>
              <div>
                <label className="text-[10px] text-white/50 block mb-0.5">显示文字</label>
                <input
                  type="text"
                  value={event.text ?? ''}
                  onChange={(e) => onUpdate({ text: e.target.value })}
                  className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200 text-xs"
                />
              </div>
              <div>
                <label className="text-[10px] text-white/50 block mb-0.5">持续时间 (秒, 0=永久)</label>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  value={event.textDuration ?? 2}
                  onChange={(e) => onUpdate({ textDuration: parseFloat(e.target.value) || 0 })}
                  className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200 text-xs font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-white/50 block mb-0.5">X 位置 [-1,1]</label>
                  <input
                    type="number"
                    step="0.1"
                    value={event.x ?? 0}
                    onChange={(e) => onUpdate({ x: parseFloat(e.target.value) || 0 })}
                    className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-white/50 block mb-0.5">Y 位置 [-1,1]</label>
                  <input
                    type="number"
                    step="0.1"
                    value={event.y ?? -0.33}
                    onChange={(e) => onUpdate({ y: parseFloat(e.target.value) || 0 })}
                    className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200 text-xs font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-white/50 block mb-0.5">字号 (px)</label>
                  <input
                    type="number"
                    step="2"
                    min="8"
                    max="120"
                    value={event.fontSize ?? 36}
                    onChange={(e) => onUpdate({ fontSize: parseFloat(e.target.value) || 36 })}
                    className="w-full glass-input border border-white/12 rounded px-2 py-1 text-cyan-200 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-white/50 block mb-0.5">文字颜色</label>
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
              <label className="text-[10px] text-white/50 block mb-0.5">音符颜色</label>
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
                  <label className="text-[10px] text-white/50 block mb-0.5">背景起始</label>
                  <input
                    type="color"
                    value={event.gradientStart || '#050c1e'}
                    onChange={(e) => onUpdate({ gradientStart: e.target.value })}
                    className="w-full h-7 bg-transparent cursor-pointer"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-white/50 block mb-0.5">背景结束</label>
                  <input
                    type="color"
                    value={event.gradientEnd || '#1b072c'}
                    onChange={(e) => onUpdate({ gradientEnd: e.target.value })}
                    className="w-full h-7 bg-transparent cursor-pointer"
                  />
                </div>
                <p>*此事件暂未实现</p>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
