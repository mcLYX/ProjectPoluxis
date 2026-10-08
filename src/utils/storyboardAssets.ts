/**
 * 故事板歌曲目录相对资源解析（§3.7 v3，`api.assets` 的底座）。
 *
 * 为什么需要它：story.js 在 zip / 本地库场景是以 **blob: URL** 动态 import 的
 * （`resolveStoryboardUrl` → idb:// → blob URL）。blob URL 的路径是 opaque 的，
 * 故事板内部 `fetch('./noise-domains.json')` 会解析到无意义的地址而失败。
 * 于是"歌曲目录相对路径 → 真正可 fetch 的地址"必须由宿主（知道歌曲 basePath）来拼。
 *
 * 纯函数（便于单测）：`resolveAssetPath(rel, base)` 只做字符串层面的校验与拼接，
 * 不碰网络 / DOM。
 */

/**
 * 判断歌曲目录基址能否用于 fetch（故事板 `api.assets` 的前置校验，纯函数便于单测）。
 *
 * 判据是"**能不能 fetch**"，不是"是不是绝对 URL"：
 * - `http(s):` / `blob:` / `/...`（根相对，同源）→ 可 fetch
 * - `idb://`（zip 导入的本地库歌曲）与空串 → 不可 fetch
 *
 * ⚠️ 早先这里只放行 `http(s)|blob`，把清单规范化产出的**根相对路径**
 * （`/beatmaps/...`，见 `beatmapLoader.abs`）误判成"无基址"而 reject，
 * 故事板于是静默退回内置兜底数据 —— 症状是"改了 noise-domains.json 却没生效"。
 */
export function isFetchableAssetBase(base: string): boolean {
  return !!base && /^(?:https?:|blob:|\/)/i.test(base);
}

/**
 * 取 URL 的"目录部分"（去掉最后一段）。
 *
 * 用于把 **story.js 自身的地址**当作相对资源的锚点：story.js 在
 * `http://host/beatmaps/From_Phigros/Verrückt/story.js` 时，同目录的
 * `noise-domains.json` 就应该解析成 `.../Verrückt/noise-domains.json`。
 *
 * 与 `chartFile` 反推相比，它不依赖清单里有没有填 chartFile，也不受
 * 打包/上传路径影响 —— 对"外部信息加载"来说这才是正确的锚点。
 *
 * blob: / data: 这类 opaque URL 没有可用的目录语义，返回 ''（调用方需另行处理，
 * 例如 zip 导入场景改从 idb 读取）。
 */
export function dirOfUrl(url: string | undefined | null): string {
  if (typeof url !== 'string') return '';
  const u = url.trim();
  if (!u || /^(?:blob|data):/i.test(u)) return '';
  const q = u.search(/[?#]/);
  const clean = q >= 0 ? u.slice(0, q) : u;
  const slash = clean.lastIndexOf('/');
  // slash <= 0：要么没有斜杠，要么只有开头的 `/`（根相对 `/x`）——后者没有目录部分。
  return slash > 0 ? clean.slice(0, slash) : '';
}

/** 允许直接透传的绝对地址前缀（已是可 fetch 地址，无需再拼 base）。 */
const ABSOLUTE_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** 归一化路径分隔符并去掉重复斜杠（保留协议里的 "//"）。 */
function normalizeSlashes(p: string): string {
  return p.replace(/([^:])\/{2,}/g, '$1/');
}

/**
 * 拼接"歌曲目录相对路径"。
 *
 * 规则：
 * 1. `relPath` 为空 / 非字符串 → 抛错（调用方应自行判定可选资源）。
 * 2. 绝对地址（`http(s):` / `blob:` / `idb:` / 协议相对 `//`）→ 原样透传。
 * 3. 前导 `./` 与 `/` 归一（`./a.json`、`/a.json` 都拼成 `<base>/a.json`）。
 * 4. 含 `..` 段的相对路径 → 抛错：故事板资源必须限制在歌曲目录内，
 *    避免 `../../..` 读到任意 URL（也避免手滑拼出坏地址后难以排查）。
 * 5. `base` 为空（无歌曲目录，典型是 zip 导入的本地库歌曲）→ 抛错，
 *    错误信息点明"该歌曲没有可用的目录基址"，让故事板能优雅降级。
 */
export function resolveAssetPath(relPath: string, base: string): string {
  if (typeof relPath !== 'string' || !relPath) {
    throw new Error('[storyboard.assets] 资源路径为空');
  }
  const rel = normalizeSlashes(relPath.trim());
  if (ABSOLUTE_RE.test(rel)) return rel;
  if (rel.split('/').some((seg) => seg === '..')) {
    throw new Error(`[storyboard.assets] 资源路径不得越出歌曲目录：${relPath}`);
  }
  const b = typeof base === 'string' ? normalizeSlashes(base.trim()) : '';
  if (!b) {
    throw new Error(
      '[storyboard.assets] 当前歌曲没有可用的目录基址（多为 zip 导入的本地库歌曲，' +
        '打包时不会收录约定外的额外文件），该资源不可用',
    );
  }
  return `${b.replace(/\/+$/, '')}/${rel.replace(/^\.?\/+/, '')}`;
}
