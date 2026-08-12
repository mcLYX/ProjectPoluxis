import { useState } from 'react';
import { Sliders, Volume2, Focus, Eye, Maximize2, X, Zap, Languages } from 'lucide-react';
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

type SettingsTab = 'graphics' | 'sound' | 'language';

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
  const [tab, setTab] = useState<SettingsTab>('graphics');
  if (!isOpen) return null;

  const sliderClass = 'w-full accent-cyan-400 cursor-pointer';
  const valueClass = 'font-mono text-cyan-200 text-sm min-w-20 text-right';

  const qualityIdx: Record<QualityMode, number> = { low: 0, standard: 1, high: 2, ultra: 3 };
  const qualityOrder: QualityMode[] = ['low', 'standard', 'high', 'ultra'];
  const qualityLabel = (q: QualityMode) => t(`settings.quality.${q}`);
  const qualityDesc = (q: QualityMode) => t(`settings.quality.desc.${q}`);

  const tabs: { key: SettingsTab; label: string; icon: typeof Sliders }[] = [
    { key: 'graphics', label: t('settings.tab.graphics'), icon: Sliders },
    { key: 'sound', label: t('settings.tab.sound'), icon: Volume2 },
    { key: 'language', label: t('settings.tab.language'), icon: Languages },
  ];

  const graphicsContent = (
    <div className="space-y-5">
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
          max="2000"
          step="20"
          value={projectionLeadMs}
          onChange={(e) => setProjectionLeadMs(Number(e.target.value))}
          className={sliderClass}
        />
        <p className="text-[11px] text-white/50 leading-relaxed">
          {t('settings.projLeadHint')}
        </p>
      </section>
    </div>
  );

  const soundContent = (
    <div className="space-y-6">
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
        <input type="range" min="-600" max="400" step="5" value={audioOffsetMs} onChange={(e) => setAudioOffsetMs(Number(e.target.value))} className={sliderClass} />
        <div className="flex justify-between text-[11px] text-white/40 font-mono"><span>-600ms</span><span>+400ms</span></div>
        <p className="text-[11px] text-white/50 leading-relaxed">
          {t('settings.audioOffsetHint')}
        </p>
      </section>
    </div>
  );

  const languageContent = (
    <div className="space-y-4">
      <div className="text-sm font-bold text-cyan-300">{t('settings.language')}</div>
      <div className="flex flex-wrap gap-2">
        {LANGS.map((l) => (
          <button
            key={l.code}
            onClick={() => setLang(l.code)}
            className={`px-4 py-2 rounded-xl text-sm font-bold transition cursor-pointer ${
              lang === l.code ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/50' : 'bg-white/5 text-white/60 border border-white/10 hover:bg-white/10'
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-white/45 leading-relaxed">
        {t('settings.languageHint')}
      </p>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md" style={{ paddingTop: 'max(1rem, env(safe-area-inset-top, 0px))', paddingBottom: 'max(1rem, env(safe-area-inset-bottom, 0px))', paddingLeft: 'max(1rem, env(safe-area-inset-left, 0px))', paddingRight: 'max(1rem, env(safe-area-inset-right, 0px))' }}>
      <div className="glass-panel-strong settings-modal relative w-full max-w-3xl rounded-2xl border border-white/15 overflow-hidden flex flex-col text-white font-rajdhani">

        {/* 顶部栏：标题 + 右上角固定关闭按钮 */}
        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-3.5 border-b border-white/10 bg-white/[0.03]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/15 border border-cyan-400/40 flex items-center justify-center text-cyan-300 shrink-0">
              <Sliders size={16} />
            </div>
            <h2 className="text-lg font-bold font-orbitron tracking-wider text-white/90 truncate">{t('settings.title')}</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 p-1.5 rounded-lg hover:bg-white/10 text-white/55 hover:text-white transition"
          >
            <X size={20} />
          </button>
        </div>

        {/* 双栏主体：窄屏(竖屏)上下堆叠，桌面左右双栏 */}
        <div className="flex flex-col sm:flex-row flex-1 min-h-0">
          {/* 左侧边栏导航 */}
          <aside className="w-full sm:w-52 shrink-0 border-b sm:border-b-0 sm:border-r border-white/10 bg-white/[0.03] flex sm:flex-col overflow-x-auto sm:overflow-y-auto">
            <nav className="flex sm:flex-col p-2 gap-1">
              {tabs.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold transition cursor-pointer whitespace-nowrap ${
                    tab === key
                      ? 'bg-cyan-500/15 text-cyan-200 border border-cyan-400/40'
                      : 'text-white/60 hover:bg-white/5 hover:text-white/80 border border-transparent'
                  }`}
                >
                  <Icon size={18} />
                  {label}
                </button>
              ))}
            </nav>
          </aside>

          {/* 右侧内容区（独立滚动，X 固定不随内容滚动） */}
          <div className="flex-1 min-w-0 min-h-0 overflow-y-auto p-5 sm:p-6">
            {tab === 'graphics' && graphicsContent}
            {tab === 'sound' && soundContent}
            {tab === 'language' && languageContent}
          </div>
        </div>
      </div>
    </div>
  );
};
