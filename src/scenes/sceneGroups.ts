import * as THREE from 'three';

/**
 * 命名场景图分组。把一次性静态对象与运行时动态对象按职责挂到各自的 Group，
 * 便于统一管理与一次性释放；分组本身仍挂载到 scene，不改变渲染顺序/可见性，
 * 也不影响 BLOOM_LAYER（仅对象所在层决定选择性辉光）。
 */
export interface SceneGroups {
  /** 玩法对象：note 网格、slide 管道等（含 BLOOM_LAYER）。 */
  gameplay: THREE.Group;
  /** 特效对象：打击 burst、碎裂粒子（含 BLOOM_LAYER）。 */
  fx: THREE.Group;
  /** 灯光对象：AmbientLight + PointLight 池。 */
  lighting: THREE.Group;
  /** 编辑器对象：gizmo 等。 */
  editor: THREE.Group;
}

export function createSceneGroups(): SceneGroups {
  const gameplay = new THREE.Group();
  gameplay.name = 'gameplay';
  const fx = new THREE.Group();
  fx.name = 'fx';
  const lighting = new THREE.Group();
  lighting.name = 'lighting';
  const editor = new THREE.Group();
  editor.name = 'editor';
  return { gameplay, fx, lighting, editor };
}

/**
 * 释放命名分组：仅解除组内子对象挂载，不深 dispose。
 * 共享几何/材质/纹理由 GameCanvas 既有收口（disposeGroup / softShapeTexCache）处理，
 * 此处避免重复释放导致 shared-geometry 失效。
 */
export function disposeSceneGroups(g: SceneGroups): void {
  g.gameplay.clear();
  g.fx.clear();
  g.lighting.clear();
  g.editor.clear();
}
