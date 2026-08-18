import * as THREE from 'three';
import type { JudgementType, NoteType } from '../types/game';
import { deriveBurstConfig, deriveShatterParticles } from '../systems/effects';
// 游戏常数统一收敛在 gameplayConstants（单一来源）。
import { BLOOM_LAYER, JUDGE_Z, SLIDE_RING_OUTER, TAP_RING_OUTER, TOUCH_RING_OUTER } from '../gameplayConstants';
import type { JudgeSystemContext } from './judgeContext';

/**
 * 迁出 GameCanvas 的 `spawnBurst`：在判定点生成打击特效（投影贴图 / 描边环）与碎裂粒子。
 * 完全逐字搬移原实现，依赖通过 ctx 注入，行为零变化。
 */
export const useNoteEffects = (ctx: JudgeSystemContext) => {
  const spawnBurst = (
    x: number,
    y: number,
    j: JudgementType,
    nt: NoteType,
    noteColorHex?: string,
    z: number = JUDGE_Z + 0.05,
    angle: number = 0,
  ): void => {
    if (!ctx.sceneRef.current || !ctx.groupsRef.current) return;
    const fx = ctx.groupsRef.current.fx;
    const burst = deriveBurstConfig(j, nt, ctx.sizeScaleRef.current);
    const g = new THREE.Group();
    g.position.set(x, y, JUDGE_Z + 0.05);
    g.rotation.z = -(angle ?? 0);
    const col = new THREE.Color(burst.colorHex);
    const projTex = ctx.pickProj(nt);
    if (projTex) {
      const size = ctx.projSize(nt);
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({
          color: col,
          transparent: true,
          opacity: 0.95,
          map: projTex,
          alphaTest: 0.02,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      mesh.layers.enable(BLOOM_LAYER);
      g.add(mesh);
    } else {
      const outer =
        nt === 'tap' ? TAP_RING_OUTER : nt === 'touch' ? TOUCH_RING_OUTER : SLIDE_RING_OUTER;
      g.add(ctx.makeRingMesh(outer, ctx.defaultSkinJudgeWidthRef.current, col, 0.95));
    }
    const visualScale = ctx.sizeScaleRef.current;
    g.scale.set(visualScale, visualScale, 1);
    fx.add(g);
    ctx.activeBurstsRef.current.push({
      group: g,
      startTime: performance.now(),
      duration: burst.duration,
      scaleTarget: burst.scaleTarget,
      baseScale: burst.baseScale,
    });

    if (ctx.allowHitEffectsRef.current && j !== 'Miss') {
      const noteColHex = noteColorHex || burst.colorHex;
      const res = deriveShatterParticles({
        nt,
        angle,
        x,
        y,
        z,
        visualScale,
        speed: ctx.speedRef.current,
        noteColorHex: noteColHex,
        rng: Math.random,
      });
      const sGeo = new THREE.BufferGeometry();
      sGeo.setAttribute('position', new THREE.BufferAttribute(res.positions, 3));
      const sMat = new THREE.PointsMaterial({
        color: new THREE.Color(res.colorHex),
        size: 0.16,
        map: ctx.particleSpriteRef.current,
        transparent: true,
        opacity: 1.0,
        sizeAttenuation: true,
        alphaTest: 0.0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const pts = new THREE.Points(sGeo, sMat);
      pts.layers.enable(BLOOM_LAYER);
      fx.add(pts);
      ctx.shatterSystemsRef.current.push({
        points: pts,
        velocities: res.velocities,
        startMs: performance.now(),
        duration: res.duration,
        color: new THREE.Color(res.colorHex),
      });
    }
  };

  return spawnBurst;
};
