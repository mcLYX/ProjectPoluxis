/**
 * 读取 Response 主体并上报下载进度。
 *
 * 为什么不用 `res.arrayBuffer()`：fetch 自身不提供下载进度事件，只有把 body 当
 * ReadableStream 逐块读才知道"已经下了多少"。谱面与音频下载共用它，让 UI 能显示
 * 「谱面 42%」/「音频 87%」这类阶段信息 —— 网络慢时能直接看出卡在哪一步。
 *
 * `total` 取自 Content-Length；没有这个头（chunked、或跨域未暴露）时为 0，此时
 * 只上报 `loaded`，调用方退化成"不带百分比的阶段文案"即可。
 *
 * 未传 `onProgress`（或环境不支持流式读取）时直接走 `res.arrayBuffer()`，与改动
 * 前的行为逐字节一致。返回值与 `res.arrayBuffer()` 等价（跨块拼接）。
 */
export type BodyProgress = (loaded: number, total: number) => void;

export async function readBodyWithProgress(
  res: Response,
  onProgress?: BodyProgress,
): Promise<ArrayBuffer> {
  const body = res.body;
  if (!onProgress || !body || typeof body.getReader !== 'function') {
    return res.arrayBuffer();
  }
  const total = Number(res.headers.get('content-length') ?? 0) || 0;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}
