import { useState } from 'react';
import { ChartData, NoteData } from '../types/game';
import { exportChartJson } from '../utils/chartParser';
import { Plus, Trash2, Download, X } from 'lucide-react';

interface ChartEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentChart: ChartData;
  onSaveChart: (newChart: ChartData) => void;
}

export const ChartEditorModal: React.FC<ChartEditorModalProps> = ({
  isOpen,
  onClose,
  currentChart,
  onSaveChart,
}) => {
  const [chart, setChart] = useState<ChartData>(currentChart);
  const [activeTab, setActiveTab] = useState<'notes' | 'json'>('notes');
  const [jsonText, setJsonText] = useState<string>(exportChartJson(currentChart));

  if (!isOpen) return null;

  const handleAddNote = () => {
    const newNote: NoteData = {
      id: `custom-${Date.now().toString().slice(-4)}`,
      beat: Math.round(((chart.notes[chart.notes.length - 1]?.beat || 1) + 1) * 100) / 100,
      x: 0,
      y: 0,
      type: 'tap',
    };
    const updated = { ...chart, notes: [...chart.notes, newNote] };
    setChart(updated);
    setJsonText(exportChartJson(updated));
  };

  const handleRemoveNote = (id: string) => {
    const updated = { ...chart, notes: chart.notes.filter((n) => n.id !== id) };
    setChart(updated);
    setJsonText(exportChartJson(updated));
  };

  const handleNoteChange = (index: number, field: keyof NoteData, val: unknown) => {
    const newNotes = [...chart.notes];
    newNotes[index] = { ...newNotes[index], [field]: val };
    const updated = { ...chart, notes: newNotes };
    setChart(updated);
    setJsonText(exportChartJson(updated));
  };

  const handleSave = () => {
    onSaveChart(chart);
    onClose();
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4">
      <div className="bg-[#0c142b] border border-cyan-500/40 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl text-white font-rajdhani">
        <div className="flex items-center justify-between p-5 border-b border-cyan-500/20">
          <div>
            <h2 className="text-xl font-bold font-orbitron tracking-wider text-cyan-300">
              谱面编辑器 (Chart Editor)
            </h2>
            <p className="text-xs text-gray-400">
              编辑节拍(beat)、坐标(x,y)、类型(Tap/Touch) — beat 基于 BPM ({chart.metadata.bpm}) 换算时间
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white">
            <X size={22} />
          </button>
        </div>

        <div className="flex items-center gap-4 px-6 pt-4 border-b border-cyan-500/20">
          <button
            onClick={() => setActiveTab('notes')}
            className={`pb-2 font-bold text-sm tracking-wider cursor-pointer border-b-2 transition ${
              activeTab === 'notes' ? 'border-cyan-400 text-cyan-300' : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            音符列表 ({chart.notes.length})
          </button>
          <button
            onClick={() => { setJsonText(exportChartJson(chart)); setActiveTab('json'); }}
            className={`pb-2 font-bold text-sm tracking-wider cursor-pointer border-b-2 transition ${
              activeTab === 'json' ? 'border-cyan-400 text-cyan-300' : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            JSON 源码视图
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 space-y-4">
          {activeTab === 'notes' ? (
            <div className="space-y-3">
              <div className="grid grid-cols-12 gap-2 text-xs font-bold text-cyan-400 uppercase px-2">
                <span className="col-span-2">序号 / ID</span>
                <span className="col-span-2">节拍 (beat)</span>
                <span className="col-span-3">X 坐标</span>
                <span className="col-span-3">Y 坐标</span>
                <span className="col-span-1">类型</span>
                <span className="col-span-1 text-center">操作</span>
              </div>

              {chart.notes.map((note, idx) => (
                <div key={note.id} className="grid grid-cols-12 gap-2 items-center p-2.5 rounded-xl bg-[#0e1c3d] border border-cyan-500/20 text-sm">
                  <span className="col-span-2 font-mono text-xs text-gray-300 truncate">#{idx + 1} {note.id}</span>
                  <input
                    type="number" step="0.25" value={note.beat}
                    onChange={(e) => handleNoteChange(idx, 'beat', parseFloat(e.target.value) || 0)}
                    className="col-span-2 bg-[#070e20] border border-cyan-500/30 rounded px-2 py-1 text-cyan-300 font-mono text-xs"
                  />
                  <input
                    type="number" step="any" min="-2.4" max="2.4" value={note.x}
                    onChange={(e) => handleNoteChange(idx, 'x', parseFloat(e.target.value) || 0)}
                    className="col-span-3 bg-[#070e20] border border-cyan-500/30 rounded px-2 py-1 text-cyan-300 font-mono text-xs"
                  />
                  <input
                    type="number" step="any" min="-1.5" max="1.5" value={note.y}
                    onChange={(e) => handleNoteChange(idx, 'y', parseFloat(e.target.value) || 0)}
                    className="col-span-3 bg-[#070e20] border border-cyan-500/30 rounded px-2 py-1 text-cyan-300 font-mono text-xs"
                  />
                  <select
                    value={note.type}
                    onChange={(e) => handleNoteChange(idx, 'type', e.target.value as 'tap' | 'touch')}
                    className="col-span-1 bg-[#070e20] border border-cyan-500/30 rounded px-1 py-1 text-xs text-cyan-200"
                  >
                    <option value="tap">Tap</option>
                    <option value="touch">Touch</option>
                  </select>
                  <button onClick={() => handleRemoveNote(note.id)} className="col-span-1 flex justify-center text-red-400 hover:text-red-300 p-1">
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}

              <button onClick={handleAddNote} className="w-full flex items-center justify-center gap-2 py-2.5 border-2 border-dashed border-cyan-500/40 rounded-xl hover:bg-cyan-500/10 text-cyan-300 font-bold transition cursor-pointer">
                <Plus size={18} />
                添加新音符
              </button>
            </div>
          ) : (
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              className="w-full h-80 bg-[#070e20] border border-cyan-500/30 rounded-xl p-4 font-mono text-xs text-cyan-300 focus:outline-none focus:border-cyan-400"
            />
          )}
        </div>

        <div className="flex items-center justify-between p-5 border-t border-cyan-500/20 bg-[#091024]">
          <button onClick={handleDownloadJson} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-900/40 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-900/60 font-semibold transition cursor-pointer">
            <Download size={16} /> 导出 JSON
          </button>
          <div className="flex gap-3">
            <button onClick={onClose} className="px-5 py-2 rounded-xl border border-gray-600 hover:bg-white/5 text-gray-300 font-semibold transition">取消</button>
            <button onClick={handleSave} className="px-6 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-bold shadow-lg shadow-cyan-500/30 transition cursor-pointer">保存并应用</button>
          </div>
        </div>
      </div>
    </div>
  );
};
