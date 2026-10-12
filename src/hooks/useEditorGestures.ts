import type { JudgementType } from '../types/game';
import type { PreparedNote } from '../utils/chartRuntime';
import { clampPlaneX, clampPlaneY } from '../utils/editorCoords';
import { globalAudio } from '../audio/AudioManager';
// tap 命中检索 + 选中（方案二重叠合并）已下沉 shared/tapJudge，环境面在此注入。
import { judgeTapCore, tapJudgeDeps } from '../systems/tapJudge';
import type { JudgeSystemContext } from './judgeContext';

/** commitJudgement 的函数签名（与 useJudgeSystem 返回值一致）。 */
export type CommitJudgementFn = (note: PreparedNote, j: JudgementType, dtMs: number) => void;

/**
 * 迁出 GameCanvas 的 `handlePointerInteraction`：编辑器模式下的放置/选择，以及玩法模式下的 tap 命中判定。
 * 实现逐字搬移，依赖经 ctx 注入；commitJudgement 由 useJudgeSystem 提供。行为零变化。
 */
export const useEditorGestures = (ctx: JudgeSystemContext, commitJudgement: CommitJudgementFn) => {
  /**
   * `pointerId` 为可选：透传后由**玩法分支自己**查 `ctx.isPointerBlocked` 收口
   * （故事板判定拦截，§3.7 v3）。收口点选在这里而不是调用处的原因：判定入口只有
   * 这一条，集中在判定层可避免"漏一处就能打出音"；编辑器分支天然不受影响。
   */
  const handlePointerInteraction = (px: number, py: number, pointerId?: number): void => {
    if (ctx.isEditorModeRef.current) {
      const tool = ctx.activeToolRef.current;
      if (tool === 'place-tap' || tool === 'place-touch' || tool === 'place-slide') {
        const clampedX = Math.round(clampPlaneX(px) * 10) / 10;
        const clampedY = Math.round(clampPlaneY(py) * 10) / 10;
        ctx.onPlaceEditorNoteRef.current?.(clampedX, clampedY);
        return;
      }

      // Select / Move tool — heads and slide child nodes are all selectable near current time.
      const notes = ctx.resolvedRef.current;
      let clickedId: string | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      // Read time from the audio clock when playing (same source as tick),
      // fall back to gameTimeRef when paused/editor scrubbing. Must NOT rely
      // solely on gameTimeRef because React.memo skips gameTime prop updates
      // during playback → ref stays stale → selection would target wrong beat.
      const curTime = (ctx.isPlayingRef.current && !ctx.isPausedRef.current)
        ? globalAudio.getCurrentTime()
        : ctx.gameTimeRef.current;
      const curBeat = ctx.chartTimeToBeat(curTime);

      for (const n of notes) {
        // 图层偏移：编辑器选择同样针对「合成后」位置（slide 子节点沿用头节点图层）。
        const ep = ctx.getEffectivePos(n);
        const dx = ep.x - n.x;
        const dy = ep.y - n.y;
        const candidates: Array<{ id: string; x: number; y: number; beat: number; r: number }> =
          n.type === 'slide'
            ? [
                { id: n.id, x: n.x + dx, y: n.y + dy, beat: n.beat, r: 0.7 },
                ...(n.resolvedNodes ?? []).map((sn, i) => ({
                  id: `${n.id}#${i + 1}`, x: sn.x + dx, y: sn.y + dy, beat: sn.beat, r: 0.7,
                })),
              ]
            : [{ id: n.id, x: n.x + dx, y: n.y + dy, beat: n.beat, r: n.type === 'tap' ? 0.85 : 0.65 }];
        for (const c of candidates) {
          // Changed: only allow selecting notes in the range of [curBeat - 0.1, curBeat + 0.5]
          // so the user cannot accidentally select overdue past notes that are already gone.
          if (c.beat < curBeat - 0.1 || c.beat > curBeat + 0.5) continue;
          const d = Math.hypot(px - c.x, py - c.y);
          if (d < c.r && d < bestDist) { clickedId = c.id; bestDist = d; }
        }
      }

      if (clickedId) {
        ctx.onSelectEditorNoteRef.current?.(clickedId);
        ctx.isDraggingRef.current = false;
      } else {
        ctx.onSelectEditorNoteRef.current?.(null);
      }
      return;
    }

    // Normal Gameplay: tap hit — earliest note wins when windows overlap
    if (!ctx.isPlayingRef.current || ctx.isPausedRef.current) return;
    /* 故事板判定拦截（§3.7 v3）：被拦截的指针不产生任何 tap 判定。
       放在这里（而非调用处）是为了让"判定入口"只有这一处收口。 */
    if (pointerId !== undefined && ctx.isPointerBlocked(pointerId)) return;
    // Read audio time directly from the audio clock. Must NOT use gameTimeRef
    // here because React.memo skips gameTime prop updates during playback →
    // ref stays at initial value → all notes appear outside the hit window →
    // taps never register. The tick() function uses the same source for motion,
    // so judgement and visuals are perfectly synchronized.
    const curTime = globalAudio.getCurrentTime();
    const notes = ctx.resolvedRef.current;
    /* 方案二（overlap-aware tap judgment）已下沉 shared/tapJudge.judgeTapCore：
     * 命中盒 = 自身盒 ∪ 已合并的 extraHitRegions；同刻重叠取最近、跨时刻取最晚；
     * 判定后把自身盒合并进同刻其它可命中 tap。规则面在 tapJudgeDeps，环境面在此注入。 */
    const hit = judgeTapCore(
      notes,
      px,
      py,
      curTime,
      {
        getEffectivePos: (n: PreparedNote) => ctx.getEffectivePos(n),
        isJudged: (n: PreparedNote) => ctx.judgedNotesRef.current.has(n.id),
      },
      tapJudgeDeps,
    );
    if (hit) commitJudgement(hit.note, hit.judgement, hit.dtMs);
  };

  return handlePointerInteraction;
};
