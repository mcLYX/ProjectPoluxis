import type { HitRegion, JudgementType } from '../types/game';
import type { PreparedNote } from '../utils/chartRuntime';
import { clampPlaneX, clampPlaneY } from '../utils/editorCoords';
import { isWithinBox } from '../systems/judge';
import { evaluateJudgement } from '../utils/scoring';
import { globalAudio } from '../audio/AudioManager';
// 游戏常数统一收敛在 gameplayConstants（单一来源）。
import { HIT_WINDOW_MS, TAP_HIT_HALF } from '../gameplayConstants';
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
    // 方案二: overlap-aware tap judgment.
    // A tap is "hittable" if the touch point falls inside its own box OR any of
    // its merged extra hit regions. Among all hittable same-time taps, pick the
    // one closest to the touch point (tie-break by id) and consume it; then merge
    // the consumed tap's own box into every other hittable tap the point overlapped,
    // so subsequent presses on the overlap can still reach them.
    const overlapSet: PreparedNote[] = [];
    for (const n of notes) {
      if (ctx.judgedNotesRef.current.has(n.id) || n.type !== 'tap' || n.fake) continue;
      const dt = Math.abs((curTime - n.timeSec) * 1000);
      if (dt >= HIT_WINDOW_MS) continue;
      const ep = ctx.getEffectivePos(n);
      const inOwn = isWithinBox(px, py, ep.x, ep.y, TAP_HIT_HALF);
      const inExtra = (n.extraHitRegions ?? []).some(
        (r) => Math.abs(px - r.x) < r.half && Math.abs(py - r.y) < r.half
      );
      if (inOwn || inExtra) overlapSet.push(n);
    }
    let best: PreparedNote | null = null;
    let bestDist = Infinity;
    // Selection rule (fixes late-tap swallow bug): when the touch point lands
    // inside the hitbox of taps at DIFFERENT times (neighbouring close taps with
    // overlapping TAP_HIT_HALF boxes), prefer the MOST LATE one — the tap closest
    // to its miss deadline is the one the player is racing to rescue. Judging the
    // nearer-but-later tap first would swallow the earlier late tap (e.g. note-291
    // late but note-292 closer → 292 got judged, 291 dropped). Within the chosen
    // time group (truly same-time overlapping taps) fall back to 方案二: pick the
    // closest to the touch point, then merge hitboxes. Times are numeric and
    // id-independent (ids can be arbitrary strings).
    let bestLate = -Infinity;
    let bestTimeSec = Infinity;
    for (const n of overlapSet) {
      const late = curTime - n.timeSec; // seconds, signed; larger = later
      if (late > bestLate) { bestLate = late; bestTimeSec = n.timeSec; }
    }
    for (const n of overlapSet) {
      if (n.timeSec !== bestTimeSec) continue; // only the most-late time group
      const ep = ctx.getEffectivePos(n);
      const d = Math.hypot(px - ep.x, py - ep.y);
      /* 同级时间组内的并列处理：上面的 `n.timeSec !== bestTimeSec` 已把候选收敛到
       * **同一时刻**，故原先那句 `d === bestDist && best !== null && n.timeSec <
       * best.timeSec` 恒为 false —— 三者都是死判断（`best !== null` 亦非 TS 窄化所需，
       * 因为删掉后不再访问 `best.timeSec`）。并列时取先遇到者即可，语义不变。 */
      if (d < bestDist) {
        best = n;
        bestDist = d;
      }
    }
    if (best) {
      const dt = (curTime - best.timeSec) * 1000;
      const j = evaluateJudgement(dt);
      if (j) {
        commitJudgement(best, j, dt);
        // Merge the consumed tap's own box ONLY into other taps at the SAME
        // timeSec (方案二). Never cross time windows: a tap at a different beat
        // must keep its own hitbox, otherwise its hit area would be polluted and
        // trigger false/early hits later (e.g. note-9 / note-10 same position).
        const bestEp = ctx.getEffectivePos(best);
        const merged: HitRegion = { x: bestEp.x, y: bestEp.y, half: TAP_HIT_HALF };
        for (const other of overlapSet) {
          if (other === best || other.timeSec !== best.timeSec) continue;
          const regions = other.extraHitRegions ?? (other.extraHitRegions = []);
          const dup = regions.some((r) => r.x === merged.x && r.y === merged.y && r.half === merged.half);
          if (!dup) regions.push(merged);
        }
      }
    }
  };

  return handlePointerInteraction;
};
