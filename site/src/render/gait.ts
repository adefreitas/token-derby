// Every horse used to share one hardcoded 0.4s gait, so a full field galloped in
// lockstep — legs, body bob and dust all on the same beat, which reads as one
// sprite copied N times (the same problem the crowd had; see crowd.ts).
//
// Two things break the lockstep here:
//   * the cycle length tracks the horse's token pace, so a horse producing more
//     tokens/min visibly gallops harder;
//   * a per-horse phase offset and a small cycle-length spread, both derived from
//     the horse id, put equal-pace horses out of step and let them drift apart.
//
// Deriving both from the id rather than Math.random keeps a horse's gait stable
// across polls and re-renders — a re-roll every poll would show up as the whole
// field snapping to a new stride.

export const GAIT = {
  /** Cycle length at zero pace — a plod. */
  SLOW_MS: 620,
  /** Cycle length at or above FLAT_OUT_PACE — full gallop. */
  FAST_MS: 240,
  /** Cycle length when pace is unknown (pending races, or live with no series
   *  data yet). Matches the original hand-tuned gait, so those look unchanged. */
  BASE_MS: 400,
  /** Tokens/min at which the legs reach FAST_MS. Well under the server's
   *  750 tok/s rate cap: that ceiling is anti-abuse, not a pace anyone holds. */
  FLAT_OUT_PACE: 6_000,
  /** ± fraction applied to the cycle length per horse, so two horses on the same
   *  pace still drift apart instead of holding a fixed offset forever. */
  SPREAD: 0.08,
} as const;

/**
 * MurmurHash3's 32-bit finalizer. FNV-1a alone leaves its high bits barely moved
 * when only the trailing characters differ, and `frac` below reads exactly those
 * bits — ids like "horse-1".."horse-8" came out within 0.06 of each other, which
 * would have left a field of sequentially-named horses still in near-lockstep.
 * This avalanches a single-bit change across the whole word.
 */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** FNV-1a + finalizer. Seeded so one id can yield several independent fractions. */
function hash32(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return fmix32(h);
}

const FNV_OFFSET = 0x811c9dc5;
const SPREAD_SEED = 0x9e3779b9;

/** Maps a hash to [0, 1). */
function frac(h: number): number {
  return h / 0x1_0000_0000;
}

/**
 * Effort in [0, 1] for a token pace. Square-rooted rather than linear because
 * pace spans several orders of magnitude: most horses sit in the low hundreds,
 * so a linear map would leave nearly the whole field at the slow end and spend
 * its range on paces almost nobody reaches.
 */
export function paceEffort(pace: number | null): number {
  if (pace === null || !Number.isFinite(pace) || pace <= 0) return 0;
  return Math.min(1, Math.sqrt(pace / GAIT.FLAT_OUT_PACE));
}

/** Cycle length in ms for a pace, before the per-horse spread. */
export function paceDurationMs(pace: number | null): number {
  if (pace === null || !Number.isFinite(pace)) return GAIT.BASE_MS;
  const effort = paceEffort(pace);
  return GAIT.SLOW_MS - effort * (GAIT.SLOW_MS - GAIT.FAST_MS);
}

export type Gait = {
  /** Cycle length in ms — shared by the legs, the body bob and the dust. */
  durationMs: number;
  /** Start offset as a fraction of the cycle, in [0, 1). Held as a fraction (not
   *  a fixed ms delay) so a pace change rescales it and the horse keeps its place
   *  in the stride instead of snapping. */
  phase: number;
};

export function gaitFor(horseId: string, pace: number | null): Gait {
  const spread = 1 + GAIT.SPREAD * (2 * frac(hash32(horseId, SPREAD_SEED)) - 1);
  return {
    durationMs: Math.round(paceDurationMs(pace) * spread),
    phase: frac(hash32(horseId, FNV_OFFSET)),
  };
}

/** Writes the gait onto the `.horse` wrapper; the legs inherit both vars. */
export function applyGait(el: HTMLElement, horseId: string, pace: number | null): void {
  const { durationMs, phase } = gaitFor(horseId, pace);
  el.style.setProperty('--gait-duration', `${durationMs}ms`);
  el.style.setProperty('--gait-phase', `${phase.toFixed(4)}`);
}
