import * as THREE from 'three';
import type { JudgementType, NoteType } from '../types/game';
import { deriveBurstConfig, deriveShatterParticles } from '../systems/effects';
// 游戏常数统一收敛在 gameplayConstants（单一来源）。
import { BLOOM_LAYER, JUDGE_Z, SLIDE_RING_OUTER, TAP_RING_OUTER, TOUCH_RING_OUTER } from '../gameplayConstants';
import type { JudgeSystemContext } from './judgeContext';

/**
 * 复用池：消除每次命中的 Group 分配；投影贴图几何按类型共享，避免每次命中 new PlaneGeometry。
 * 注意 ring 模式复用 ctx.makeRingMesh（其内 _unitGeo 共享、仅 Material 逐命中创建，与原实现一致）；
 * projTex 模式用共享单位平面几何 + 逐命中 Material。碎裂 Points 用固定 90 容量 BufferGeometry
 * 复用（仅重写 position 缓冲）。剔除时回收而非销毁，避免逐命中分配与 GPU 资源抖动。
 */
const burstPool: THREE.Group[] = [];
const shatterPool: THREE.Points[] = [];
// 投影贴图（自定义皮肤）用的单位平面几何，按音符类型共享，避免每次命中 new PlaneGeometry。
const planeGeoCache: Record<string, THREE.PlaneGeometry> = {};
function getPlaneGeo(nt: NoteType): THREE.PlaneGeometry {
  let g = planeGeoCache[nt];
  if (!g) {
    g = new THREE.PlaneGeometry(1, 1);
    planeGeoCache[nt] = g;
  }
  return g;
}

export function recycleBurst(group: THREE.Group): void {
  // 释放 Group 内子 Mesh 的逐命中 Material（几何为共享，不在此释放），再回收空 Group。
  const child = group.children[0] as THREE.Mesh | undefined;
  (child?.material as THREE.Material | undefined)?.dispose();
  group.clear();
  burstPool.push(group);
}

export function recycleShatter(points: THREE.Points): void {
  shatterPool.push(points);
}

/**
 * 组件卸载 / 场景销毁时释放池内每实例 Material（共享几何 _unitGeo / planeGeo 不在此释放，
 * 它们被音符网格共用，销毁会污染其它音符）。
 */
export function disposeEffectPools(): void {
  for (const g of burstPool) {
    const child = g.children[0] as THREE.Mesh | undefined;
    (child?.material as THREE.Material | undefined)?.dispose();
  }
  burstPool.length = 0;
  for (const p of shatterPool) {
    (p.material as THREE.Material | undefined)?.dispose();
  }
  shatterPool.length = 0;
  for (const k of Object.keys(planeGeoCache)) {
    planeGeoCache[k].dispose();
    delete planeGeoCache[k];
  }
}

/**
 * 迁出 GameCanvas 的 `spawnBurst`：在判定点生成打击特效（投影贴图 / 描边环）与碎裂粒子。
 * 行为零变化（视觉与原实现一致），仅把逐命中 Group 分配改为对象池复用、投影贴图几何共享。
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
    const col = new THREE.Color(burst.colorHex);
    const projTex = ctx.pickProj(nt);

    // 复用 Group（首建时 new Group；逐命中不再分配 Group）。子 Mesh 按模式重建：
    // - projTex：共享单位平面几何 + 逐命中 Material（与原实现一致，但几何不再每次 new）。
    // - ring：复用 ctx.makeRingMesh（_unitGeo 共享，仅 Material 逐命中创建，与原实现一致）。
    let g = burstPool.pop();
    if (!g) g = new THREE.Group();
    g.clear();
    let mesh: THREE.Mesh;
    if (projTex) {
      const size = ctx.projSize(nt);
      mesh = new THREE.Mesh(
        getPlaneGeo(nt),
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
      mesh.scale.set(size, size, 1);
    } else {
      const outer =
        nt === 'tap' ? TAP_RING_OUTER : nt === 'touch' ? TOUCH_RING_OUTER : SLIDE_RING_OUTER;
      mesh = ctx.makeRingMesh(outer, ctx.defaultSkinJudgeWidthRef.current, col, 0.95);
    }
    mesh.layers.enable(BLOOM_LAYER);
    g.add(mesh);
    g.position.set(x, y, JUDGE_Z + 0.05);
    g.rotation.z = -(angle ?? 0);
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
      // 复用 Points（固定 90 容量 BufferGeometry，仅重写 position 缓冲）。
      let pts = shatterPool.pop();
      let sGeo: THREE.BufferGeometry;
      let sMat: THREE.PointsMaterial;
      if (!pts) {
        sGeo = new THREE.BufferGeometry();
        sGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(res.positions.length), 3));
        sMat = new THREE.PointsMaterial({
          size: 0.16,
          map: ctx.particleSpriteRef.current,
          transparent: true,
          opacity: 1.0,
          sizeAttenuation: true,
          alphaTest: 0.0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        pts = new THREE.Points(sGeo, sMat);
        pts.layers.enable(BLOOM_LAYER);
      } else {
        sGeo = pts.geometry as THREE.BufferGeometry;
        sMat = pts.material as THREE.PointsMaterial;
      }
      const posAttr = sGeo.getAttribute('position') as THREE.BufferAttribute;
      (posAttr.array as Float32Array).set(res.positions);
      posAttr.needsUpdate = true;
      sGeo.setDrawRange(0, res.count);
      sMat.color.set(res.colorHex);
      sMat.opacity = 1.0;
      sMat.size = 0.16;
      sMat.map = ctx.particleSpriteRef.current;
      sMat.needsUpdate = true;
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
