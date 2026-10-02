/**
 * 「账号」入口：圆形头像 + 昵称胶囊；点击展开下拉列表，
 * 承载原先散落在主界面的「设置 / 编辑器 / Lite 版」三个入口。
 *
 * 菜单本体复用公共 GlassDropdown（trigger/方向/图标项均为其参数变体）；
 * 视觉沿用游戏既有的暗色玻璃拟态 + 青色强调语言。
 */
import { FileCode, Sliders, Smartphone, User } from 'lucide-react';
import { useI18n } from '../i18n';
import { getDisplayAccount, useAccount } from '../accountStore';
import { useAvatarUrl } from '../hooks/useAvatarUrl';
import { GlassDropdown } from './GlassDropdown';

export interface AccountMenuProps {
  onOpenSettings: () => void;
  onOpenEditor: () => void;
  onSwitchLite: () => void;
  /**
   * 面板相对按钮的展开位置：
   *  - `'bottom-left'`：向上展开且左对齐（控件位于左下角时使用，避免向左溢出屏幕）。
   *  - `'top-right'`：向下展开且右对齐（控件位于右上角时使用）。
   */
  placement?: 'top-right' | 'bottom-left';
}

export const AccountMenu: React.FC<AccountMenuProps> = ({
  onOpenSettings,
  onOpenEditor,
  onSwitchLite,
  placement = 'top-right',
}) => {
  const openUp = placement === 'bottom-left';
  const { t } = useI18n();
  const account = useAccount();
  const display = getDisplayAccount(account);
  const avatarUrl = useAvatarUrl(display.avatar);

  const items = [
    { key: 'settings', label: t('songselect.settings'), icon: Sliders, action: onOpenSettings },
    { key: 'editor', label: t('songselect.edit'), icon: FileCode, action: onOpenEditor },
    { key: 'lite', label: t('songselect.lite'), icon: Smartphone, action: onSwitchLite },
  ];

  return (
    <GlassDropdown<string>
      options={items.map(({ key, label, icon: Icon }) => ({
        value: key,
        label,
        icon: <Icon size={15} className="text-cyan-300" />,
      }))}
      onChange={(key) => items.find((it) => it.key === key)?.action()}
      trigger={
        <>
          <span
            className="relative h-9 w-9 shrink-0 rounded-full overflow-hidden grid place-items-center
                       ring-1 ring-white/40 bg-gradient-to-br from-cyan-400/35 via-sky-500/25 to-amber-300/25"
            style={{ boxShadow: '0 0 10px rgba(34,211,238,0.35), inset 0 1px 0 rgba(255,255,255,0.2)' }}
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="h-full w-full object-cover" draggable={false} />
            ) : (
              <User size={17} className="text-white/85" />
            )}
          </span>
          <span className="max-w-[6.5rem] truncate text-xs text-white/90">{display.nickname}</span>
        </>
      }
      triggerClassName="glass-btn flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full font-bold
                        transition-transform duration-150 hover:scale-[1.03] active:scale-[0.98]
                        focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 cursor-pointer"
      triggerTitle={display.nickname}
      direction={openUp ? 'up' : 'down'}
      align={openUp ? 'left' : 'right'}
      panelClassName="w-44 max-w-[calc(100vw_-_3rem)] rounded-2xl p-1.5"
      itemClassName="h-10 px-2.5 rounded-xl text-sm font-bold gap-2.5"
    />
  );
};
