/**
 * 资源引用地址的纯判定工具。
 *
 * 项目里的引用有三种「已经可直接使用、不需要再拼接/查找」的形态：
 * - `http(s)://` —— 在线清单（`beatmaps.json`）里的绝对地址；
 * - `blob:` —— 故事板 / 运行时创建的 object URL；
 * - `idb://` —— zip 导入后落在 IndexedDB 里的文件（`resolveIdbUrl` 再转成 blob URL）。
 *
 * 其余（相对路径）才需要按 `baseUrl` 拼接、或在 zip 条目表里按名字查找。
 *
 * 之所以抽成单一实现：`data/beatmapLoader.ts` 的清单归一化与 `data/zipImport.ts`
 * 的 zip 引用解析各自复制了同一段前置判定（代码审查文档第二节 #20）。判定本身
 * 与「引用来自哪里」无关，故放在 `utils/` 而非 `shared/`（只有完整版消费，
 * 且 `shared/` 带 ES5 + 禁运行时 import 约束）。
 */
export function isAbsoluteRef(ref: string): boolean {
  return /^https?:\/\//.test(ref) || ref.startsWith('blob:') || ref.startsWith('idb://');
}
