import { useState } from 'react';
import { Sliders, Volume2, Focus, Eye, Maximize2, X, Zap } from 'lucide-react';
import type { QualityMode } from '../types/game';
import { useI18n, LANGS } from '../i18n';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  speedMultiplier: number;
  setSpeedMultiplier: (value: number) => void;
  audioOffsetMs: number;
  setAudioOffsetMs: (value: number) => void;
  projectionLeadMs: number;
  setProjectionLeadMs: (value: number) => void;
  noteRenderDistance: number;
  setNoteRenderDistance: (value: number) => void;
  noteSizeScale: number;
  setNoteSizeScale: (value: number) => void;
  qualityMode: QualityMode;
  setQualityMode: (value: QualityMode) => void;
  musicVolume: number;
  setMusicVolume: (value: number) => void;
  effectVolume: number;
  setEffectVolume: (value: number) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  speedMultiplier,
  setSpeedMultiplier,
  audioOffsetMs,
  setAudioOffsetMs,
  projectionLeadMs,
  setProjectionLeadMs,
  noteRenderDistance,
  setNoteRenderDistance,
  noteSizeScale,
  setNoteSizeScale,
  qualityMode,
  setQualityMode,
  musicVolume,
  setMusicVolume,
  effectVolume,
  setEffectVolume,
}) => {
  const { t, lang, setLang } = useI18n();
  const [tab, setTab] = useState<'graphics' | 'sound'>('graphics');
  if (!isOpen) return null;

  const sliderClass = 'w-full accent-cyan-400 cursor-pointer';
  const valueClass = 'font-mono text-cyan-200 text-sm min-w-20 text-right';

  const qualityIdx: Record<QualityMode, number> = { low: 0, standard: 1, high: 2, ultra: 3 };
  const qualityOrder: QualityMode[] = ['low', 'standard', 'high', 'ultra'];
  const qualityLabel = (q: QualityMode) => t(`settings.quality.${q}`);
  const qualityDesc = (q: QualityMode) => t(`settings.quality.desc.${q}`);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
      <div className="glass-panel-strong w-full max-w-xl rounded-2xl border-white/15 p-5 sm:p-6 text-white font-rajdhani max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-white/10 pb-4 mb-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-cyan-500/15 border border-cyan-400/40 flex items-center justify-center text-cyan-300">
              <Sliders size={18} />
            </div>
            <div>
              <h2 className="text-xl font-bold font-orbitron tracking-wider text-white/90">{t('settings.title')}</h2>
              <p className="text-xs text-white/50">{t('settings.subtitle')}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/10 text-white/55 hover:text-white transition">
            <X size={22} />
          </button>
        </div>

        <div className="grid grid-cols-2 border-b border-white/10 mb-5">
          <button onClick={() => setTab('graphics')} className={`py-2.5 font-bold border-b-2 cursor-pointer ${tab === 'graphics' ? 'border-cyan-400 text-cyan-300 bg-cyan-500/5' : 'border-transparent text-white/55'}`}>{t('settings.tab.graphics')}</button>
          <button onClick={() => setTab('sound')} className={`py-2.5 font-bold border-b-2 cursor-pointer ${tab === 'sound' ? 'border-cyan-400 text-cyan-300 bg-cyan-500/5' : 'border-transparent text-white/55'}`}>{t('settings.tab.sound')}</button>
        </div>

        {tab === 'graphics' ? <div className="space-y-5">
          <section className="space-y-1.5">
            <div className="flex justify-between">
              <label className="flex items-center gap-2 text-sm font-bold text-cyan-300"><Zap size={16} /> {t('settings.effects')}</label>
              <span className={valueClass}>{qualityLabel(qualityMode)}</span>
            </div>
            <input
              type="range"
              min="0" max="3" step="1"
              value={qualityIdx[qualityMode]}
              onChange={(e) => setQualityMode(qualityOrder[Number(e.target.value)])}
              className={sliderClass}
            />
            <div className="flex justify-between text-[11px] text-white/40 font-mono">
              <span>{qualityLabel('low')}</span><span>{qualityLabel('standard')}</span><span>{qualityLabel('high')}</span><span>{qualityLabel('ultra')}</span>
            </div>
            <p className="text-[11px] text-white/50 leading-relaxed">{qualityDesc(qualityMode)}</p>
          </section>

          <section className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm font-bold text-cyan-300">
                <Sliders size={16} /> {t('settings.noteSpeed')}
              </label>
              <span className={valueClass}>{speedMultiplier.toFixed(1)}x</span>
            </div>
            <input
              type="range"
              min="0.5"
              max="4"
              step="0.1"
              value={speedMultiplier}
              onChange={(e) => setSpeedMultiplier(Number(e.target.value))}
              className={sliderClass}
            />
            <div className="flex justify-between text-[11px] text-white/40 font-mono">
              <span>0.5x</span><span>4.0x</span>
            </div>
            <p className="text-[11px] text-white/50 leading-relaxed">
              {t('settings.noteSpeedHint')}
            </p>
          </section>

          <section className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm font-bold text-cyan-300">
                <Eye size={16} /> {t('settings.renderDist')}
              </label>
              <span className={valueClass}>{noteRenderDistance} 深度</span>
            </div>
            <input
              type="range"
              min="20"
              max="120"
              step="5"
              value={noteRenderDistance}
              onChange={(e) => setNoteRenderDistance(Number(e.target.value))}
              className={sliderClass}
            />
            <p className="text-[11px] text-white/50 leading-relaxed">
              {t('settings.renderDistHint')}
            </p>
          </section>

          <section className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm font-bold text-cyan-300">
                <Maximize2 size={16} /> {t('settings.noteSize')}
              </label>
              <span className={valueClass}>{(noteSizeScale * 100).toFixed(0)}% ({noteSizeScale.toFixed(2)})</span>
            </div>
            <input
              type="range"
              min="0.6"
              max="1.0"
              step="0.05"
              value={noteSizeScale}
              onChange={(e) => setNoteSizeScale(Number(e.target.value))}
              className={sliderClass}
            />
            <p className="text-[11px] text-white/50 leading-relaxed">
              {t('settings.noteSizeHint')}
            </p>
          </section>

          <section className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm font-bold text-cyan-300">
                <Focus size={16} /> {t('settings.projLead')}
              </label>
              <span className={valueClass}>{projectionLeadMs}ms</span>
            </div>
            <input
              type="range"
              min="0"
              max="1000"
              step="10"
              value={projectionLeadMs}
              onChange={(e) => setProjectionLeadMs(Number(e.target.value))}
              className={sliderClass}
            />
            <p className="text-[11px] text-white/50 leading-relaxed">
              {t('settings.projLeadHint')}
            </p>
          </section>
        </div> : <div className="space-y-6">
          <section className="space-y-1.5">
            <div className="flex justify-between"><label className="text-sm font-bold text-cyan-300">{t('settings.musicVol')}</label><span className={valueClass}>{Math.round(musicVolume * 100)}%</span></div>
            <input type="range" min="0" max="1" step="0.01" value={musicVolume} onChange={(e) => setMusicVolume(Number(e.target.value))} className={sliderClass} />
            <p className="text-[11px] text-white/50 leading-relaxed">
              {t('settings.musicVolHint')}
            </p>
          </section>
          <section className="space-y-1.5">
            <div className="flex justify-between"><label className="flex items-center gap-2 text-sm font-bold text-cyan-300"><Volume2 size={16} /> {t('settings.sfxVol')}</label><span className={valueClass}>{Math.round(effectVolume * 100)}%</span></div>
            <input type="range" min="0" max="1" step="0.01" value={effectVolume} onChange={(e) => setEffectVolume(Number(e.target.value))} className={sliderClass} />
            <p className="text-[11px] text-white/50 leading-relaxed">
              {t('settings.sfxVolHint')}
            </p>
          </section>
          <section className="space-y-1.5">
            <div className="flex justify-between"><label className="flex items-center gap-2 text-sm font-bold text-cyan-300"><Focus size={16} /> {t('settings.audioOffset')}</label><span className={valueClass}>{audioOffsetMs > 0 ? '+' : ''}{audioOffsetMs}ms</span></div>
            <input type="range" min="-600" max="600" step="5" value={audioOffsetMs} onChange={(e) => setAudioOffsetMs(Number(e.target.value))} className={sliderClass} />
            <div className="flex justify-between text-[11px] text-white/40 font-mono"><span>-600ms</span><span>0ms</span><span>+600ms</span></div>
            <p className="text-[11px] text-white/50 leading-relaxed">
              {t('settings.audioOffsetHint')}
            </p>
          </section>
        </div>}

        <div className="mt-6 border-t border-white/10 pt-4 space-y-4">
          <div>
            <div className="text-xs font-bold text-white/55 mb-2">{t('settings.language')}</div>
            <div className="flex gap-2">
              {LANGS.map((l) => (
                <button
                  key={l.code}
                  onClick={() => setLang(l.code)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-bold transition cursor-pointer ${
                    lang === l.code ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/50' : 'bg-white/5 text-white/60 border border-white/10 hover:bg-white/10'
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-end">
            <button onClick={onClose} className="px-6 py-2 rounded-xl glass-btn-primary font-bold transition cursor-pointer active:scale-95">
              {t('settings.done')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
