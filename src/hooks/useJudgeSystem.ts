import type { JudgementType, NoteType, ResolvedNote } from '../types/game';
import { isWithinBox, noteHitZ, withinHitWindow } from '../systems/judge';
import { evaluateJudgement, calculateNoteScore } from '../utils/scoring';
import { countPlayableNotes } from '../utils/beatTime';
import { globalAudio } from '../audio/AudioManager';
// 游戏常数统一收敛在 gameplayConstants（单一来源）；SlideRt 类型随 GameCanvas 定义。
import { HIT_WINDOW_MS, SLIDE_HIT_HALF } from '../gameplayConstants';
import type { SlideRt } from '../components/GameCanvas';
import type { JudgeSystemContext } from './judgeContext';

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
 * 实现逐字搬移，依赖经 ctx 注入；spawnBurst 由 useNoteEffects 提供。行为零变化。
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
    const noteColor = slide.color || ctx.chartRef.current.metadata.noteColor;
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
        nodes: Array.from({ length: nodeCount }, () => ({
          judged: false,
          missLocked: false,
          everInZone: false,
          lastInsideTime: null,
          lastInsidePointerId: null,
          arrivalChecked: false,
          redWarn: false,
          tailLockedSPerfect: false,
        })),
      };
      ctx.slideStateRef.current.set(id, rt);
    }
    return rt;
  };

  /**
   * Simplified Slide chain judgement (per latest spec):
   * - Nodes behave like Touch but require the pointer to be HELD.
   * - Once a node is judged, EVERY finger currently on that node becomes bound; any of the
   *   bound fingers can judge later nodes (multi-finger support, solves overlapping-node cases).
   * - A bound finger that lifts (released) is removed. A bound finger still down but off the
   *   current node is dropped ONLY when at least one other bound finger is already on that node;
   *   if no bound finger is on the node yet (e.g. fingers still at a shared start, or travelling
   *   between nodes) all bindings are kept, so the chain never loses the finger that will service
   *   the next node (this is what makes split slides from a shared start work).
   * - On release of the LAST remaining bound pointer, the *next unjudged node* is immediately
   *   locked red and will be judged as Late Miss after +160ms, regardless of position.
   * - No Early Miss on release. A normal Miss does NOT clear the binding.
   */
  const processSlide = (note: ResolvedNote, curTime: number): void => {
    // Cached: avoids rebuilding [head, ...resolvedNodes] every frame.
    const allNodes = ctx.getAllNodes(note);
    const rt = getSlideRt(note.id, allNodes.length);

    // 1) Late-miss every unjudged node past +160ms (incl. missLocked ones)
    for (let i = 0; i < allNodes.length; i++) {
      const ns = rt.nodes[i];
      if (ns.judged) continue;
      // 从谱面中间试玩：起点之前（且未被 resetPlayState 预标记）的节点直接标记
      // 已判定、不产生 Miss 框——它们是开局前就已越过的音符。
      if (allNodes[i].timeSec < ctx.playStartTimeRef.current) {
        ns.judged = true;
        ns.redWarn = false;
        continue;
      }
      const dtI = (curTime - allNodes[i].timeSec) * 1000;
      if (dtI > HIT_WINDOW_MS) {
        ns.judged = true;
        ns.redWarn = false;
        commitSlideNode(note, i, allNodes[i].x, allNodes[i].y, 'Miss', dtI);
        // A miss does not change the binding of subsequent nodes.
      }
    }

    // 2) Simplified release detection (per new spec):
    // Once ALL bound pointers are released, the *next unjudged node* is immediately
    // locked red and will be judged as Late Miss after +160ms, regardless of position.
    // No more "judge at release time" or Early Miss on release.
    // EXCEPTION: If the next node is a tail node already locked for S-Perfect
    // (tailLockedSPerfect), skip missLocked — the player held through the end.
    // nextIdx / current node are needed both here (move-away removal) and in step 3.
    const nextIdx = rt.nodes.findIndex((n) => !n.judged);
    const ndForCheck = nextIdx >= 0 ? allNodes[nextIdx] : null;

    if (rt.boundPointerIds.size > 0) {
      // Remove released pointers from the bound set
      let allReleased = true;
      for (const pid of rt.boundPointerIds) {
        const bp = ctx.pointersRef.current.get(pid);
        if (bp && bp.down) {
          allReleased = false;
        } else {
          rt.boundPointerIds.delete(pid);
        }
      }
      // Multi-finger binding: a bound finger that is still down but has slid off the
      // current node is a candidate to be dropped. HOWEVER we must NOT prune during the
      // moment two chains share a start node and the fingers haven't diverged yet (e.g. a
      // split slide where both fingers are still sitting on the shared head, so neither is
      // on either chain's NEXT node). Pruning then would keep, by insertion order, the
      // finger heading the WRONG way and permanently drop the correct one.
      // Fix: only drop off-node fingers when at least ONE bound finger is already on the
      // current node. If none are on it yet (all still travelling / at a shared start),
      // keep every binding so the correct finger is retained until it arrives.
      if (ndForCheck && rt.boundPointerIds.size > 0) {
        const onNodeBound: number[] = [];
        const offNodeBound: number[] = [];
        for (const pid of rt.boundPointerIds) {
          const bp = ctx.pointersRef.current.get(pid);
          const onNode = !!bp && bp.down &&
            Math.abs(bp.x - ndForCheck.x) < SLIDE_HIT_HALF &&
            Math.abs(bp.y - ndForCheck.y) < SLIDE_HIT_HALF;
          (onNode ? onNodeBound : offNodeBound).push(pid);
        }
        if (onNodeBound.length > 0) {
          for (const pid of offNodeBound) rt.boundPointerIds.delete(pid);
        }
      }
      if (allReleased && rt.boundPointerIds.size === 0 && nextIdx >= 0) {
        const ns = rt.nodes[nextIdx];
        if (!ns.judged && !ns.tailLockedSPerfect) {
          ns.missLocked = true;
          ns.redWarn = false;
        }
      }
    }

    // 3) Interact with the current next node (nextIdx / ndForCheck hoisted above)
    if (nextIdx < 0) return;
    const ns = rt.nodes[nextIdx];
    const nd = allNodes[nextIdx];
    const dt = (curTime - nd.timeSec) * 1000;

    if (ctx.autoPlayRef.current) {
      // AutoPlay: judge as soon as the slide node has passed the plane (dt >= 0).
      if (dt >= 0 && !ns.judged) {
        ns.judged = true;
        commitSlideNode(note, nextIdx, nd.x, nd.y, 'S-Perfect', dt);
      }
      ns.redWarn = false;
      return;
    }

    if (ns.missLocked) { ns.redWarn = false; return; }

    // --- Tail-node special rule ---
    // The last slide node has a relaxed judgement: if ANY bound pointer is still
    // on screen (anywhere) when the node enters the hit window (-160ms), lock it
    // as S-Perfect. The player just needs to hold through the end without lifting.
    const isTail = nextIdx === allNodes.length - 1;
    if (isTail && !ns.tailLockedSPerfect && dt >= -HIT_WINDOW_MS) {
      // Check if ANY bound pointer is still on screen (down === true).
      // Free chain (no binding yet) → any held pointer counts.
      if (rt.boundPointerIds.size > 0) {
        for (const pid of rt.boundPointerIds) {
          const bp = ctx.pointersRef.current.get(pid);
          if (bp && bp.down) {
            ns.tailLockedSPerfect = true;
            break;
          }
        }
      } else {
        // No binding yet: if any pointer is held, lock it.
        for (const [, p] of ctx.pointersRef.current) {
          if (p.down) { ns.tailLockedSPerfect = true; break; }
        }
      }
    }

    // Which pointers may judge this node? Bound chain → any bound pointer; free chain → any held pointer.
    // Collect EVERY finger currently on the node (multi-finger binding): each eligible finger inside the
    // hit box is a candidate, not just the first one. Overlapping nodes are then each serviced by
    // whatever finger covers them.
    const onNodePids: number[] = [];
    if (rt.boundPointerIds.size > 0) {
      for (const pid of rt.boundPointerIds) {
        const p = ctx.pointersRef.current.get(pid);
        if (p && p.down &&
            isWithinBox(p.x, p.y, nd.x, nd.y, SLIDE_HIT_HALF)) {
          onNodePids.push(pid);
        }
      }
    } else {
      for (const [pid, p] of ctx.pointersRef.current) {
        if (!p.down) continue;
        if (isWithinBox(p.x, p.y, nd.x, nd.y, SLIDE_HIT_HALF)) onNodePids.push(pid);
      }
    }

    // Track "has passed the zone while held" for release-judging (no time restriction).
    if (rt.boundPointerIds.size > 0 && onNodePids.length > 0) ns.everInZone = true;

    if (withinHitWindow(dt, HIT_WINDOW_MS) && onNodePids.length > 0) {
      ns.lastInsideTime = curTime;
      ns.lastInsidePointerId = onNodePids[0];
    }

    if (dt >= 0 && !ns.judged) {
      // Tail-node locked S-Perfect: any bound pointer is on screen → instant S-Perfect.
      // Doesn't require being in the spatial zone, just holding through the end.
      if (isTail && ns.tailLockedSPerfect) {
        ns.judged = true;
        // If no binding yet, bind all currently held pointers.
        if (rt.boundPointerIds.size === 0) {
          for (const [pid, p] of ctx.pointersRef.current) {
            if (p.down) rt.boundPointerIds.add(pid);
          }
        }
        commitSlideNode(note, nextIdx, nd.x, nd.y, 'S-Perfect', dt);
      } else if (!ns.arrivalChecked) {
        ns.arrivalChecked = true;
        if (onNodePids.length > 0) {
          ns.judged = true;
          // Bind EVERY finger on the node (multi-finger).
          for (const pid of onNodePids) rt.boundPointerIds.add(pid);
          commitSlideNode(note, nextIdx, nd.x, nd.y, 'S-Perfect', dt);
        }
      } else if (onNodePids.length > 0 && dt <= HIT_WINDOW_MS) {
        const j = evaluateJudgement(dt);
        if (j) {
          ns.judged = true;
          for (const pid of onNodePids) rt.boundPointerIds.add(pid);
          commitSlideNode(note, nextIdx, nd.x, nd.y, j, dt);
        }
      }
    }

    // 4) Red warning (recoverable): in time window, chain has bindings,
    //    NONE of the bound pointers are on the node,
    //    but some other held pointer IS on it → move the correct finger back to recover.
    ns.redWarn = false;
    if (!ns.judged && rt.boundPointerIds.size > 0 && onNodePids.length === 0 && withinHitWindow(dt, HIT_WINDOW_MS)) {
      for (const [pid, p] of ctx.pointersRef.current) {
        if (rt.boundPointerIds.has(pid) || !p.down) continue;
        if (isWithinBox(p.x, p.y, nd.x, nd.y, SLIDE_HIT_HALF)) { ns.redWarn = true; break; }
      }
    }
  };

  return { commitJudgement, commitSlideNode, getSlideRt, processSlide };
};
