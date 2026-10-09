/*
 * story-demo.js —— 故事板最小示例（§3.7，零依赖，纯 canvas 2D）
 *
 * 功能演示：
 *  - bg + overlay 双层挂载（bg 画星空节拍脉冲；overlay 画判定涟漪 + 连击计时文字）
 *  - api.game.style：Miss 时给游戏画面一次短暂"褪色"反馈（DOM 级白名单）
 *  - api.onJudge / onSeek / onPlayState / api.snapshot 的用法
 *
 * 使用：复制到歌曲目录改名 story.js（或由 update-beatmaps.mjs 自动扫描）。
 */

export default {
  create(api) {
    /* ---------- bg 层：星空 + 节拍脉冲 ---------- */
    const bg = api.mount('bg');
    const bgCanvas = document.createElement('canvas');
    bgCanvas.style.cssText = 'width:100%;height:100%;display:block;';
    bg.appendChild(bgCanvas);
    const bctx = bgCanvas.getContext('2d');

    // 固定随机星表（用种子，保证 seek 后画面确定）
    const stars = [];
    let seed = 42;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 140; i++) {
      stars.push({ x: rand(), y: rand(), r: 0.4 + rand() * 1.6, ph: rand() * Math.PI * 2 });
    }

    /* ---------- overlay 层：判定涟漪 ---------- */
    const ov = api.mount('overlay');
    const ovCanvas = document.createElement('canvas');
    ovCanvas.style.cssText = 'width:100%;height:100%;display:block;';
    ov.appendChild(ovCanvas);
    const octx = ovCanvas.getContext('2d');

    const ripples = []; // { x, y, t0, level }
    const LEVEL_COLOR = {
      'S-Perfect': 'rgba(94, 234, 212,', Perfect: 'rgba(56, 189, 248,',
      Good: 'rgba(250, 204, 21,', Miss: 'rgba(244, 63, 94,',
    };

    const offJudge = api.onJudge((e) => {
      // 判定面坐标 (±2.4/±1.5) → 屏幕像素：api.toScreen 用主相机实时投影，
      // 与音符的视觉落点对齐（分辨率/bloom/相机变化都正确）。
      const p = api.toScreen(e.x, e.y);
      ripples.push({ x: p.sx, y: p.sy, t0: e.timeSec, level: e.level });
      if (ripples.length > 24) ripples.shift();
      // Miss → 游戏画面短暂褪色（game.style 白名单；120ms 后恢复）
      if (e.level === 'Miss') {
        api.game.style({ filter: 'saturate(0.25) brightness(0.85)' });
        setTimeout(() => api.game.style({ filter: '' }), 120);
      }
    });

    const offSeek = api.onSeek(() => {
      // seek 后历史涟漪已无意义：绝对时间轴上 t0 失配 → 清掉即可
      ripples.length = 0;
    });

    let lastPlaying = null;
    const offPlay = api.onPlayState((p) => {
      if (lastPlaying === true && p.playing === false) {
        // 暂停：overlay 打上"暂停"水印（bg 保持最后一帧）
        // —— 这里只在 overlay 画一笔，update 每帧仍会重画，见下方 drawPause
      }
      lastPlaying = p.playing;
    });

    /* 重型初始化完成 → 通知宿主可以启动音频时钟（§3.7 规范要求，见 README）。
     * 本示例的初始化全为同步，故在此处调用；若故事板有异步预热（assets 预取、
     * 音频解码等），**必须**等异步准备真正完成后再调用 —— 否则音频时钟会提前起走，
     * 解码结束时谱面已行进到中段。漏调则每次加载都要等宿主的兜底超时。 */
    api.markReady();

    /* ---------- 每帧渲染（绝对时间确定函数）---------- */
    return {
      update(t, snap) {
        const bw = bgCanvas.clientWidth;
        const bh = bgCanvas.clientHeight;
        if (bgCanvas.width !== bw || bgCanvas.height !== bh) {
          bgCanvas.width = bw; bgCanvas.height = bh;
        }
        const ow = ovCanvas.clientWidth;
        const oh = ovCanvas.clientHeight;
        if (ovCanvas.width !== ow || ovCanvas.height !== oh) {
          ovCanvas.width = ow; ovCanvas.height = oh;
        }

        /* bg：黑底 + 闪烁星 + 每 0.5s 一次的呼吸脉冲 */
        bctx.fillStyle = '#04060c';
        bctx.fillRect(0, 0, bw, bh);
        const pulse = 0.5 + 0.5 * Math.sin((t % 0.5) / 0.5 * Math.PI * 2);
        for (const s of stars) {
          const tw = 0.55 + 0.45 * Math.sin(t * 1.7 + s.ph);
          bctx.beginPath();
          bctx.arc(s.x * bw, s.y * bh, s.r * (1 + pulse * 0.35), 0, Math.PI * 2);
          bctx.fillStyle = `rgba(148, 197, 255, ${0.28 * tw})`;
          bctx.fill();
        }

        /* overlay：判定涟漪（半径按 t - t0 展开；超出 0.6s 淘汰）+ 连击角标 */
        octx.clearRect(0, 0, ow, oh);
        for (let i = ripples.length - 1; i >= 0; i--) {
          const rp = ripples[i];
          const age = t - rp.t0;
          if (age < 0 || age > 0.6) { ripples.splice(i, 1); continue; }
          const k = age / 0.6;
          octx.beginPath();
          octx.arc(rp.x, rp.y, 8 + k * 46, 0, Math.PI * 2);
          octx.strokeStyle = (LEVEL_COLOR[rp.level] || 'rgba(255,255,255,') + (1 - k) + ')';
          octx.lineWidth = 2.5 * (1 - k) + 0.5;
          octx.stroke();
        }
        if (snap.combo >= 2) {
          // 右侧垂直居中偏上：避开底部判定条与顶部成绩 HUD（z-10 会盖过 overlay）
          octx.font = '600 15px Rajdhani, sans-serif';
          octx.textAlign = 'right';
          const label = `COMBO ${snap.combo}`;
          const tw = octx.measureText(label).width;
          const cy = Math.round(oh * 0.42);
          octx.fillStyle = 'rgba(4, 8, 16, 0.55)';
          octx.fillRect(ow - tw - 28, cy - 16, tw + 14, 23);
          octx.fillStyle = 'rgba(255,255,255,0.9)';
          octx.fillText(label, ow - 14, cy + 1);
        }
        if (snap.paused) {
          octx.font = '700 22px Rajdhani, sans-serif';
          octx.fillStyle = 'rgba(255,255,255,0.5)';
          octx.textAlign = 'center';
          octx.fillText('— PAUSED —', ow / 2, oh / 2);
        }
      },

      dispose() {
        offJudge();
        offSeek();
        offPlay();
        bgCanvas.remove();
        ovCanvas.remove();
        // 容器本身由宿主移除；WebGL 场景需要在此释放资源（本示例为 2D canvas 无需）。
      },
    };
  },
};
