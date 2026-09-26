import type { JudgementType } from '../types/game';
import { evaluateJudgement } from '../utils/scoring';
import { isWithinBox, withinHitWindow } from './judge';
import { HIT_WINDOW_MS, SLIDE_HIT_HALF } from '../gameplayConstants';

/**
 * slide 链式判定的**纯逻辑核心**：不依赖 React、不依赖 THREE、不依赖具体指针容器。
 *
 * 之所以要做成中立核心：同一套判定规则被 3 份实现各自复制过（3D `useJudgeSystem`、
 * 2D `GameCanvas2D`、Lite `09-engine.js`），已经出现行为分叉。这里统一为单一来源，
 * 各端只保留「适配层」：
 *   - 指针 id 类型中立（3D 用 `number`，2D / Lite 用 `string`）→ 泛型 `TId`；
 *   - 绑定容器中立（`Set<number>` / `Record<string, boolean>` / 普通对象，
 *     且它们都被各自的渲染层直接读取，故不能统一改类型）→ `SlideBinding` 接口。
 */

/** 单个 slide 节点的判定运行态。 */
export interface SlideJudgeNodeRt<TId> {
  judged: boolean;
  missLocked: boolean;
  everInZone: boolean;
  lastInsideTime: number | null;
  lastInsidePointerId: TId | null;
  arrivalChecked: boolean;
  tailLockedSPerfect: boolean;
  earlySPLocked: boolean;
  earlyTouchIds: TId[];
}

/** 绑定容器的中立抽象（各端用自己的原生容器实现）。 */
export interface SlideBinding<TId> {
  has(id: TId): boolean;
  add(id: TId): void;
  delete(id: TId): void;
  size(): number;
  /** 当前绑定 id 的快照（迭代期间可安全增删）。 */
  ids(): TId[];
}

/**
 * 整条 slide 的判定运行态。**必须由调用方传入其真实存储对象**（而非临时视图），
 * 因为核心会就地改写 `headReleasePending` / 各节点状态。
 */
export interface SlideJudgeState<TId> {
  nodes: SlideJudgeNodeRt<TId>[];
  /** 头节点特殊窗口内发生过「全松手」但尚未裁定。 */
  headReleasePending: boolean;
}

/** 指针的中立表示。 */
export interface SlideJudgePointer<TId> {
  id: TId;
  x: number;
  y: number;
  down: boolean;
}

/** 几何节点的中立表示（头节点 + 子节点）。 */
export interface SlideJudgeNode {
  x: number;
  y: number;
  timeSec: number;
}

export interface SlideJudgeInput<TId> {
  nodes: SlideJudgeNode[];
  /** 真实运行态存储（就地改写）。 */
  rt: SlideJudgeState<TId>;
  /** 绑定容器适配器。 */
  bound: SlideBinding<TId>;
  pointers: SlideJudgePointer<TId>[];
  curTime: number;
  autoPlay: boolean;
  /** 从谱面中间试玩时，早于该起点的节点直接标记已判定、不产生 Miss。默认不启用。 */
  playStartTime?: number;
  /** 提交某个节点的判定结果（含 Miss）。 */
  commit: (idx: number, judgement: JudgementType, dtMs: number) => void;
}

/** 创建节点运行态（各端 getSlideRt 可直接复用）。 */
export function createSlideJudgeNodes<TId>(nodeCount: number): SlideJudgeNodeRt<TId>[] {
  return Array.from({ length: nodeCount }, () => ({
    judged: false,
    missLocked: false,
    everInZone: false,
    lastInsideTime: null,
    lastInsidePointerId: null,
    arrivalChecked: false,
    tailLockedSPerfect: false,
    earlySPLocked: false,
    earlyTouchIds: [],
  }));
}

/**
 * 逐帧推进一条 slide 的判定。语义（与抽出前逐字等价）：
 * - 节点像 Touch 但需要「按住」；
 * - 节点一旦判定，当时在该节点上的手指全部入绑；任一已绑手指可判定后续节点（多指支持）；
 * - 已绑手指抬起即移出；已绑但不在当前节点的手指，仅在「另有已绑手指已在当前节点上」
 *   时才被剪枝（保证分叉 slide 不丢失服务手指）；
 * - 最后一个已绑手指抬起时，下一个未判定节点红锁，并在 +HIT_WINDOW_MS 后判 Late Miss；
 * - 头节点特殊逻辑：判定窗口内自由加绑 + 红锁延后到窗口结束才裁定；
 * - 尾节点放宽：窗口内任一手指按住即锁 S-Perfect。
 */
export function processSlideCore<TId>(input: SlideJudgeInput<TId>): void {
  const { nodes: allNodes, rt, bound, pointers, curTime, commit } = input;
  const playStartTime = input.playStartTime ?? Number.NEGATIVE_INFINITY;

  // 1) 超窗 Late Miss（含已红锁的节点）
  for (let i = 0; i < allNodes.length; i++) {
    const ns = rt.nodes[i];
    if (ns.judged) continue;
    // 从谱面中间试玩：起点之前已越过的节点直接标记已判定、不产生 Miss。
    if (allNodes[i].timeSec < playStartTime) {
      ns.judged = true;
      continue;
    }
    const dtI = (curTime - allNodes[i].timeSec) * 1000;
    if (dtI > HIT_WINDOW_MS) {
      ns.judged = true;
      commit(i, 'Miss', dtI);
      // A miss does not change the binding of subsequent nodes.
    }
  }

  // 头节点特殊逻辑的生效区间：默认持续到「头节点时间 + HIT_WINDOW_MS」；
  // 若第一子节点与头节点相距不足 HIT_WINDOW_MS，则只持续到第一子节点的时间，
  // 避免宽松窗口越界覆盖子节点自身的判定。
  const headT = allNodes[0].timeSec;
  const child1T = allNodes.length > 1 ? allNodes[1].timeSec : Number.POSITIVE_INFINITY;
  const headWindowEnd = Math.min(headT + HIT_WINDOW_MS / 1000, child1T);
  const headSpecialActive = curTime < headWindowEnd;

  // 2) 头节点开放绑定窗口：头节点一旦被命中（judged），在上述区间内持续把
  //    「处于头节点判定盒内」的手指自由加入链上绑定。这样即便划过的 A 先被判定、
  //    真正要接的 B 晚一帧才按下（甚至 A 已抬起），B 仍能在窗口内加入接管；
  //    交叉 slide 中划过且仍在盒内的 A 也能自由加绑（多一个绑定只更安全）。
  //    仅在头已被命中后才加绑，避免早期窗口提前产生绑定而误触发红锁。
  {
    const headNs = rt.nodes[0];
    if (headNs.judged && headSpecialActive) {
      const hx = allNodes[0].x;
      const hy = allNodes[0].y;
      for (const p of pointers) {
        if (!p.down) continue;
        if (isWithinBox(p.x, p.y, hx, hy, SLIDE_HIT_HALF)) bound.add(p.id);
      }
    }
  }

  /* --- 活跃节点：逐帧扫描 + 判定 --- */
  const nextIdx = rt.nodes.findIndex((n) => !n.judged);
  if (nextIdx < 0) return;
  const ns = rt.nodes[nextIdx];
  const nd = allNodes[nextIdx];
  const dt = (curTime - nd.timeSec) * 1000;
  const isTail = nextIdx === allNodes.length - 1;
  const isHead = nextIdx === 0;

  if (input.autoPlay) {
    if (dt >= 0 && !ns.judged) {
      ns.judged = true;
      commit(nextIdx, 'S-Perfect', dt);
    }
    return;
  }

  if (ns.missLocked) return;

  const byId = new Map<TId, SlideJudgePointer<TId>>();
  for (const p of pointers) byId.set(p.id, p);
  const isDown = (id: TId): boolean => {
    const p = byId.get(id);
    return !!p && p.down;
  };

  // 单遍扫描：维护绑定并对每根手指分类。
  //   hadBinding : 帧首链上已有绑定（门控「松手→红锁」规则）
  //   anyDown    : 是否有手指按住（尾节点自由绑定用）
  //   allDown    : 所有按住的手指 id（尾节点自由绑定用）
  //   onNode     : 落在当前节点判定盒内的手指
  //                （已有绑定 → 仅已绑手指；无绑定 → 任意手指）
  const hadBinding = bound.size() > 0;
  let anyDown = false;
  const allDown: TId[] = [];
  const onNode: TId[] = [];
  let boundOnNode = 0;
  const boundOffNode: TId[] = [];
  for (const p of pointers) {
    if (bound.has(p.id) && !p.down) { bound.delete(p.id); continue; }
    if (!p.down) continue;
    anyDown = true;
    allDown.push(p.id);
    const inBox = isWithinBox(p.x, p.y, nd.x, nd.y, SLIDE_HIT_HALF);
    const isBound = bound.has(p.id);
    if (inBox && (hadBinding ? isBound : true)) onNode.push(p.id);
    if (isBound) { if (inBox) boundOnNode++; else boundOffNode.push(p.id); }
  }
  // 移除已抬起的手指：部分运行时会把抬起的手指从指针集合中整个删掉，
  // 上面的扫描看不到它们，这里补删以便检测到「全部松手」（→ 红锁 / Miss）。
  for (const pid of bound.ids()) {
    if (!isDown(pid)) bound.delete(pid);
  }
  // 仅在「另有已绑手指已在当前节点上」时才剪枝离开节点的手指。
  if (boundOnNode > 0) for (const pid of boundOffNode) bound.delete(pid);
  const allReleased = bound.size() === 0;

  // 尾节点放宽：窗口内有绑定手指按住、或（自由链）任意手指按住即锁 S-Perfect。
  if (isTail && !ns.tailLockedSPerfect && dt >= -HIT_WINDOW_MS) {
    if (bound.size() > 0 || anyDown) ns.tailLockedSPerfect = true;
  }

  // 红锁（尾节点豁免）。头节点特殊窗口内不立即落锤：只记录「发生过全松手」，
  // 等窗口结束再裁定（期间允许目标手指自由加绑接管，避免划过的 A 抬起就误判 misslock）。
  if (hadBinding && allReleased && nextIdx >= 0 && !ns.judged && !ns.tailLockedSPerfect) {
    if (headSpecialActive) rt.headReleasePending = true;
    else ns.missLocked = true;
  }
  if (!headSpecialActive && rt.headReleasePending) {
    rt.headReleasePending = false;
    // 窗口结束时仍无人绑定 → 链确已放弃，才红锁下一个未判定节点。
    if (bound.size() === 0 && nextIdx >= 0 && !ns.judged && !ns.tailLockedSPerfect) {
      ns.missLocked = true;
    }
  }
  if (ns.missLocked) return;

  // 记账。
  if (bound.size() > 0 && onNode.length > 0) ns.everInZone = true;
  if (withinHitWindow(dt, HIT_WINDOW_MS) && onNode.length > 0) {
    ns.lastInsideTime = curTime;
    ns.lastInsidePointerId = onNode[0];
  }

  // 早锁 S-Perfect（宽松早扫）：-HIT_WINDOW_MS <= dt < 0 期间盒内有手指即锁，
  // 允许玩家提前扫过再离开（手指需保持按住；抬起仍判 Miss，尾节点豁免）。到 dt>=0 结算。
  //   - 头节点（尚无绑定）：记录任意手指；
  //   - 子节点：仅已绑手指（onNode 已体现）。
  if (!ns.judged && !ns.earlySPLocked && dt < 0 && dt >= -HIT_WINDOW_MS && onNode.length > 0) {
    ns.earlySPLocked = true;
    if (isHead) for (const pid of onNode) if (!ns.earlyTouchIds.includes(pid)) ns.earlyTouchIds.push(pid);
  }

  const judge = (j: JudgementType, bindPids: TId[]): void => {
    ns.judged = true;
    for (const pid of bindPids) bound.add(pid);
    commit(nextIdx, j, dt);
  };

  if (dt >= 0 && !ns.judged) {
    let sPerfect = false;
    if (ns.earlySPLocked) {
      if (isHead) {
        // 优先绑定「当前仍在判定盒内」的手指：这把真正在头节点处按下的手指（B）
        // 以及仍停在盒内的合法早扫 / 拖入手指判给头节点，避免被只是扫过的 A 抢走。
        // 仅当盒内当前无人时，才回退到宽松早锁（早扫过但手指仍按着）。
        // 两种分支都保留 misslock（绑定到某指后该指抬起 → 强制 miss）。
        if (onNode.length > 0) {
          sPerfect = true;
          judge('S-Perfect', onNode.slice());
        } else {
          const earlyAnyDown = ns.earlyTouchIds.some(isDown);
          if (earlyAnyDown) { sPerfect = true; judge('S-Perfect', ns.earlyTouchIds.slice()); }
          else { ns.earlySPLocked = false; ns.earlyTouchIds = []; }
        }
      } else {
        sPerfect = true; judge('S-Perfect', []);
      }
    }
    if (!ns.judged && !sPerfect) {
      if (isTail && ns.tailLockedSPerfect) {
        judge('S-Perfect', bound.size() > 0 ? [] : allDown.slice());
      } else if (!ns.arrivalChecked) {
        ns.arrivalChecked = true;
        if (onNode.length > 0) judge('S-Perfect', onNode.slice());
      } else if (onNode.length > 0 && dt <= HIT_WINDOW_MS) {
        const j = evaluateJudgement(dt);
        if (j) judge(j, onNode.slice());
      }
    }
  }
}

/** `Set<T>` 的绑定适配器（3D 端用）。 */
export function setBinding<T>(set: Set<T>): SlideBinding<T> {
  return {
    has: (id) => set.has(id),
    add: (id) => { set.add(id); },
    delete: (id) => { set.delete(id); },
    size: () => set.size,
    ids: () => [...set],
  };
}

/** `Record<string, boolean>` 的绑定适配器（2D / Lite 端用）。 */
export function recordBinding(rec: Record<string, boolean>): SlideBinding<string> {
  return {
    has: (id) => !!rec[id],
    add: (id) => { rec[id] = true; },
    delete: (id) => { delete rec[id]; },
    size: () => Object.keys(rec).length,
    ids: () => Object.keys(rec),
  };
}
