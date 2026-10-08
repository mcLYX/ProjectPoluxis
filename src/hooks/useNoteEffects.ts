import * as THREE from 'three';
import type { JudgementType, NoteType } from '../types/game';
import { deriveBurstConfig, deriveShatterParticles, SHATTER_PARTICLE_COUNT } from '../systems/effects';
// 游戏常数统一收敛在 gameplayConstants（单一来源）。
import { BLOOM_LAYER, JUDGE_Z, SLIDE_RING_OUTER, TAP_RING_OUTER, TOUCH_RING_OUTER } from '../gameplayConstants';
import type { JudgeSystemContext } from './judgeContext';

/**
 * 复用池：消除每次命中的 Group / Mesh / Material / 粒子缓冲分配。
 *
 * - burst：**整个 Mesh（含 Material）**按 key 池化复用，命中时只改颜色/透明度/缩放。
 *   旧实现逐命中 `new Material` 并在回收时 `dispose()`，密集多指连打时是主要 GC 源；
 *   材质只在 `disposeEffectPools()`（组件卸载 / 场景销毁）时统一释放。
 *   key = `p|<nt>`（投影贴图模式）或 `r|<nt>|<描边宽>`（默认皮肤环模式，环尺寸随描边宽变化）。
 * - shatter：固定 90 容量 BufferGeometry + PointsMaterial + positions/velocities 缓冲全部复用，
 *   `deriveShatterParticles` 直接写入复用缓冲（零分配）。
 * - 投影贴图用的单位平面几何按类型共享。
 */
const burstPool = new Map<string, THREE.Group[]>();
const shatterPool: THREE.Points[] = [];

/** burst 池化 key：投影贴图模式与环模式的网格/材质不可互换；环模式还依赖描边宽度（决定环尺寸）。 */
function burstKey(hasProj: boolean, nt: NoteType, ringWidth: number): string {
  return hasProj ? `p|${nt}` : `r|${nt}|${ringWidth}`;
}

/** 投影贴图（自定义皮肤）用的单位平面几何，按音符类型共享，避免每次命中 new PlaneGeometry。 */
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
  // 保留子 Mesh 与其 Material 供复用（不再逐命中 dispose + new）。
  const key = group.userData.burstKey;
  if (typeof key !== 'string') return;
  const bin = burstPool.get(key);
  if (bin) bin.push(group);
  else burstPool.set(key, [group]);
}

export function recycleShatter(points: THREE.Points): void {
  shatterPool.push(points);
}

/**
 * 组件卸载 / 场景销毁时释放池内每实例 Material（共享几何 _unitGeo / planeGeo 不在此释放，
 * 它们被音符网格共用，销毁会污染其它音符）。
 */
export function disposeEffectPools(): void {
  burstPool.forEach((bin) => {
    for (const g of bin) {
      const child = g.children[0] as THREE.Mesh | undefined;
      (child?.material as THREE.Material | undefined)?.dispose();
    }
  });
  burstPool.clear();
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
 * 行为零变化（视觉与原实现一致），只是把逐命中的 Group / Mesh / Material / 粒子缓冲分配
 * 改为对象池复用。
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
    const projTex = ctx.pickProj(nt);
    const ringWidth = ctx.defaultSkinJudgeWidthRef.current;

    // —— burst：复用同 key 的 Group + Mesh（含 Material），否则首建。 ——
    const key = burstKey(!!projTex, nt, ringWidth);
    const bin = burstPool.get(key);
    let g = bin && bin.length > 0 ? bin.pop()! : undefined;
    let mesh: THREE.Mesh;
    if (g) {
      mesh = g.children[0] as THREE.Mesh;
      const mat = mesh.material as THREE.MeshBasicMaterial;
      // 重置颜色/透明度（上一次播放把透明度淡出了）。
      mat.color.set(burst.colorHex);
      mat.opacity = 0.95;
      // 皮肤可能已切换：投影贴图模式下同步 map（同值时为空操作）。
      if (projTex && mat.map !== projTex) { mat.map = projTex; mat.needsUpdate = true; }
      mesh.layers.enable(BLOOM_LAYER);
    } else {
      g = new THREE.Group();
      g.userData.burstKey = key;
      if (projTex) {
        mesh = new THREE.Mesh(
          getPlaneGeo(nt),
          new THREE.MeshBasicMaterial({
            color: burst.colorHex,
            transparent: true,
            opacity: 0.95,
            map: projTex,
            alphaTest: 0.02,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
        );
      } else {
        const outer =
          nt === 'tap' ? TAP_RING_OUTER : nt === 'touch' ? TOUCH_RING_OUTER : SLIDE_RING_OUTER;
        mesh = ctx.makeRingMesh(outer, ringWidth, burst.colorHex, 0.95);
      }
      mesh.layers.enable(BLOOM_LAYER);
      g.add(mesh);
    }
    if (projTex) {
      const size = ctx.projSize(nt);
      mesh.scale.set(size, size, 1);
    }
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
      // —— shatter：复用 Points 及其 positions/velocities 缓冲（零分配）。 ——
      let pts = shatterPool.pop();
      let sGeo: THREE.BufferGeometry;
      let sMat: THREE.PointsMaterial;
      let posBuf: Float32Array;
      let velBuf: Float32Array;
      if (!pts) {
        posBuf = new Float32Array(SHATTER_PARTICLE_COUNT * 3);
        velBuf = new Float32Array(SHATTER_PARTICLE_COUNT * 3);
        sGeo = new THREE.BufferGeometry();
        sGeo.setAttribute('position', new THREE.BufferAttribute(posBuf, 3));
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
        pts.userData.positions = posBuf;
        pts.userData.velocities = velBuf;
      } else {
        sGeo = pts.geometry as THREE.BufferGeometry;
        sMat = pts.material as THREE.PointsMaterial;
        posBuf = pts.userData.positions as Float32Array;
        velBuf = pts.userData.velocities as Float32Array;
      }
      // 直接写入复用缓冲（positions 即 geometry 的 position attribute 数组）。
      const res = deriveShatterParticles(
        {
          nt,
          angle,
          x,
          y,
          z,
          visualScale,
          speed: ctx.speedRef.current,
          noteColorHex: noteColHex,
          rng: Math.random,
        },
        posBuf,
        velBuf,
      );
      const posAttr = sGeo.getAttribute('position') as THREE.BufferAttribute;
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
        velocities: velBuf,
        startMs: performance.now(),
        duration: res.duration,
      });
    }
  };

  return spawnBurst;
};
