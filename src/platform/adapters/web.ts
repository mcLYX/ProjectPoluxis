/**
 * 默认（Web）平台适配器 —— 公开仓库内置实现，不含任何平台私有逻辑。
 *
 * 行为对齐现有游戏：
 *  - 进度 / 最高分由 `scoreStore`（localStorage）负责，这里仅提供一个统一的
 *    `saveProgress/loadProgress` 落地（与 Toy 云镜像接口一致），web 端落本地。
 *  - 无跨玩家排行榜能力：`submitScore` / `getRankList` / `getMyRank` 为空操作或降级。
 *  - 分享：优先 Web Share API，退化为下载图片。
 *  - 容器方向：浏览器无容器概念，空操作。
 */
import type {
  GamePlatform,
  PlatformIdentity,
  RankEntry,
  ShareResultOptions,
  ContainerModeOptions,
  SubmitScoreRequest,
  GetRankRequest,
} from '../adapter';
import { safeStorage } from '../../utils/storage';

const PROGRESS_PREFIX = 'poluxis_platform_progress:';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const webPlatform: GamePlatform = {
  name: 'web',

  isSupported: () => false,

  async getIdentity(): Promise<PlatformIdentity | null> {
    return null;
  },

  async saveProgress(key: string, data: unknown): Promise<void> {
    safeStorage.setItem(PROGRESS_PREFIX + key, JSON.stringify(data));
  },

  async loadProgress<T = unknown>(key: string): Promise<T | null> {
    const raw = safeStorage.getItem(PROGRESS_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  },

  async submitScore(_req: SubmitScoreRequest): Promise<void> {
    // 本地最高分由 scoreStore 处理；web 无跨玩家排行榜。
  },

  async getRankList(_req?: GetRankRequest): Promise<RankEntry[]> {
    return [];
  },

  async getMyRank(_req?: GetRankRequest): Promise<RankEntry | null> {
    return null;
  },

  async shareResult(opts: ShareResultOptions): Promise<void> {
    const file = new File([opts.image], 'result.png', {
      type: opts.image.type || 'image/png',
    });
    if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: opts.title, text: opts.text });
        return;
      } catch {
        // 用户取消分享 → 退化到下载
      }
    }
    downloadBlob(opts.image, 'result.png');
  },

  async setContainerMode(_opts: ContainerModeOptions): Promise<void> {
    // 浏览器无容器概念。
  },
};

export default webPlatform;
