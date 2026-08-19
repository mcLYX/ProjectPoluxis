import { useState } from 'react';
import { useI18n } from '../i18n';
import {
  getServers,
  getCurrentServer,
  addServer,
  updateServer,
  removeServer,
  setCurrentServer,
} from '../data/onlineServers';

/**
 * "网络" 设置面板：只负责「连哪些服务器」——增删服务器、设为当前。
 * 浏览/下载逻辑保留在别处（首页在线卡片的下载按钮），这里不重复。
 */
export const NetworkSettings: React.FC = () => {
  const { t } = useI18n();
  const [servers, setServers] = useState(getServers());
  const [current, setCurrent] = useState(getCurrentServer());
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [formLabel, setFormLabel] = useState('');
  const [formUrl, setFormUrl] = useState('');

  const refresh = () => {
    setServers(getServers());
    setCurrent(getCurrentServer());
  };

  const startEdit = (id: string, label: string, url: string) => {
    setEditingId(id);
    setFormLabel(label);
    setFormUrl(url);
  };

  const startAdd = () => {
    setEditingId('new');
    setFormLabel('');
    setFormUrl('');
  };

  const saveEdit = () => {
    const label = formLabel.trim();
    const url = formUrl.trim();
    if (!label || !url) return;
    if (editingId === 'new') addServer(label, url);
    else if (editingId) updateServer(editingId, { label, baseUrl: url });
    setEditingId(null);
    refresh();
  };

  const handleDelete = (id: string) => {
    removeServer(id);
    refresh();
  };

  const handleSetCurrent = (id: string) => {
    setCurrentServer(id);
    refresh();
  };

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-white/45 leading-relaxed">
        {t('settings.network.hint')}
      </p>

      <div className="text-xs uppercase tracking-[0.2em] text-white/40 font-orbitron">
        {t('settings.network.servers')}
      </div>

      <div className="space-y-2">
        {servers.map((s) => (
          <div
            key={s.id}
            className="glass-sub rounded-xl p-3 transition-shadow"
            style={
              current?.id === s.id
                ? {
                  boxShadow: '0 0 0 1px rgba(34,211,238,0.7), 0 0 10px rgba(34,211,238,0.45), inset 0 0 10px rgba(34,211,238,0.18)',
                }
                : undefined
            }
          >
            {editingId === s.id ? (
              <div className="space-y-2">
                <input
                  className="w-full glass-input text-sm px-2 py-1.5 rounded"
                  value={formLabel}
                  onChange={(e) => setFormLabel(e.target.value)}
                  placeholder={t('settings.network.serverLabel')}
                />
                <input
                  className="w-full glass-input text-xs px-2 py-1.5 rounded"
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  placeholder="https://..."
                />
                <div className="flex gap-2">
                  <button className="glass-btn-primary text-xs px-3 py-1" onClick={saveEdit}>
                    {t('common.save')}
                  </button>
                  <button className="glass-btn text-xs px-3 py-1" onClick={() => setEditingId(null)}>
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <div className="text-sm text-white/90 truncate">{s.label}</div>
                  {current?.id === s.id && (
                    <span className="text-[10px] text-cyan-300 font-orbitron">{t('settings.network.current')}</span>
                  )}
                </div>
                <div className="text-[10px] text-white/40 truncate mb-2">{s.baseUrl}</div>
                <div className="flex flex-wrap gap-1.5 items-center">
                  <button
                    className="glass-btn text-[11px] px-2 py-1 text-cyan-300"
                    onClick={() => handleSetCurrent(s.id)}
                  >
                    {t('settings.network.setCurrent')}
                  </button>
                  {!s.fixed && (
                    <button
                      className="glass-btn text-[11px] px-2 py-1"
                      onClick={() => startEdit(s.id, s.label, s.baseUrl)}
                    >
                      {t('common.edit')}
                    </button>
                  )}
                  {!s.fixed && (
                    <button
                      className="glass-btn text-[11px] px-2 py-1 text-red-300"
                      onClick={() => handleDelete(s.id)}
                    >
                      {t('common.delete')}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        ))}

        {editingId === 'new' ? (
          <div className="glass-sub rounded-xl p-3 space-y-2">
            <input
              className="w-full glass-input text-sm px-2 py-1.5 rounded"
              value={formLabel}
              onChange={(e) => setFormLabel(e.target.value)}
              placeholder={t('settings.network.serverLabel')}
            />
            <input
              className="w-full glass-input text-xs px-2 py-1.5 rounded"
              value={formUrl}
              onChange={(e) => setFormUrl(e.target.value)}
              placeholder="https://..."
            />
            <div className="flex gap-2">
              <button className="glass-btn-primary text-xs px-3 py-1" onClick={saveEdit}>
                {t('settings.network.addServer')}
              </button>
              <button className="glass-btn text-xs px-3 py-1" onClick={() => setEditingId(null)}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button className="glass-btn w-full text-sm py-2" onClick={startAdd}>
            + {t('settings.network.addServer')}
          </button>
        )}
      </div>
    </div>
  );
};
