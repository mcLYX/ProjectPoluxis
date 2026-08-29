/**
 * Waveform peak extraction for the 2D editor's audio-waveform overlay.
 *
 * Peaks are precomputed ONCE per decoded AudioBuffer and cached in a WeakMap
 * (so they are released together with the buffer). The editor's draw loop then
 * only performs array lookups, which keeps its per-frame cost independent of
 * the song's length.
 */

/** Peak buckets per second of audio (2.5 ms each). */
const PEAKS_PER_SECOND = 400;

/** Samples actually examined per bucket while building the peaks. A bucket
 *  holds sampleRate/PEAKS_PER_SECOND samples (~110 @ 44.1 kHz); scanning all of
 *  them turns the one-time build into a multi-hundred-millisecond stall on long
 *  tracks, whereas a spread sample of ~16 already yields a visually faithful
 *  envelope at this temporal resolution. */
const SCAN_SAMPLES_PER_BUCKET = 16;

export interface WaveformPeaks {
  /** Peak amplitude per bucket, normalised to 0..1, in chronological order. */
  readonly peaks: Float32Array;
  /** Audio seconds covered by one bucket. */
  readonly secPerBucket: number;
  /** Total audio duration in seconds. */
  readonly duration: number;
}

const cache = new WeakMap<AudioBuffer, WaveformPeaks>();

/** Peaks for `buffer`, built on first use and memoised afterwards. */
export function getWaveformPeaks(buffer: AudioBuffer): WaveformPeaks {
  const hit = cache.get(buffer);
  if (hit) return hit;
  const built = buildPeaks(buffer);
  cache.set(buffer, built);
  return built;
}

function buildPeaks(buffer: AudioBuffer): WaveformPeaks {
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const bucketSamples = Math.max(1, Math.round(sampleRate / PEAKS_PER_SECOND));
  const stride = Math.max(1, Math.floor(bucketSamples / SCAN_SAMPLES_PER_BUCKET));
  const bucketCount = Math.max(1, Math.ceil(length / bucketSamples));
  const peaks = new Float32Array(bucketCount);

  const channelCount = buffer.numberOfChannels;
  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) channels.push(buffer.getChannelData(c));

  for (let b = 0; b < bucketCount; b++) {
    const start = b * bucketSamples;
    const end = Math.min(length, start + bucketSamples);
    let peak = 0;
    // Peak across ALL channels: a mono down-mix would cancel out-of-phase
    // material and understate the visible amplitude.
    for (let c = 0; c < channelCount; c++) {
      const data = channels[c];
      for (let i = start; i < end; i += stride) {
        const v = data[i];
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
    }
    peaks[b] = peak > 1 ? 1 : peak;
  }

  return { peaks, secPerBucket: bucketSamples / sampleRate, duration: buffer.duration };
}

/** Peak amplitude inside [fromSec, toSec], in AUDIO-BUFFER seconds.
 *  Returns 0 for ranges that fall outside the buffer. Always covers at least
 *  one bucket, so a sub-bucket range still resolves to a sensible value. */
export function peakInRange(p: WaveformPeaks, fromSec: number, toSec: number): number {
  if (toSec <= 0 || fromSec >= p.duration) return 0;
  const lo = fromSec > 0 ? fromSec : 0;
  const hi = toSec < p.duration ? toSec : p.duration;
  let i0 = Math.floor(lo / p.secPerBucket);
  let i1 = Math.ceil(hi / p.secPerBucket);
  if (i1 <= i0) i1 = i0 + 1;
  if (i0 < 0) i0 = 0;
  if (i1 > p.peaks.length) i1 = p.peaks.length;
  let peak = 0;
  for (let i = i0; i < i1; i++) {
    const v = p.peaks[i];
    if (v > peak) peak = v;
  }
  return peak;
}
