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
    ctx.judgedNotesRef.current.add(note.id);
    ctx.judgedCountRef.current++;
    const sc = calculateNoteScore(j, countPlayableNotes(ctx.chartRef.current));
    if (j !== 'Miss') globalAudio.playHitSound(note.type);
    // Note color = per-note override, then event-driven current color, then chart default.
    const noteColor = note.color || ctx.currentNoteColorRef.current || ctx.chartRef.current.metadata.noteColor;
    // Spawn the burst at the note's ACTUAL z position when hit, not at the
    // judgement plane. noteZ = JUDGE_Z + (dtMs/1000)*speed: early hits
    // (dtMs<0) place the burst behind the plane (note still approaching);
    // late hits (dtMs>0) place it in front (note has passed). +0.05 keeps
    // particles just in front of the note mesh to avoid z-fighting.
    const noteZ = noteHitZ(dtMs, ctx.speedRef.current);
    spawnBurst(note.x, note.y, j, note.type, noteColor, noteZ, note.angle ?? 0);
    ctx.onJudgementRef.current?.({ id: note.id, type: j, x: note.x, y: note.y, deltaT: dtMs, scoreGained: sc, createdAt: performance.now(), noteType: note.type });
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
    ctx.judgedNotesRef.current.add(key);
    ctx.judgedCountRef.current++;
    const sc = calculateNoteScore(j, countPlayableNotes(ctx.chartRef.current));
    if (j !== 'Miss') globalAudio.playHitSound('slide');
    const noteColor = slide.color || ctx.currentNoteColorRef.current || ctx.chartRef.current.metadata.noteColor;
    // Spawn at the slide node's actual z position (see commitJudgement).
    const noteZ = noteHitZ(dtMs, ctx.speedRef.current);
    const nodeAngle = idx === 0 ? (slide.angle ?? 0) : (slide.resolvedNodes?.[idx - 1]?.angle ?? 0);
    spawnBurst(nx, ny, j, 'slide', noteColor, noteZ, nodeAngle);
    ctx.onJudgementRef.current?.({ id: key, type: j, x: nx, y: ny, deltaT: dtMs, scoreGained: sc, createdAt: performance.now(), noteType: 'slide' });
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
    const allNodes = ctx.getAllNodes(note);
    const rt = getSlideRt(note.id, allNodes.length);

    const pointers: SlideJudgePointer<number>[] = [];
    for (const [pid, p] of ctx.pointersRef.current) {
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
