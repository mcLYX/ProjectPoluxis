import React from 'react';
import { BookOpen, X, Sparkles, Layers } from 'lucide-react';

interface DocModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DocModal: React.FC<DocModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
      <div className="glass-panel-strong border-white/15 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col text-white font-rajdhani">
        <div className="flex items-center justify-between p-5 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/15 flex items-center justify-center text-cyan-300 border border-cyan-400/40">
              <BookOpen size={18} />
            </div>
            <div>
              <h2 className="text-xl font-bold font-orbitron tracking-wider text-white/90">
                Project Polygon 说明
              </h2>
              <p className="text-xs text-white/50">Gameplay Mechanics, Note Types & Chart Format Specifications</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/10 text-white/55 hover:text-white">
            <X size={22} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-6 text-sm">
          {/* Section 1: Note Types */}
          <div className="p-4 rounded-xl glass-sub border border-white/10">
            <h3 className="font-bold font-orbitron text-cyan-300 mb-3 flex items-center gap-2">
              <Layers size={16} /> 1. 音符类型与交互方式 (Note Types)
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="p-3 bg-white/[0.04] rounded-lg border border-white/10">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-cyan-400 text-sm">■ Tap 音符 (方形线框)</span>
                </div>
                <p className="text-white/70">
                  视觉样式为发光的方形线框与半透明内层。玩家需在音符飞至判定平面 (Z=0) 瞬间进行鼠标点击或触屏敲击。
                </p>
              </div>

              <div className="p-3 bg-white/[0.04] rounded-lg border border-white/10">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-sky-400 text-sm">● Touch 音符 (圆形线框)</span>
                </div>
                <p className="text-white/70">
                  视觉样式为发光的圆形线框。玩家不需主动点击，只需在音符飞至判定平面时，将手指或鼠标移到对应位置。
                </p>
              </div>

              <div className="p-3 bg-white/[0.04] rounded-lg border border-emerald-500/30 md:col-span-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-emerald-400 text-sm">◆ Slide 音符 (45° 菱形链)</span>
                </div>
                <p className="text-white/70">
                  视觉样式为发光的菱形线框，其间有半透明管道连接。玩家需在音符飞至判定平面时，按住鼠标或手指，跟随管道移动。
                </p>
              </div>
            </div>
          </div>

          {/* Section: Beat-based timing */}
          <div className="p-4 rounded-xl glass-sub border border-white/10">
            <h3 className="font-bold font-orbitron text-emerald-300 mb-3 flex items-center gap-2">
              <Sparkles size={16} /> 2. 节拍时间轴 (Beat-based Timing)
            </h3>
            <div className="text-xs text-white/70 space-y-1">
              <p>谱面音符的 <code className="text-cyan-300 bg-white/[0.06] px-1 rounded">beat</code> 字段表示节拍数（非秒数）。</p>
              <p>换算公式：<code className="text-cyan-300 bg-white/[0.06] px-1 rounded">timeSec = offset + (beat × 60 / BPM)</code></p>
              <p>示例：BPM=120, beat=4, offset=0 → 4 × 60 / 120 = <span className="text-amber-300">2.0 秒</span></p>
            </div>
          </div>

          {/* Section 3: Judgement & Scoring */}
          <div className="p-4 rounded-xl glass-sub border border-white/10">
            <h3 className="font-bold font-orbitron text-amber-300 mb-3 flex items-center gap-2">
              <Sparkles size={16} /> 3. 判定窗口与计分体系 (Judgement & Scoring)
            </h3>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between p-2 rounded bg-orange-500/10 border border-orange-500/30">
                <span className="text-orange-400 font-bold">S-Perfect (橙色发光)</span>
                <span className="font-mono text-white">|Δt| &lt; 40ms | 得分: (10,000,000 ÷ N) + 1</span>
              </div>
              <div className="flex justify-between p-2 rounded bg-yellow-500/10 border border-yellow-500/30">
                <span className="text-yellow-300 font-bold">Perfect (黄色发光)</span>
                <span className="font-mono text-white">40ms ≤ |Δt| &lt; 80ms | 得分: 10,000,000 ÷ N</span>
              </div>
              <div className="flex justify-between p-2 rounded bg-sky-500/10 border border-sky-500/30">
                <span className="text-sky-400 font-bold">Good (天蓝色发光)</span>
                <span className="font-mono text-white">80ms ≤ |Δt| &lt; 160ms | 得分: (10,000,000 ÷ N) × 0.5</span>
              </div>
              <div className="flex justify-between p-2 rounded bg-red-500/10 border border-red-500/30">
                <span className="text-red-400 font-bold">Miss (漏击)</span>
                <span className="font-mono text-white">音符完全越过判定平面后未击中 | 得分: 0</span>
              </div>
            </div>
          </div>
          <p>v0.0.1</p>
        </div>
        
        <div className="p-4 border-t border-white/10 flex justify-end bg-white/[0.03]">
          
          <button
            onClick={onClose}
            className="px-6 py-2 rounded-xl glass-btn-primary font-bold transition cursor-pointer active:scale-95"
          >
            我已了解
          </button>
        </div>
      </div>
    </div>
  );
};