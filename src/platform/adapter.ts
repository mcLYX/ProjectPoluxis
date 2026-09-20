/**
 * 平台抽象层接口。
 *
 * 游戏主体只依赖本文件定义的 `GamePlatform` 能力，不直连任何宿主注入的平台 SDK。
 * 具体实现见 `adapters/web.ts`（公开默认实现）与按构建风味接入的私有适配器
 * （gitignore，不进入公开仓库）。
 *
 * 这样各构建风味共享同一套游戏代码，差异只收敛在适配器实现里，
 * 且公开 GitHub 仓库始终零平台私有残留。
 */

/** 当前平台的玩家身份（昵称 / 头像 / 平台内标识）。 */
export interface PlatformIdentity {
  /** 平台内标识（平台侧业务标识，非真实 UID/MID）。 */
  id: string;
  nickname: string;
  avatar?: string;
}

/** 排行榜单条记录。 */
export interface RankEntry {
  rank: number;
  nickname: string;
  score: number;
  avatar?: string;
}

/** 容器方向 / 沉浸模式设置（仅宿主 App 端有效）。 */
export interface ContainerModeOptions {
  orientation?: 'portrait' | 'landscape';
  immersive?: boolean;
}

/** 提交成绩到排行榜的请求。 */
export interface SubmitScoreRequest {
  score: number;
  /** 曲目命名空间键（见 scoreStore.getScoreKey）。 */
  songId: string;
  difficulty: string;
  /** 可选附加信息，便于排行榜展示。 */
  accuracy?: number;
  rank?: string;
  maxCombo?: number;
}

/** 查询排行榜的请求。 */
export interface GetRankRequest {
  songId?: string;
  difficulty?: string;
  limit?: number;
}

/**
 * 游戏依赖的统一平台能力。所有方法都应幂等、可失败、不抛未捕获异常
 * （调用方已做兜底，但适配器内部也建议 try/catch 后 resolve）。
 */
export interface GamePlatform {
  readonly name: 'web' | 'toy';

  /**
   * 判断当前环境是否支持某平台能力（部分能力仅宿主 App 端可用）。
   * 公开默认实现一律返回 false。
   *
   * 之所以是异步：宿主 SDK 的能力探测本身是异步的（如 Toy 的 `isSupport`
   * 返回 `Promise<boolean>`）。用同步签名会把 Promise 对象当成 boolean，
   * 恒为真值（无论实际支不支持）。
   */
  isSupported(ability: string): Promise<boolean>;

  /** 获取玩家身份；不支持时返回 null。 */
  getIdentity(): Promise<PlatformIdentity | null>;

  /** 保存玩家进度（支持云存储的构建异步镜像到云端；否则落本地）。 */
  saveProgress(key: string, data: unknown): Promise<void>;

  /** 读取玩家进度；不存在时返回 null。 */
  loadProgress<T = unknown>(key: string): Promise<T | null>;

  /** 提交成绩到排行榜（支持排行榜的构建提交到平台；否则无跨玩家排行，空操作）。 */
  submitScore(req: SubmitScoreRequest): Promise<void>;

  /** 拉取排行榜（不支持时可返回本地最佳成绩作为降级，或空数组）。 */
  getRankList(req?: GetRankRequest): Promise<RankEntry[]>;

  /** 查询我的排名（未登录 / 不支持时返回 null）。 */
  getMyRank(req?: GetRankRequest): Promise<RankEntry | null>;

  /** 设置容器方向 / 沉浸（仅宿主 App 端有效；否则空操作）。 */
  setContainerMode(opts: ContainerModeOptions): Promise<void>;
}
