import { useEffect, useRef, useState } from 'react';
import {
  Sliders, Volume2, Focus, Eye, Maximize2, X, Zap, Languages, Globe, Info, Palette,
  User, Upload, Trash2, LogIn, LogOut, Gauge, Gamepad2,
} from 'lucide-react';
import type { QualityMode } from '../types/game';
import { useI18n, LANGS } from '../i18n';
import { NetworkSettings } from './NetworkSettings';
import { DocContent } from './DocModal';
import SkinManager from './SkinManager';
// R4-6: quality 渲染设置改由模块级 qualityStore 承载（不再经 App props 传递）。
import { qualityStore, useQuality, type QualityState, PRESET_VALUES } from '../qualityStore';
// 账号切片：模块级 accountStore（与 qualityStore 同范式），避免经 App props 透传。
import { accountStore, getDisplayAccount, normalizeNickname, MAX_NICKNAME_LENGTH, useAccount } from '../accountStore';
import { storeAvatar, validateAvatarFile, type AvatarReject } from '../utils/avatar';
import { useAvatarUrl } from '../hooks/useAvatarUrl';
import { usePlatform } from '../platform/PlatformContext';
import { hasPlatformIdentity } from '../platform';

/** 自定义档位下的单项开关（抗锯齿 / Bloom / 粒子）。 */
const QualityToggle: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }> = ({
  label,
  checked,
  onChange,
  disabled = false,
}) => (
  <label className={`flex items-center justify-between p-3 rounded-xl bg-white/[0.04] border border-white/10 ${disabled ? 'opacity-40 pointer-events-none' : 'cursor-pointer'}`}>
    <span className="text-sm text-white/80">{label}</span>
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative w-11 h-6 rounded-full transition-colors ${checked ? 'bg-cyan-500/70' : 'bg-white/15'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : ''}`}
      />
    </button>
  </label>
);

/** 各预设对应的自定义项有效值（不含帧率上限）来自 qualityStore.PRESET_VALUES，
 *  切换预设时据此把值同步写入 custom*，用于「切换预设时同步展示」。 */

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
  // qualityMode + 5×custom* 已下沉 qualityStore，不再经 props 传入。
  musicVolume: number;
  setMusicVolume: (value: number) => void;
  effectVolume: number;
  setEffectVolume: (value: number) => void;
  compatMode: boolean;
  setCompatMode: (value: boolean) => void;
  selectedSkinId: string | null;
  setSelectedSkinId: (value: string | null) => void;
  defaultSkinInnerEnabled: boolean;
  setDefaultSkinInnerEnabled: (value: boolean) => void;
  defaultSkinOuterEnabled: boolean;
  setDefaultSkinOuterEnabled: (value: boolean) => void;
  defaultSkinOuterWidth: number;
  setDefaultSkinOuterWidth: (value: number) => void;
  defaultSkinOuterColor: string;
  setDefaultSkinOuterColor: (value: string) => void;
  defaultSkinOuterAlpha: number;
  setDefaultSkinOuterAlpha: (value: number) => void;
  defaultSkinJudgeWidth: number;
  setDefaultSkinJudgeWidth: (value: number) => void;
}

type SettingsTab = 'game' | 'graphics' | 'skin' | 'account' | 'sound' | 'language' | 'network' | 'about';

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
  musicVolume,
  setMusicVolume,
  effectVolume,
  setEffectVolume,
  compatMode,
  setCompatMode,
  selectedSkinId,
  setSelectedSkinId,
  defaultSkinInnerEnabled, setDefaultSkinInnerEnabled,
  defaultSkinOuterEnabled, setDefaultSkinOuterEnabled,
  defaultSkinOuterWidth, setDefaultSkinOuterWidth,
  defaultSkinOuterColor, setDefaultSkinOuterColor,
  defaultSkinOuterAlpha, setDefaultSkinOuterAlpha,
  defaultSkinJudgeWidth, setDefaultSkinJudgeWidth,
}) => {
  const { t, lang, setLang } = useI18n();
  const [tab, setTab] = useState<SettingsTab>('graphics');
  // R4-6: quality 切片从 qualityStore 订阅（仅本组件重渲染）。
  const quality = useQuality();
  /* ---- 账号切片（必须在 isOpen 早退之前声明，保证 hook 顺序稳定） ---- */
  const account = useAccount();
  const display = getDisplayAccount(account);
  const avatarUrl = useAvatarUrl(display.avatar);
  const { platform } = usePlatform();
  /** 当前构建是否支持绑定平台账号（公开版恒为 false）。 */
  const canLink = hasPlatformIdentity();
  /** 已绑定平台身份时，头像/昵称只读，需先登出。 */
  const readOnly = account.linked;
  const [nameDraft, setNameDraft] = useState(display.nickname);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<AvatarReject | 'generic' | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setNameDraft(display.nickname);
  }, [display.nickname]);
  // 切换左侧栏目时把右侧滚动容器滚回顶部：否则上一栏（较长）遗留的 scrollTop 会套到
  // 新栏（较短）内容上，表现为「滑动一半并卡住」，移动端惯性滑动中还会冻结原生滚动。
  // rAF 再补一次以覆盖 iOS 惯性滚动（useEffect 提交后、下一帧前 momentum 才停）。
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    el.scrollTop = 0;
    const id = requestAnimationFrame(() => { el.scrollTop = 0; });
    return () => cancelAnimationFrame(id);
  }, [tab]);

  if (!isOpen) return null;

  const sliderClass = 'w-full accent-cyan-400 cursor-pointer';
  const valueClass = 'font-mono text-cyan-200 text-sm min-w-20 text-right';

  const qualityIdx: Record<QualityMode, number> = { lite: 0, low: 1, standard: 2, high: 3, ultra: 4, custom: 5 };
  const qualityOrder: QualityMode[] = ['lite', 'low', 'standard', 'high', 'ultra', 'custom'];
  // 帧率上限选项（0 = 不限帧）。
  const MAX_FPS_OPTIONS = [30, 60, 90, 120, 0];
  const qualityLabel = (q: QualityMode) => t(`settings.quality.${q}`);
  const qualityDesc = (q: QualityMode) => t(`settings.quality.desc.${q}`);

  const tabs: { key: SettingsTab; label: string; icon: typeof Sliders }[] = [
    { key: 'game', label: t('settings.tab.game'), icon: Gamepad2 },
    { key: 'graphics', label: t('settings.tab.graphics'), icon: Sliders },
    { key: 'skin', label: t('settings.tab.skin'), icon: Palette },
    { key: 'account', label: t('settings.tab.account'), icon: User },
    { key: 'sound', label: t('settings.tab.sound'), icon: Volume2 },
    // 「网络」（自选服务器）仅在非平台版提供；平台版由平台侧统一托管内容。
    ...(canLink ? [] : [{ key: 'network' as SettingsTab, label: t('settings.tab.network'), icon: Globe }]),
    { key: 'language', label: t('settings.tab.language'), icon: Languages },
    { key: 'about', label: t('settings.tab.about'), icon: Info },
  ];

  // 「画面预设」切换：选中某个具体预设时，把该预设的自定义项有效值同步写入
  // （帧率上限除外），实现下方自定义滑块的展示联动；选中「自定义」则保持现有值不变。
  const applyPreset = (mode: QualityMode): void => {
    if (mode === 'custom') { qualityStore.set({ qualityMode: 'custom' }); return; }
    const p = PRESET_VALUES[mode];
    qualityStore.set({
      qualityMode: mode,
      customAntialias: p.customAntialias,
      customBloom: p.customBloom,
      customParticles: p.customParticles,
      customDynamicLighting: p.customDynamicLighting,
      customHitEffects: p.customHitEffects,
      customRenderScale: p.customRenderScale,
    });
  };
  // 手动修改任一自定义项（帧率除外）→ 画面预设立即跳回「自定义」，并写入该值。
  const editCustom = (patch: Partial<QualityState>): void => {
    qualityStore.set({ ...patch, qualityMode: 'custom' });
  };
  // Lite 预设下，除帧率上限外的所有自定义项置灰不可用。
  const isLitePreset = quality.qualityMode === 'lite';
  const customOptDisabled = isLitePreset;

  const graphicsContent = (
    <div className="space-y-5">
      <section className="space-y-1.5">
        <div className="flex justify-between">
          <label className="flex items-center gap-2 text-sm font-bold text-cyan-300"><Zap size={16} /> {t('settings.preset')}</label>
          <span className={valueClass}>{qualityLabel(quality.qualityMode)}</span>
        </div>
        <input
          type="range"
          min="0" max="5" step="1"
          value={qualityIdx[quality.qualityMode]}
          onChange={(e) => applyPreset(qualityOrder[Number(e.target.value)])}
          className={sliderClass}
        />
        <div className="flex justify-between text-[11px] text-white/40 font-mono">
          <span>{qualityLabel('lite')}</span><span>{qualityLabel('low')}</span><span>{qualityLabel('standard')}</span><span>{qualityLabel('high')}</span><span>{qualityLabel('ultra')}</span><span>{qualityLabel('custom')}</span>
        </div>
        <p className="text-[11px] text-white/50 leading-relaxed">{qualityDesc(quality.qualityMode)}</p>
      </section>

      <section className="space-y-1.5">
        <div className="flex justify-between">
          <label className="flex items-center gap-2 text-sm font-bold text-cyan-300"><Gauge size={16} /> {t('settings.maxFps')}</label>
          <span className={valueClass}>{quality.maxFps === 0 ? '∞' : `${quality.maxFps} fps`}</span>
        </div>
        <input
          type="range"
          min="0" max="4" step="1"
          value={Math.max(0, MAX_FPS_OPTIONS.indexOf(quality.maxFps))}
          onChange={(e) => qualityStore.set({ maxFps: MAX_FPS_OPTIONS[Number(e.target.value)] })}
          className={sliderClass}
        />
        <div className="flex justify-between text-[11px] text-white/40 font-mono">
          <span>30</span><span>60</span><span>90</span><span>120</span><span>∞</span>
        </div>
        <p className="text-[11px] text-white/50 leading-relaxed">{t('settings.maxFpsHint')}</p>
      </section>

      {/* 自定义项：始终展示（不再限定为「自定义」预设），作为常规区域；
          修改其中任意一项（帧率除外）→ 画面预设立即跳回「自定义」；
          Lite 预设下整体置灰不可用。 */}
      <section className={`space-y-1.5 transition-opacity ${customOptDisabled ? 'opacity-40 pointer-events-none' : ''}`}>
        <div className="flex items-center justify-between gap-3">
          <label className="text-sm font-medium text-white/80">{t('settings.custom.renderScale')}</label>
          <span className={valueClass}>{(quality.customRenderScale * 100).toFixed(0)}%</span>
        </div>
        <input
          type="range"
          min="0.25"
          max="2"
          step="0.05"
          value={quality.customRenderScale}
          disabled={customOptDisabled}
          onChange={(e) => editCustom({ customRenderScale: Number(e.target.value) })}
          className={sliderClass}
        />
        <div className="flex justify-between text-[11px] text-white/40 font-mono">
          <span>25%</span><span>200%</span>
        </div>
        <p className="text-[11px] text-white/50 leading-relaxed">{t('settings.custom.renderScaleHint')}</p>
      </section>

      <QualityToggle
        label={t('settings.custom.antialias')}
        checked={quality.customAntialias}
        disabled={customOptDisabled}
        onChange={(v) => editCustom({ customAntialias: v })}
      />
      <QualityToggle
        label={t('settings.custom.bloom')}
        checked={quality.customBloom}
        disabled={customOptDisabled}
        onChange={(v) => editCustom({ customBloom: v })}
      />
      <QualityToggle
        label={t('settings.custom.particles')}
        checked={quality.customParticles}
        disabled={customOptDisabled}
        onChange={(v) => editCustom({ customParticles: v })}
      />
      <QualityToggle
        label={t('settings.custom.dynamicLighting')}
        checked={quality.customDynamicLighting}
        disabled={customOptDisabled}
        onChange={(v) => editCustom({ customDynamicLighting: v })}
      />
      <QualityToggle
        label={t('settings.custom.hitEffects')}
        checked={quality.customHitEffects}
        disabled={customOptDisabled}
        onChange={(v) => editCustom({ customHitEffects: v })}
      />
    </div>
  );

  const gameContent = (
    <div className="space-y-5">
      <section className="space-y-1.5">
        <div className="flex justify-between"><label className="flex items-center gap-2 text-sm font-bold text-cyan-300"><Focus size={16} /> {t('settings.audioOffset')}</label><span className={valueClass}>{audioOffsetMs > 0 ? '+' : ''}{audioOffsetMs}ms</span></div>
        <input type="range" min="-600" max="400" step="5" value={audioOffsetMs} onChange={(e) => setAudioOffsetMs(Number(e.target.value))} className={sliderClass} />
        <div className="flex justify-between text-[11px] text-white/40 font-mono"><span>-600ms</span><span>+400ms</span></div>
        <p className="text-[11px] text-white/50 leading-relaxed">
          {t('settings.audioOffsetHint')}
        </p>
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

  const skinContent = (
    <div className="space-y-5">
      <section className="space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex items-center gap-2">
          <Palette size={18} className="text-cyan-300" />
          <h3 className="text-base font-semibold text-white">{t('skin.title')}</h3>
        </div>
        <p className="text-[11px] text-white/50 leading-relaxed">{t('skin.tabHint')}</p>
        <SkinManager selectedSkinId={selectedSkinId} onSelect={setSelectedSkinId} />
      </section>

      {/* 默认皮肤自定义面板：仅当未选择皮肤包（即正在使用默认皮肤）时显示。 */}
      {!selectedSkinId && (
      <section className="space-y-4 rounded-xl border border-cyan-400/20 bg-white/[0.03] p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-white">{t('settings.defaultSkin.title')}</h3>
          <button
            type="button"
            onClick={() => {
              setDefaultSkinInnerEnabled(true);
              setDefaultSkinOuterEnabled(false);
              setDefaultSkinOuterWidth(0.05);
              setDefaultSkinOuterColor('#22d3ee');
              setDefaultSkinOuterAlpha(1);
              setDefaultSkinJudgeWidth(0.01);
            }}
            className="px-3 py-1.5 rounded-lg text-xs font-bold bg-white/5 text-white/60 border border-white/10 hover:bg-white/10 hover:text-white/80 transition cursor-pointer"
          >
            {t('settings.defaultSkin.reset')}
          </button>
        </div>
        <p className="text-[11px] text-white/50 leading-relaxed">{t('settings.defaultSkin.desc')}</p>

        {/* 内框：颜色恒等于音符色，1px 描边，仅可开关 */}
        <QualityToggle
          label={t('settings.defaultSkin.innerEnabled')}
          checked={defaultSkinInnerEnabled}
          onChange={setDefaultSkinInnerEnabled}
        />
        <p className="text-[11px] text-white/50 leading-relaxed -mt-1">{t('settings.defaultSkin.innerEnabledHint')}</p>

        {/* 外框：软边纹理描边，可自定义颜色/粗细/透明度，由开关启用 */}
        <QualityToggle
          label={t('settings.defaultSkin.outerEnabled')}
          checked={defaultSkinOuterEnabled}
          onChange={setDefaultSkinOuterEnabled}
        />
        <p className="text-[11px] text-white/50 leading-relaxed -mt-1">{t('settings.defaultSkin.outerEnabledHint')}</p>

        <div className={`space-y-1.5 transition-opacity ${defaultSkinOuterEnabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
          <div className="flex items-center justify-between gap-3">
            <label className="text-sm font-medium text-white/80">{t('settings.defaultSkin.outerWidth')}</label>
            <span className={valueClass}>{(defaultSkinOuterWidth * 100).toFixed(1)}%</span>
          </div>
          <input
            type="range"
            min="0.01"
            max="0.20"
            step="0.005"
            value={defaultSkinOuterWidth}
            onChange={(e) => setDefaultSkinOuterWidth(Number(e.target.value))}
            className={sliderClass}
            disabled={!defaultSkinOuterEnabled}
          />
          <p className="text-[11px] text-white/50 leading-relaxed">{t('settings.defaultSkin.outerWidthHint')}</p>
        </div>

        <div className={`flex items-center justify-between gap-3 transition-opacity ${defaultSkinOuterEnabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
          <label className="text-sm font-medium text-white/80">{t('settings.defaultSkin.outerColor')}</label>
          <input
            type="color"
            value={defaultSkinOuterColor}
            onChange={(e) => setDefaultSkinOuterColor(e.target.value)}
            className="h-9 w-14 rounded-lg bg-transparent border border-white/15 cursor-pointer"
            disabled={!defaultSkinOuterEnabled}
          />
        </div>

        <div className={`space-y-1.5 transition-opacity ${defaultSkinOuterEnabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
          <div className="flex items-center justify-between gap-3">
            <label className="text-sm font-medium text-white/80">{t('settings.defaultSkin.outerAlpha')}</label>
            <span className={valueClass}>{(defaultSkinOuterAlpha * 100).toFixed(0)}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={defaultSkinOuterAlpha}
            onChange={(e) => setDefaultSkinOuterAlpha(Number(e.target.value))}
            className={sliderClass}
            disabled={!defaultSkinOuterEnabled}
          />
        </div>

        {/* 判定框：颜色恒等于音符色，仅可调粗细 */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <label className="text-sm font-medium text-white/80">{t('settings.defaultSkin.judgeWidth')}</label>
            <span className={valueClass}>{(defaultSkinJudgeWidth * 100).toFixed(1)}%</span>
          </div>
          <input
            type="range"
            min="0.005"
            max="0.20"
            step="0.005"
            value={defaultSkinJudgeWidth}
            onChange={(e) => setDefaultSkinJudgeWidth(Number(e.target.value))}
            className={sliderClass}
          />
          <p className="text-[11px] text-white/50 leading-relaxed">{t('settings.defaultSkin.judgeWidthHint')}</p>
        </div>
      </section>
      )}
    </div>
  );

  /* ---- 账号板块的操作 ---- */
  const handlePickAvatar = (): void => fileInputRef.current?.click();

  const handleAvatarFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重复选择同一个文件
    if (!file) return;
    const reason = validateAvatarFile(file);
    if (reason) {
      setAvatarError(reason);
      return;
    }
    setAvatarError(null);
    setAvatarBusy(true);
    try {
      const ref = await storeAvatar(file);
      await accountStore.setAvatar(ref);
    } catch (err) {
      console.error('avatar upload failed', err);
      setAvatarError('generic');
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleRemoveAvatar = (): void => {
    setAvatarError(null);
    void accountStore.setAvatar(null).catch((err) => {
      console.error('avatar remove failed', err);
      setAvatarError('generic');
    });
  };

  const commitNickname = (): void => {
    if (readOnly) return;
    const next = normalizeNickname(nameDraft);
    setNameDraft(next);
    accountStore.setNickname(next);
  };

  const handleLogin = async (): Promise<void> => {
    setAvatarError(null);
    setAvatarBusy(true);
    try {
      accountStore.setOptOut(false);
      const identity = await platform?.getIdentity();
      if (identity) {
        accountStore.linkPlatform({
          id: identity.id,
          nickname: identity.nickname,
          avatar: identity.avatar ?? null,
        });
      }
    } catch (err) {
      console.error('platform login failed', err);
      setAvatarError('generic');
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleLogout = (): void => {
    accountStore.logoutPlatform();
  };

  const avatarErrorText = avatarError
    ? avatarError === 'notImage'
      ? t('settings.account.err.notImage')
      : avatarError === 'tooLarge'
        ? t('settings.account.err.tooLarge')
        : t('settings.account.err.generic')
    : null;

  const accountContent = (
    <div className="space-y-5">
      <section className="space-y-4 rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-bold text-cyan-300">
            <User size={16} /> {t('settings.account.title')}
          </div>
          <p className="mt-1 text-[11px] text-white/50 leading-relaxed">{t('settings.account.desc')}</p>
        </div>

        {/* 头像预览 + 上传 / 移除 */}
        <div className="flex items-center gap-4">
          <div
            className="relative h-24 w-24 shrink-0 overflow-hidden rounded-full grid place-items-center
                       ring-1 ring-white/30 bg-gradient-to-br from-cyan-400/35 via-sky-500/25 to-amber-300/25"
            style={{ boxShadow: '0 0 18px rgba(34,211,238,0.28), inset 0 1px 0 rgba(255,255,255,0.2)' }}
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="h-full w-full object-cover" draggable={false} />
            ) : (
              <User size={34} className="text-white/80" />
            )}
          </div>
          <div className="flex flex-col gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleAvatarFile}
            />
            <button
              type="button"
              disabled={readOnly || avatarBusy}
              onClick={handlePickAvatar}
              className="glass-btn flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold
                         disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Upload size={14} /> {t('settings.account.upload')}
            </button>
            <button
              type="button"
              disabled={readOnly || avatarBusy || !account.custom.avatarRef}
              onClick={handleRemoveAvatar}
              className="glass-btn flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold
                         disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Trash2 size={14} /> {t('settings.account.remove')}
            </button>
          </div>
        </div>

        {/* 用户名 */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-white/80">{t('settings.account.nickname')}</label>
          <input
            type="text"
            value={nameDraft}
            disabled={readOnly}
            maxLength={MAX_NICKNAME_LENGTH}
            placeholder={t('settings.account.nicknamePlaceholder')}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitNickname}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            className="w-full rounded-xl border border-white/15 bg-white/[0.06] px-3 py-2 text-sm text-white
                       outline-none transition-colors placeholder:text-white/30
                       focus:border-cyan-300/70 focus:bg-white/[0.09]
                       disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </div>

        {avatarErrorText && <p className="text-[11px] text-red-400">{avatarErrorText}</p>}

        {/* 平台分支：支持平台账号的构建提供登录 / 登出；公开版为纯本地账号 */}
        <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <p className="text-[11px] text-white/60 leading-relaxed">
            {canLink && readOnly ? t('settings.account.linkedHint') : t('settings.account.notLinkedHint')}
          </p>
          {canLink &&
            (readOnly ? (
              <button
                type="button"
                onClick={handleLogout}
                className="glass-btn flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold"
              >
                <LogOut size={14} /> {t('settings.account.logout')}
              </button>
            ) : (
              <button
                type="button"
                disabled={avatarBusy || !platform}
                onClick={handleLogin}
                className="glass-btn flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold
                           disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <LogIn size={14} /> {t('settings.account.login')}
              </button>
            ))}
        </div>
      </section>
    </div>
  );

  const soundContent = (
    <div className="space-y-6">
      <section className="space-y-1.5">
        <div className="flex justify-between"><label className="flex items-center gap-2 text-sm font-bold text-cyan-300"><Volume2 size={16} /> {t('settings.musicVol')}</label><span className={valueClass}>{Math.round(musicVolume * 100)}%</span></div>
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
        <label className="flex items-center gap-2 text-sm font-bold text-cyan-300 cursor-pointer select-none" onClick={() => setCompatMode(!compatMode)}>
          <input type="checkbox" checked={compatMode} onChange={() => setCompatMode(!compatMode)} className="w-4 h-4 rounded border-white/30 bg-white/10 focus:outline-none cursor-pointer" />
          {t('settings.compatMode')}
        </label>
        <p className="text-[11px] text-white/50 leading-relaxed">
          {t(compatMode ? 'settings.compatModeHintOn' : 'settings.compatModeHint')}
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
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ paddingTop: 'max(1rem, env(safe-area-inset-top, 0px))', paddingBottom: 'max(1rem, env(safe-area-inset-bottom, 0px))', paddingLeft: 'max(1rem, env(safe-area-inset-left, 0px))', paddingRight: 'max(1rem, env(safe-area-inset-right, 0px))' }}>
      {/* 压暗 + 模糊单独成层（同 SongSelect）：容器自身带 backdrop-filter 会成为
          后代的 backdrop root，让里面的 glass-panel-strong 采不到真正的页面背景。 */}
      <div aria-hidden className="absolute inset-0 bg-black/70 backdrop-blur-md" />
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
          <div ref={contentRef} className="flex-1 min-w-0 min-h-0 overflow-y-auto p-5 sm:p-6">
            {tab === 'game' && gameContent}
            {tab === 'graphics' && graphicsContent}
            {tab === 'skin' && skinContent}
            {tab === 'account' && accountContent}
            {tab === 'sound' && soundContent}
            {tab === 'network' && !canLink && <NetworkSettings />}
            {tab === 'language' && languageContent}
            {tab === 'about' && <DocContent />}
          </div>
        </div>
      </div>
    </div>
  );
};
