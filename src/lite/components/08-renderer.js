/* === 5. Renderer — full perspective projection (mirrors Three.js camera) === */
  var canvas = document.getElementById('game-canvas');
  var ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  var view = { w: 0, h: 0, aspect: 1, cd: 4.96, dpr: 1, pxPerUnit: 0 };

  function fitCameraDistance(aspect) {
    var dV = FIT_HALF / TAN_HALF_FOV;
    var dH = FIT_HALF / (TAN_HALF_FOV * Math.max(aspect, 0.2));
    return Math.max(dV, dH, 4.4);
  }
  function resize() {
    var w = canvas.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || window.innerHeight;
    view.dpr = 1;
    view.w = w; view.h = h; view.aspect = w / h;
    view.cd = fitCameraDistance(view.aspect);
    view.pxPerUnit = h / (2 * TAN_HALF_FOV * view.cd); /* world→px at z=0 */
    /* IE11 canvas backing-store leak: assigning canvas.width/height allocates a
     * NEW bitmap and discards the old one, but IE11's GPU compositor does NOT
     * promptly reclaim the discarded bitmap. On IE11 tablets, resize/orientation
     * changes (and touch-scroll-induced layout jitter) fire repeatedly during
     * play, so the canvas bitmap gets re-allocated over and over → GPU/compositor
     * memory grows without bound → gameplay steadily slows down, worse with
     * multi-touch, and survives a normal page refresh (same GPU process). Only
     * fix is a new tab / browser restart. Guard the assignment so the bitmap is
     * only (re)allocated when the pixel size actually changes. */
    var newW = Math.round(w * view.dpr), newH = Math.round(h * view.dpr);
    if (canvas.width !== newW || canvas.height !== newH) {
      canvas.width = newW;
      canvas.height = newH;
      ctx.imageSmoothingEnabled = false;
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    }
  }
  window.addEventListener('resize', resize);

  /* Project world (nx,ny,nz) → screen {x,y,scale,alpha} or null if culled.
   * Mirrors the full version's PerspectiveCamera math exactly. */
  function project(nx, ny, nz, spawnLimit) {
    if (nz < spawnLimit) return null;
    var depth = view.cd - nz;
    if (depth <= 0.1) return null; /* at/behind camera */
    var ndcX = nx / (TAN_HALF_FOV * view.aspect * depth);
    var ndcY = (ny - CAMERA_AXIS_Y) / (TAN_HALF_FOV * depth);
    var sx = view.w * 0.5 * (1 + ndcX);
    var sy = view.h * 0.5 * (1 - ndcY);
    var scale = view.cd / depth;
    var alpha = Math.max(0, Math.min(1, (nz - spawnLimit) / FADE_ZONE));
    return { x: sx, y: sy, scale: scale, alpha: alpha };
  }

  /* Draw a tap note (square outline + 0.94 filled plane). Mirrors mkTap. */
  function drawTap(p, color, vScale, angle) {
    var size = TAP_SIZE * view.pxPerUnit * p.scale * vScale;
    if (size < 2) return;
    ctx.save();
    ctx.translate(p.x, p.y);
    /* Rotate the square by its angle. +angle = clockwise (screen y is down),
     * consistent with the 2D editor and the 3D view. */
    if (angle) ctx.rotate(angle * Math.PI / 180);
    ctx.globalAlpha = p.alpha * 0.18;
    ctx.fillStyle = color;
    ctx.fillRect(-size * 0.47, -size * 0.47, size * 0.94, size * 0.94);
    ctx.globalAlpha = p.alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(-size / 2, -size / 2, size, size);
    ctx.restore();
  }
  /* Draw a touch note (filled disc + outline). Mirrors mkTouch (32 seg).
   * Touch notes ignore rotation (a rotated circle looks identical), so `angle`
   * is intentionally not applied here. */
  function drawTouch(p, color, vScale, angle) {
    var r = (TOUCH_SIZE / 2) * view.pxPerUnit * p.scale * vScale;
    if (r < 1) return;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.92, 0, Math.PI * 2);
    ctx.globalAlpha = p.alpha * 0.22;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = p.alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
  /* Draw a slide node (45° diamond). Mirrors mkSlide diamondPts. */
  function drawSlideNode(p, color, vScale, isHead, angle) {
    var half = SLIDE_HALF * view.pxPerUnit * p.scale * vScale;
    if (half < 1) return;
    ctx.save();
    ctx.translate(p.x, p.y);
    if (angle) ctx.rotate(angle * Math.PI / 180);
    ctx.beginPath();
    ctx.moveTo(0, -half);
    ctx.lineTo(half, 0);
    ctx.lineTo(0, half);
    ctx.lineTo(-half, 0);
    ctx.closePath();
    ctx.globalAlpha = p.alpha * 0.2;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = p.alpha;
    ctx.strokeStyle = color;
    /* Head 2px / child 1px: the 2D pipe is a single flat ribbon, so child
     * nodes need a thin outline to read as connected (3D is a solid mesh and
     * needs none). */
    ctx.lineWidth = isHead ? 2 : 1;
    ctx.stroke();
    ctx.restore();
  }
  /* Draw a slide pipe segment between two projected points as a tapered ribbon.
   * Width at each end follows perspective scale → narrower where farther, wider
   * where nearer — this creates a 3D "pipe in perspective" look that a flat
   * constant-width line cannot. Edges are outlined for definition.
   * `brightness` scales fill/stroke opacity: 1.0=normal, ~2.3=held (brighter).
   * Mirrors the full version's placeDiamondPipe diamond cross-section + holding
   * opacity boost (GameCanvas.tsx L1226-1230).
   *
   * PER-END ALPHA (fixes "pipe vanishes when next node is off-screen"):
   *   alphaA/alphaB are independent. When the next node is beyond the far render
   *   plane it is clamped to spawnLimit → alphaB becomes 0. Using a single min()
   *   alpha made the whole pipe invisible in that case. Instead we build a
   *   linear gradient from pA→pB so the pipe stays visible at the in-view end
   *   and fades smoothly toward the clamped (far-plane) end — matching how the
   *   full version's per-vertex alpha behaves on the 3D mesh. */
  function drawPipe(pA, pB, color, alphaA, alphaB, maxScale, brightness, vScale) {
    if (!pA || !pB) return;
    brightness = brightness || 1.0;
    var dx = pB.x - pA.x, dy = pB.y - pA.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.5) return;
    /* Perpendicular unit vector (screen space) */
    var nx = -dy / len, ny = dx / len;
    /* Half-width at each end, perspective-scaled (narrower when farther). */
    var hwA = Math.max(1.5, SLIDE_PIPE_HALF * view.pxPerUnit * pA.scale * vScale);
    var hwB = Math.max(1.5, SLIDE_PIPE_HALF * view.pxPerUnit * pB.scale * vScale);
    /* Parse #rrggbb → rgb components for gradient color stops. All slide pipe
     * colors in this build are 7-char hex (SLIDE_RED + chart noteColor). */
    var cr = parseInt(color.substr(1, 2), 16);
    var cg = parseInt(color.substr(3, 2), 16);
    var cb = parseInt(color.substr(5, 2), 16);
    /* Opacity bands (per user spec "整体透明程度调低一些/更不透明"):
     *   fill 0.22 → 0.45 (ribbon body), stroke 0.55 → 0.6 (edge definition).
     *   brightness still scales these (held ≈2.3× → capped at 1.0 by Math.min). */
    var fillA = Math.min(1, alphaA * 0.45 * brightness);
    var fillB = Math.min(1, alphaB * 0.45 * brightness);
    var strA = Math.min(1, alphaA * 0.6 * brightness);
    var strB = Math.min(1, alphaB * 0.6 * brightness);
    ctx.save();
    /* Filled ribbon (semi-transparent, gives body) — gradient fill so the
     * ribbon fades independently at each end. */
    var fillGrad = ctx.createLinearGradient(pA.x, pA.y, pB.x, pB.y);
    fillGrad.addColorStop(0, 'rgba(' + cr + ',' + cg + ',' + cb + ',' + fillA + ')');
    fillGrad.addColorStop(1, 'rgba(' + cr + ',' + cg + ',' + cb + ',' + fillB + ')');
    ctx.fillStyle = fillGrad;
    ctx.beginPath();
    ctx.moveTo(pA.x + nx * hwA, pA.y + ny * hwA);
    ctx.lineTo(pB.x + nx * hwB, pB.y + ny * hwB);
    ctx.lineTo(pB.x - nx * hwB, pB.y - ny * hwB);
    ctx.lineTo(pA.x - nx * hwA, pA.y - ny * hwA);
    ctx.closePath();
    ctx.fill();
    /* Edge outlines (define the pipe shape, brighter) — separate gradient so
     * the stroke can use a higher opacity band than the fill. */
    var strGrad = ctx.createLinearGradient(pA.x, pA.y, pB.x, pB.y);
    strGrad.addColorStop(0, 'rgba(' + cr + ',' + cg + ',' + cb + ',' + strA + ')');
    strGrad.addColorStop(1, 'rgba(' + cr + ',' + cg + ',' + cb + ',' + strB + ')');
    ctx.strokeStyle = strGrad;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pA.x + nx * hwA, pA.y + ny * hwA);
    ctx.lineTo(pB.x + nx * hwB, pB.y + ny * hwB);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pA.x - nx * hwA, pA.y - ny * hwA);
    ctx.lineTo(pB.x - nx * hwB, pB.y - ny * hwB);
    ctx.stroke();
    ctx.restore();
  }
  /* Draw a slide pipe as a tapered RIBBON following an arbitrary polyline
   * (a sampled *eased* curve), instead of a single straight segment.
   * `samples` = ordered projected points {x,y,scale,alpha} from the consumed
   * edge (playhead) to node B. Each point's half-width is perspective-scaled;
   * the ribbon is built from left/right offset edges (perpendicular to the
   * local tangent) and filled/stroked with a per-vertex alpha gradient so it
   * fades at the far end — mirroring the straight-pipe version's look under a
   * 2D canvas. This is the 2D equivalent of the full version's curved tube
   * centreline (GameCanvas.buildSlideTubeGeometry: x/y follow ease(τ) while z
   * advances linearly with τ). */
  function drawPipeCurve(samples, color, brightness, vScale) {
    if (!samples || samples.length < 2) return;
    brightness = brightness || 1.0;
    var cr = parseInt(color.substr(1, 2), 16);
    var cg = parseInt(color.substr(3, 2), 16);
    var cb = parseInt(color.substr(5, 2), 16);
    var n = samples.length;
    var hw = [];
    for (var i = 0; i < n; i++) {
      hw.push(Math.max(1.5, SLIDE_PIPE_HALF * view.pxPerUnit * samples[i].scale * vScale));
    }
    var left = [], right = [];
    for (var i = 0; i < n; i++) {
      var pa = samples[Math.max(0, i - 1)], pb = samples[Math.min(n - 1, i + 1)];
      var tx = pb.x - pa.x, ty = pb.y - pa.y;
      var tl = Math.sqrt(tx * tx + ty * ty) || 1;
      var nx = -ty / tl, ny = tx / tl;
      left.push({ x: samples[i].x + nx * hw[i], y: samples[i].y + ny * hw[i] });
      right.push({ x: samples[i].x - nx * hw[i], y: samples[i].y - ny * hw[i] });
    }
    ctx.save();
    /* When the ribbon collapses to a near-zero-length (pipe nearly consumed),
     * samples[0]≈samples[n-1] and createLinearGradient() becomes a DEGENERATE
     * (zero-length) gradient — some browsers then render it as fully transparent
     * or fully opaque and flip between frames → the whole pipe "twinkles". Guard
     * by falling back to a solid fill/stroke in that case. */
    var gDegenerate = (Math.abs(samples[n - 1].x - samples[0].x) < 0.5 &&
                       Math.abs(samples[n - 1].y - samples[0].y) < 0.5);
    /* Filled ribbon body (per-vertex alpha gradient along the polyline). */
    if (gDegenerate) {
      ctx.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' +
        Math.min(1, samples[Math.floor(n / 2)].alpha * 0.45 * brightness) + ')';
    } else {
      var fillGrad = ctx.createLinearGradient(samples[0].x, samples[0].y, samples[n - 1].x, samples[n - 1].y);
      for (var k = 0; k < n; k++) {
        var fa = Math.min(1, samples[k].alpha * 0.45 * brightness);
        fillGrad.addColorStop(k / (n - 1), 'rgba(' + cr + ',' + cg + ',' + cb + ',' + fa + ')');
      }
      ctx.fillStyle = fillGrad;
    }
    ctx.beginPath();
    ctx.moveTo(left[0].x, left[0].y);
    for (var i = 1; i < n; i++) ctx.lineTo(left[i].x, left[i].y);
    for (var i = n - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
    ctx.closePath();
    ctx.fill();
    /* Edge outlines (brighter, separate gradient). */
    if (gDegenerate) {
      ctx.strokeStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' +
        Math.min(1, samples[Math.floor(n / 2)].alpha * 0.6 * brightness) + ')';
    } else {
      var strGrad = ctx.createLinearGradient(samples[0].x, samples[0].y, samples[n - 1].x, samples[n - 1].y);
      for (var k = 0; k < n; k++) {
        var sa = Math.min(1, samples[k].alpha * 0.6 * brightness);
        strGrad.addColorStop(k / (n - 1), 'rgba(' + cr + ',' + cg + ',' + cb + ',' + sa + ')');
      }
      ctx.strokeStyle = strGrad;
    }
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (var i = 0; i < n; i++) { if (i === 0) ctx.moveTo(left[i].x, left[i].y); else ctx.lineTo(left[i].x, left[i].y); }
    ctx.stroke();
    ctx.beginPath();
    for (var i = 0; i < n; i++) { if (i === 0) ctx.moveTo(right[i].x, right[i].y); else ctx.lineTo(right[i].x, right[i].y); }
    ctx.stroke();
    ctx.restore();
  }
  /* Draw a pipe cap — a filled (no wireframe) semi-transparent diamond at a
   * projected point. Used at judge-plane cross-sections to make the cut pipe
   * look like it has a solid 3D end, not a flat edge. */
  function drawPipeCap(p, color, alpha, scale, vScale) {
    if (!p) return;
    var half = Math.max(1.5, SLIDE_HALF * view.pxPerUnit * scale * vScale);
    ctx.save();
    ctx.globalAlpha = Math.min(1, alpha * 0.35);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - half);
    ctx.lineTo(p.x + half, p.y);
    ctx.lineTo(p.x, p.y + half);
    ctx.lineTo(p.x - half, p.y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  /* Judge plane border (white rectangle at z=0). */
  function drawJudgePlane() {
    var corners = [
      project(-PLANE_HALF_X, -PLANE_HALF_Y, 0, -1000),
      project( PLANE_HALF_X, -PLANE_HALF_Y, 0, -1000),
      project( PLANE_HALF_X,  PLANE_HALF_Y, 0, -1000),
      project(-PLANE_HALF_X,  PLANE_HALF_Y, 0, -1000)
    ];
    if (!corners[0]) return;
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (var i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
  /* Tunnel: 4 perspective lines from far (z=-spawnLimit) converging to plane corners. */
  function drawTunnel(spawnLimit) {
    var farZ = spawnLimit;
    var corners = [
      [-PLANE_HALF_X, -PLANE_HALF_Y], [ PLANE_HALF_X, -PLANE_HALF_Y],
      [ PLANE_HALF_X,  PLANE_HALF_Y], [-PLANE_HALF_X,  PLANE_HALF_Y]
    ];
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = Theme.accent(); /* mirrors gridColor in GameCanvas L671 */
    ctx.lineWidth = 1;
    for (var i = 0; i < 4; i++) {
      var near = project(corners[i][0], corners[i][1], 0, -1000);
      var far = project(corners[i][0], corners[i][1], farZ, -100000);
      if (!near || !far) continue;
      ctx.beginPath();
      ctx.moveTo(far.x, far.y);
      ctx.lineTo(near.x, near.y);
      ctx.stroke();
    }
    ctx.restore();
  }
  /* Background gradient from chart bgScheme. */
  function drawBackground(chart) {
    var bg = chart.metadata.bgScheme;
    var g = ctx.createLinearGradient(0, 0, 0, view.h);
    g.addColorStop(0, bg.gradientStart);
    g.addColorStop(1, bg.gradientEnd);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, view.w, view.h);
  }
