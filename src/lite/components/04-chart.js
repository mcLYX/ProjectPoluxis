/* === 3. Core logic (ported verbatim from src/utils/*.ts to ES5) === */
  function beatToSeconds(beat, bpm, offset) { return offset + (beat * 60) / bpm; }

  /* Multi-BPM support: convert beat to seconds using bpmlist.
   * Mirrors beatToSecondsMultiBpm in src/utils/beatTime.ts. */
  function beatToSecondsMultiBpm(beat, baseBpm, offset, bpmlist) {
    if (!bpmlist || bpmlist.length === 0) return beatToSeconds(beat, baseBpm, offset);
    var currentBeat = 0;
    var currentBpm = baseBpm;
    var acc = 0;
    for (var i = 0; i < bpmlist.length; i++) {
      var p = bpmlist[i];
      if (p.beat <= 0) continue;
      if (p.beat >= beat) break;
      acc += ((p.beat - currentBeat) * 60) / currentBpm;
      currentBeat = p.beat;
      currentBpm = p.bpm;
    }
    acc += ((beat - currentBeat) * 60) / currentBpm;
    return offset + acc;
  }

  function resolveChart(chart) {
    var bpm = chart.metadata.bpm, offset = chart.metadata.offset || 0;
    var bpmlist = chart.metadata.bpmlist || null;
    var out = [];
    function validEasing(v) { return EASING_TYPES.indexOf(v) >= 0 ? v : null; }
    function nodeTimeSec(beat) { return beatToSecondsMultiBpm(beat, bpm, offset, bpmlist); }
    for (var i = 0; i < chart.notes.length; i++) {
      var n = chart.notes[i];
      var headAngle = (typeof n.angle === 'number') ? n.angle : 0;
      var headEasing = validEasing(n.easing) || 'linear';
      var head = {
        id: n.id, beat: n.beat, x: n.x, y: n.y, type: n.type, color: n.color,
        timeSec: nodeTimeSec(n.beat),
        angle: headAngle, easing: headEasing,
        nodes: undefined, resolvedNodes: undefined, isSlide: false
      };
      if (n.type === 'slide' && n.nodes && n.nodes.length) {
        /* Slide: one head + children kept as a chain (pipe rendered between them).
         * Children inherit the head's angle/easing when they don't specify their own. */
        var kids = [];
        for (var k = 0; k < n.nodes.length; k++) {
          var sn = n.nodes[k];
          kids.push({
            beat: sn.beat, x: sn.x, y: sn.y, timeSec: nodeTimeSec(sn.beat),
            angle: (typeof sn.angle === 'number') ? sn.angle : headAngle,
            easing: validEasing(sn.easing) || headEasing
          });
        }
        head.isSlide = true;
        head.resolvedNodes = kids;
        out.push(head);
      } else if (n.nodes && n.nodes.length) {
        /* Tap/Touch with child nodes: per the full spec each child is an
         * INDEPENDENT note of the SAME type (inheriting angle/easing from head).
         * Expand into the head plus one note per child node. */
        out.push(head);
        var childNodes = n.nodes.slice().sort(function (a, b) { return (a.beat || 0) - (b.beat || 0); });
        for (var c = 0; c < childNodes.length; c++) {
          var cn = childNodes[c];
          out.push({
            id: n.id + '#' + c, beat: cn.beat, x: cn.x, y: cn.y, type: n.type, color: n.color,
            timeSec: nodeTimeSec(cn.beat),
            angle: (typeof cn.angle === 'number') ? cn.angle : headAngle,
            easing: validEasing(cn.easing) || headEasing,
            nodes: undefined, resolvedNodes: undefined, isSlide: false
          });
        }
      } else {
        out.push(head);
      }
    }
    out.sort(function (a, b) { return a.timeSec - b.timeSec; });
    return out;
  }

  /* Get the time of the earliest note (including slide child nodes).
   * Mirrors getFirstNoteTime in src/utils/beatTime.ts. */
  function getFirstNoteTime(chart) {
    if (!chart.notes || chart.notes.length === 0) return 0;
    var bpm = chart.metadata.bpm, offset = chart.metadata.offset || 0;
    var bpmlist = chart.metadata.bpmlist || null;
    var minBeat = Infinity;
    for (var i = 0; i < chart.notes.length; i++) {
      var n = chart.notes[i];
      if (n.beat < minBeat) minBeat = n.beat;
      if (n.type === 'slide' && n.nodes) {
        for (var k = 0; k < n.nodes.length; k++) {
          if (n.nodes[k].beat < minBeat) minBeat = n.nodes[k].beat;
        }
      }
    }
    return beatToSecondsMultiBpm(minBeat, bpm, offset, bpmlist);
  }

  /* Resolve events from beat-based to absolute seconds.
   * Mirrors resolveEvents in src/utils/beatTime.ts. */
  function resolveEvents(chart) {
    var bpm = chart.metadata.bpm, offset = chart.metadata.offset || 0;
    var bpmlist = chart.metadata.bpmlist || null;
    if (!chart.events || chart.events.length === 0) {
      /* Legacy speedEvents migration */
      if (chart.speedEvents && chart.speedEvents.length > 0) {
        var legacy = [];
        for (var li = 0; li < chart.speedEvents.length; li++) {
          var se = chart.speedEvents[li];
          legacy.push({
            id: 'legacy-speed-' + li,
            type: 'event',
            eventType: 'speed_change',
            beat: se.beat,
            speed: se.speed,
            timeSec: beatToSecondsMultiBpm(se.beat, bpm, offset, bpmlist)
          });
        }
        legacy.sort(function (a, b) { return a.timeSec - b.timeSec; });
        return legacy;
      }
      return [];
    }
    var resolved = [];
    for (var ei = 0; ei < chart.events.length; ei++) {
      var e = chart.events[ei];
      var re = {};
      for (var ek in e) { if (e.hasOwnProperty(ek)) re[ek] = e[ek]; }
      re.timeSec = beatToSecondsMultiBpm(e.beat, bpm, offset, bpmlist);
      resolved.push(re);
    }
    resolved.sort(function (a, b) { return a.timeSec - b.timeSec; });
    return resolved;
  }

  /* Pre-compute scroll speed change points for note position calculation.
   * Mirrors extractSpeedPoints + getScrollDistance in src/utils/beatTime.ts. */
  function extractSpeedPoints(events) {
    var points = [];
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.eventType === 'speed_change' && typeof e.speed === 'number') {
        points.push({ timeSec: e.timeSec, speed: e.speed });
      }
    }
    points.sort(function (a, b) { return a.timeSec - b.timeSec; });
    return points;
  }
  function getScrollDistance(timeSec, speedPoints) {
    if (!speedPoints || speedPoints.length === 0) return timeSec;
    var dist = 0;
    var curTime = 0;
    var curSpeed = 1;
    for (var i = 0; i < speedPoints.length; i++) {
      var p = speedPoints[i];
      if (p.timeSec <= 0) { curSpeed = p.speed; continue; }
      if (p.timeSec >= timeSec) break;
      dist += (p.timeSec - curTime) * curSpeed;
      curTime = p.timeSec;
      curSpeed = p.speed;
    }
    dist += (timeSec - curTime) * curSpeed;
    return dist;
  }
  function countPlayableNotes(chart) {
    var t = 0;
    for (var i = 0; i < chart.notes.length; i++) {
      var n = chart.notes[i];
      t += 1 + ((n.nodes && n.nodes.length) ? n.nodes.length : 0);
    }
    return t;
  }
  function evaluateJudgement(deltaTMs) {
    var a = Math.abs(deltaTMs);
    if (a < JUDGE_THRESH.S_PERFECT) return 'S-Perfect';
    if (a < JUDGE_THRESH.PERFECT) return 'Perfect';
    if (a < JUDGE_THRESH.GOOD) return 'Good';
    return null;
  }
  /* Per-note score — mirrors calculateNoteScore in src/utils/scoring.ts.
   * baseUnit = 10M / totalNotes. S-Perfect = baseUnit + 1, Perfect = baseUnit,
   * Good = baseUnit * 0.5, Miss = 0. */
  function calculateNoteScore(j, total) {
    if (total <= 0) return 0;
    var base = SCORE_BASE / total;
    if (j === 'S-Perfect') return base + 1;
    if (j === 'Perfect') return base;
    if (j === 'Good') return base * 0.5;
    return 0;
  }
  function calculateRank(score) {
    if (score >= RANK_THRESHOLDS.EX_PLUS) return 'EX+';
    if (score >= RANK_THRESHOLDS.EX) return 'EX';
    if (score >= RANK_THRESHOLDS.S) return 'S';
    if (score >= RANK_THRESHOLDS.A) return 'A';
    if (score >= RANK_THRESHOLDS.B) return 'B';
    if (score >= RANK_THRESHOLDS.C) return 'C';
    return 'F';
  }
