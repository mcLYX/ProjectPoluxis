import React, { useState } from 'react';
import { ChartData } from '../types/game';
import { parseAndValidateChart } from '../utils/chartParser';
import { Upload, Music, FileCode, CheckCircle, AlertCircle, X } from 'lucide-react';

interface FileManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectCustomSong: (chart: ChartData, audioFile?: File) => void;
}

export const FileManagerModal: React.FC<FileManagerModalProps> = ({
  isOpen,
  onClose,
  onSelectCustomSong,
}) => {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [chartData, setChartData] = useState<ChartData | null>(null);
  const [chartFileName, setChartFileName] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleAudioUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setAudioFile(e.target.files[0]);
    }
  };

  const handleChartUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setChartFileName(file.name);
      const reader = new FileReader();
      reader.onload = (evt) => {
        const text = evt.target?.result as string;
        const res = parseAndValidateChart(text);
        if (res.valid && res.chart) {
          setChartData(res.chart);
          setErrorMessage(null);
        } else {
          setErrorMessage(res.error || '谱面格式不符合规范');
          setChartData(null);
        }
      };
      reader.readAsText(file);
    }
  };

  const handleConfirm = () => {
    if (!chartData) {
      setErrorMessage('未上传 JSON 谱面文件。');
      return;
    }
    onSelectCustomSong(chartData, audioFile || undefined);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md" style={{ paddingTop: 'max(1rem, env(safe-area-inset-top, 0px))', paddingBottom: 'max(1rem, env(safe-area-inset-bottom, 0px))', paddingLeft: 'max(1rem, env(safe-area-inset-left, 0px))', paddingRight: 'max(1rem, env(safe-area-inset-right, 0px))' }}>
      <div className="glass-panel-strong border-white/15 rounded-2xl w-full max-w-xl p-6 text-white font-rajdhani">
        <div className="flex items-center justify-between border-b border-white/10 pb-4 mb-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/15 flex items-center justify-center text-cyan-300 border border-cyan-400/40">
              <Upload size={18} />
            </div>
            <div>
              <h2 className="text-xl font-bold font-orbitron tracking-wider text-white/90">
                谱面上传
              </h2>
              <p className="text-xs text-white/50">Local Audio & JSON Chart Processing (No Server Upload)</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/10 text-white/55 hover:text-white">
            <X size={22} />
          </button>
        </div>

        {errorMessage && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-400/40 rounded-xl flex items-center gap-3 text-red-300 text-xs">
            <AlertCircle size={18} className="shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        <div className="space-y-4 mb-6">
          {/* Audio Upload */}
          <div className="p-4 rounded-xl glass-sub border border-white/10">
            <label className="block text-sm font-bold text-white mb-2 flex items-center gap-2">
              <Music size={16} /> 1. 音频文件上传
            </label>
            <input
              type="file"
              accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac"
              onChange={handleAudioUpload}
              className="w-full text-xs text-white/50 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-cyan-500/20 file:text-cyan-300 hover:file:bg-cyan-500/30 cursor-pointer"
            />
            {audioFile && (
              <div className="mt-2 text-xs text-emerald-400 flex items-center gap-1.5">
                <CheckCircle size={14} /> 已就绪: {audioFile.name} ({(audioFile.size / 1024 / 1024).toFixed(2)} MB)
              </div>
            )}
          </div>

          {/* Chart JSON Upload */}
          <div className="p-4 rounded-xl glass-sub border border-white/10">
            <label className="block text-sm font-bold text-white mb-2 flex items-center gap-2">
              <FileCode size={16} /> 2. 谱面 JSON 文件上传 
            </label>
            <input
              type="file"
              accept=".json,application/json"
              onChange={handleChartUpload}
              className="w-full text-xs text-white/50 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-cyan-500/20 file:text-cyan-300 hover:file:bg-cyan-500/30 cursor-pointer"
            />
            {chartData && (
              <div className="mt-2 text-xs text-emerald-400 flex items-center gap-1.5">
                <CheckCircle size={14} /> 校验通过: {chartFileName} ({chartData.notes.length} 个音符, {chartData.metadata.difficulty})
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="glass-btn px-5 py-2 rounded-xl text-white/80 font-semibold"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            className="px-6 py-2 rounded-xl glass-btn-primary font-bold transition cursor-pointer active:scale-95"
          >
            加载并开始游戏
          </button>
        </div>
      </div>
    </div>
  );
};
