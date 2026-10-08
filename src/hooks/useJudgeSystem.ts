import type { JudgementType, NoteType, ResolvedNote } from '../types/game';
import { noteHitZ } from '../systems/judge';
import { calculateNoteScore } from '../utils/scoring';
import { countPlayableNotes } from '../utils/beatTime';
import { globalAudio } from '../audio/AudioManager';
// 游戏常数统一收敛在 gameplayConstants（单一来源）；SlideRt 类型随 GameCanvas 定义。
import type { SlideRt } from '../components/GameCanvas';
import type { JudgeSystemContext } from './judgeContext';
import {
  processSlideCore,
  setBinding,
  type SlideJudgePointer,
  type SlideJudgeState,
} from '../systems/slideJudge';

/** spawnBurst 的函数签名（与 useNoteEffects 返回值一致）。 */
export type SpawnBurstFn = (
  x: number,
  y: number,
  j: JudgementType,
  nt: NoteType,
  noteColorHex?: string,
  z?: number,
  angle?: number,
) => void;

/**
 * 迁出 GameCanvas 的判定系统闭包：
 * - commitJudgement：单音符判定提交
 * - commitSlideNode：slide 单节点判定提交
 * - getSlideRt：获取/初始化 slide 运行态
 * - processSlide：slide 链式逐节点判定
 *
 * 依赖经 ctx 注入；spawnBurst 由 useNoteEffects 提供。
 */
export const useJudgeSystem = (ctx: JudgeSystemContext, spawnBurst: SpawnBurstFn) => {
  const commitJudgement = (note: ResolvedNote, j: JudgementType, dtMs: number): void => {
    if (ctx.isEditorModeRef.current) return;
    if (ctx.judgedNotesRef.current.has(note.id)) return;
    if (note.fake) return; // 假音符：完全不参与判定（防御；命中检测层已跳过）
    ctx.judgedNotesRef.current.add(note.id);
    // 不计分音符：参与判定，但不计分、不计数量（judgedCount）、不计连击（App 侧整条跳过）。
    const noScore = note.noScore === true;
    if (!noScore) ctx.judgedCountRef.current++;
    const sc = noScore ? 0 : calculateNoteScore(j, countPlayableNotes(ctx.chartRef.current));
    if (j !== 'Miss') globalAudio.playHitSound(note.type);
    // Note color = per-note override, then layer color (inherit / layer events), then chart default.
    const noteColor = ctx.getNoteColor
      ? ctx.getNoteColor(note)
      : note.color || ctx.currentNoteColorRef.current || ctx.chartRef.current.metadata.noteColor;
    // Spawn the burst at the note's ACTUAL z position when hit, not at the
    // judgement plane. noteZ = JUDGE_Z + (dtMs/1000)*speed: early hits
    // (dtMs<0) place the burst behind the plane (note still approaching);
    // late hits (dtMs>0) place it in front (note has passed). +0.05 keeps
    // particles just in front of the note mesh to avoid z-fighting.
    const noteZ = noteHitZ(dtMs, ctx.speedRef.current);
    // 图层偏移：打击特效与判定反馈**钉在判定落位**（不随播放中的整列平移跑动）；
    // 未注入 getLandingPos 时退回 getEffectivePos / 原坐标。
    const ep = ctx.getLandingPos
      ? ctx.getLandingPos(note)
      : ctx.getEffectivePos
        ? ctx.getEffectivePos(note)
        : note;
    spawnBurst(ep.x, ep.y, j, note.type, noteColor, noteZ, note.angle ?? 0);
    ctx.onJudgementRef.current?.({ id: note.id, type: j, x: ep.x, y: ep.y, deltaT: dtMs, scoreGained: sc, createdAt: performance.now(), noteType: note.type, noScore: noScore || undefined });
    // 音符触发器（§3.4）：判定提交后分发（幂等由 judgedNotesRef 保证每个音符只判一次）。
    ctx.dispatchNoteTrigger?.(note, j);
  };

  const commitSlideNode = (
    slide: ResolvedNote,
    idx: number,
    nx: number,
    ny: number,
    j: JudgementType,
    dtMs: number,
  ): void => {
    if (ctx.isEditorModeRef.current) return;
    const key = `${slide.id}#${idx}`;
    if (ctx.judgedNotesRef.current.has(key)) return;
    if (slide.fake) return; // 假音符：整条 slide 链（含全部子节点）不判定、不产生 Miss
    ctx.judgedNotesRef.current.add(key);
    const noScore = slide.noScore === true;
    if (!noScore) ctx.judgedCountRef.current++;
    const sc = noScore ? 0 : calculateNoteScore(j, countPlayableNotes(ctx.chartRef.current));
    if (j !== 'Miss') globalAudio.playHitSound('slide');
    const noteColor = ctx.getNoteColor
      ? ctx.getNoteColor(slide)
      : slide.color || ctx.currentNoteColorRef.current || ctx.chartRef.current.metadata.noteColor;
    // Spawn at the slide node's actual z position (see commitJudgement).
    const noteZ = noteHitZ(dtMs, ctx.speedRef.current);
    const nodeAngle = idx === 0 ? (slide.angle ?? 0) : (slide.resolvedNodes?.[idx - 1]?.angle ?? 0);
    // 特效/反馈钉落位：slide 子节点用各自 timeSec 求落点偏移（nx/ny 是嵌入
    // curTime 偏移后的坐标，仅作未注入时的回退）。
    const lp = ctx.getLandingPos ? ctx.getLandingPos(slide, idx) : { x: nx, y: ny };
    spawnBurst(lp.x, lp.y, j, 'slide', noteColor, noteZ, nodeAngle);
    ctx.onJudgementRef.current?.({ id: key, type: j, x: lp.x, y: lp.y, deltaT: dtMs, scoreGained: sc, createdAt: performance.now(), noteType: 'slide', noScore: noScore || undefined });
    // slide 子节点沿用**头节点**的触发器（子节点不带自己的 trigger）。
    ctx.dispatchNoteTrigger?.(slide, j);
  };

  const getSlideRt = (id: string, nodeCount: number): SlideRt => {
    let rt = ctx.slideStateRef.current.get(id);
    if (!rt || rt.nodes.length !== nodeCount) {
      rt = {
        boundPointerIds: new Set(),
        headReleasePending: false,
        nodes: Array.from({ length: nodeCount }, () => ({
          judged: false,
          missLocked: false,
          everInZone: false,
          lastInsideTime: null,
          lastInsidePointerId: null,
          arrivalChecked: false,
          tailLockedSPerfect: false,
          earlySPLocked: false,
          earlyTouchIds: [],
        })),
      };
      ctx.slideStateRef.current.set(id, rt);
    }
    return rt;
  };

  /**
   * slide 链式逐节点判定。
   *
   * 判定规则已抽取为纯逻辑核心 `systems/slideJudge.processSlideCore`——3D / 2D / Lite
   * 共用同一套语义，消除此前三份实现各自复制导致的行为分叉（规则说明见核心处）。
   * 本函数只做适配：把 ctx 的 refs 与 3D 端指针容器（`Map<number, PointerState>` /
   * `Set<number>` 绑定）转成核心的中立入参，并把核心的提交回调接到本端的
   * 计分 / 音效 / 特效 / onJudgement 上。
   */
  const processSlide = (note: ResolvedNote, curTime: number): void => {
    // Cached: avoids rebuilding [head, ...resolvedNodes] every frame.
    if (note.fake) return; // 假音符：整条 slide 链不判定（含漏掉也不打断连击）
    const allNodes = ctx.getAllNodes(note);
    const rt = getSlideRt(note.id, allNodes.length);

    const pointers: SlideJudgePointer<number>[] = [];
    /* 故事板判定拦截（§3.7 v3）：被拦截的指针不参与 slide 判定 —— 既不能绑新节点，
       也不会被判为命中。与 tap 入口（useEditorGestures）读同一个判定源，
       三处（tap / slide 指针表 / 绑定脱手）因此不会出现行为分叉。
       未注入 isPointerBlocked = 不拦截（旧行为逐字不变）。 */
    const blocked = ctx.isPointerBlocked;
    for (const [pid, p] of ctx.pointersRef.current) {
      if (blocked && blocked(pid)) continue;
      pointers.push({ id: pid, x: p.x, y: p.y, down: p.down });
    }

    processSlideCore<number>({
      nodes: allNodes,
      rt: rt as unknown as SlideJudgeState<number>,
      bound: setBinding(rt.boundPointerIds),
      pointers,
      curTime,
      autoPlay: ctx.autoPlayRef.current,
      playStartTime: ctx.playStartTimeRef.current,
      commit: (idx, j, dtMs) => commitSlideNode(note, idx, allNodes[idx].x, allNodes[idx].y, j, dtMs),
    });
  };

  return { commitJudgement, commitSlideNode, getSlideRt, processSlide };
};
