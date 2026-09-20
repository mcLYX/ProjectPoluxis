/**
 * 账号状态切片（模块级单例 + `useSyncExternalStore`）。
 *
 * 与 `qualityStore` 同范式：store 位于 React 树之外，只有订阅方（设置面板 / 主界面头像）
 * 会随账号变化重渲染，避免把账号数据塞进 App 根 state 造成整树重渲染。
 *
 * 数据模型刻意区分两份身份：
 *  - `custom`：用户自定义资料（普通版即最终展示值）。
 *  - `platform`：平台身份快照，每次启动刷新。
 * 展示身份 = `linked && platform ? platform : custom`，因此平台账号登出后可自然回落到
 * 用户此前自定义的内容，而「已登录时禁止编辑」只需一个 `linked` 判定。
 */
import { useSyncExternalStore } from 'react';
import { safeStorage } from './utils/storage';
import { deleteAvatarRef, isAvatarRef } from './utils/avatar';

const STORAGE_KEY = 'poluxis-account';

/** 昵称最大长度。 */
export const MAX_NICKNAME_LENGTH = 24;

/** 默认展示名（未设置昵称时）。 */
export const DEFAULT_NICKNAME = 'Player';

/** 用户自定义资料；`avatarRef` 为 `idb://…` 引用。 */
export interface AccountCustom {
  nickname: string;
  avatarRef: string | null;
}

/** 平台身份快照（由平台适配器提供）。 */
export interface AccountPlatform {
  id: string;
  nickname: string;
  avatar: string | null;
}

export interface AccountState {
  custom: AccountCustom;
  platform: AccountPlatform | null;
  /** 是否已绑定平台身份（true 时展示 platform 且禁止编辑 custom）。 */
  linked: boolean;
  /** 用户手动登出：之后不再自动拉取平台身份，直到手动点「登录」。 */
  optOut: boolean;
}

/** 派生出的展示身份。 */
export interface DisplayAccount {
  nickname: string;
  avatar: string | null;
  /** 头像/昵称是否来自平台账号。 */
  fromPlatform: boolean;
}

const DEFAULT_ACCOUNT: AccountState = {
  custom: { nickname: DEFAULT_NICKNAME, avatarRef: null },
  platform: null,
  linked: false,
  optOut: false,
};

/** 规范化昵称：trim + 截断；空值回落默认名。 */
export function normalizeNickname(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_NICKNAME;
  return trimmed.slice(0, MAX_NICKNAME_LENGTH);
}

function sanitize(value: unknown): AccountState {
  const raw = (value ?? {}) as Partial<AccountState>;
  const customRaw = (raw.custom ?? {}) as Partial<AccountCustom>;
  const platformRaw = raw.platform as Partial<AccountPlatform> | null | undefined;
  const custom: AccountCustom = {
    nickname: typeof customRaw.nickname === 'string' ? normalizeNickname(customRaw.nickname) : DEFAULT_NICKNAME,
    avatarRef: typeof customRaw.avatarRef === 'string' && customRaw.avatarRef ? customRaw.avatarRef : null,
  };
  const platform: AccountPlatform | null =
    platformRaw && typeof platformRaw.id === 'string' && typeof platformRaw.nickname === 'string'
      ? {
          id: platformRaw.id,
          nickname: platformRaw.nickname,
          avatar: typeof platformRaw.avatar === 'string' && platformRaw.avatar ? platformRaw.avatar : null,
        }
      : null;
  return {
    custom,
    platform,
    linked: raw.linked === true && !!platform,
    optOut: raw.optOut === true,
  };
}

function loadAccount(): AccountState {
  try {
    const raw = safeStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_ACCOUNT };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_ACCOUNT };
  }
}

function persist(s: AccountState): void {
  try {
    safeStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* 配额不足 / 隐私模式：静默忽略 */
  }
}

let state: AccountState = loadAccount();
let initialized = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function commit(next: AccountState): void {
  state = next;
  persist(state);
  emit();
}

export const accountStore = {
  /** 幂等初始化：仅首次调用生效（用于显式从持久化恢复）。 */
  init(initial?: AccountState): void {
    if (initialized) return;
    initialized = true;
    state = initial ? sanitize(initial) : loadAccount();
    emit();
  },

  getSnapshot: (): AccountState => state,

  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },

  /** 更新自定义昵称。已绑定平台身份时忽略（UI 同时置只读）。 */
  setNickname(nickname: string): void {
    if (state.linked) return;
    commit({ ...state, custom: { ...state.custom, nickname: normalizeNickname(nickname) } });
  },

  /** 替换自定义头像；异步回收旧引用。已绑定平台身份时忽略。 */
  async setAvatar(avatarRef: string | null): Promise<void> {
    if (state.linked) return;
    const prev = state.custom.avatarRef;
    commit({ ...state, custom: { ...state.custom, avatarRef } });
    if (prev && prev !== avatarRef && isAvatarRef(prev)) {
      await deleteAvatarRef(prev);
    }
  },

  /** 绑定平台身份（登录成功）。 */
  linkPlatform(platform: AccountPlatform | null): void {
    if (!platform) return;
    commit({ ...state, platform, linked: true, optOut: false });
  },

  /** 登出：回落自定义身份，并记住不再自动登录。 */
  logoutPlatform(): void {
    commit({ ...state, platform: null, linked: false, optOut: true });
  },

  /** 允许自动登录（用户再次点「登录」时清除 optOut）。 */
  setOptOut(v: boolean): void {
    if (state.optOut === v) return;
    commit({ ...state, optOut: v });
  },
};

/** 订阅账号切片（仅订阅方组件重渲染）。 */
export function useAccount(): AccountState {
  return useSyncExternalStore(accountStore.subscribe, accountStore.getSnapshot);
}

/** 派生展示身份：已绑定则取平台资料，否则取自定义资料。 */
export function getDisplayAccount(s: AccountState = state): DisplayAccount {
  if (s.linked && s.platform) {
    return { nickname: s.platform.nickname, avatar: s.platform.avatar ?? null, fromPlatform: true };
  }
  return { nickname: s.custom.nickname, avatar: s.custom.avatarRef, fromPlatform: false };
}
