/**
 * 音符触发器（§3.4）的**纯解析**逻辑。
 *
 * 音符可以在「被某个判定等级击中」或「漏掉」时触发事件。这里只负责
 * **决定触发哪些事件**，不负责执行 —— 执行由各渲染器用自己的事件应用函数完成
 * （3D `handleEvent` / 2D / Lite），因此本文件与渲染无关，可被 Lite 内联。
 *
 * 约定（同其它 shared 文件）：ES5、只用 `import type`、禁止运行时 import。
 */

import type { JudgementType, EventData, TriggerAction } from '../types/game';

/**
 * 判定是否为「漏掉」。Miss 走 `onMiss`，其余（含各等级命中）走 `onHit`。
 */
export function isMissJudgement(j: JudgementType): boolean {
  return j === 'Miss';
}

/**
 * 求音符在某次判定下应触发的**动作**列表。
 *
 * - `Miss` → `onMiss`
 * - 其它 → `onHit[该判定等级]`，没有则回退 `onHit.default`
 */
export function resolveTriggerActions(note: any, j: JudgementType): TriggerAction[] {
  var trg = note && note.trigger;
  if (!trg) return [];
  if (j === 'Miss') return trg.onMiss || [];
  var oh: any = trg.onHit;
  if (!oh) return [];
  var byJ: any = oh[j];
  if (byJ && byJ.length > 0) return byJ;
  return oh['default'] || [];
}

/**
 * 把动作解析成**可执行的事件**。
 *
 * `{ ref }` 形式：按 id 引用谱面里已定义的事件（顶层或任意图层事件轴均可）；
 * 内联形式：动作本身就是一份 EventData。
 *
 * `findById` 由调用方提供（id → 事件表，各渲染器自己维护）。
 * 找不到引用目标时静默跳过 —— 触发器是演出层，绝不能因此打断判定流程。
 */
export function resolveTriggerEvents(
  note: any,
  j: JudgementType,
  findById: (id: string) => EventData | undefined | null
): EventData[] {
  var acts = resolveTriggerActions(note, j);
  var out: EventData[] = [];
  for (var i = 0; i < acts.length; i++) {
    var a: any = acts[i];
    if (!a) continue;
    if (typeof a.ref === 'string' && a.ref) {
      var found = findById(a.ref);
      if (found) out.push(found);
      continue;
    }
    if (a.eventType) out.push(a as EventData);
  }
  return out;
}

/**
 * 触发器里**运行时不生效**的事件类型。
 *
 * 变速与偏移都已预先积分进滚动距离/落点，判定时刻无法再改变它们 ——
 * 这类动作只能被忽略。编辑器用它给出 warning，避免作者误以为有效。
 */
export function isTriggerEventUnsupported(evt: EventData | TriggerAction): boolean {
  var t = (evt as any).eventType;
  return t === 'speed_change' || t === 'offset_change';
}
