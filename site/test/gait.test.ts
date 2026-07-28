import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';
import { GAIT, applyGait, gaitFor, paceDurationMs, paceEffort } from '../src/render/gait.js';

function makeHorse(): HTMLElement {
  const win = new Window();
  const el = win.document.createElement('div');
  el.className = 'horse';
  win.document.body.appendChild(el);
  return el as unknown as HTMLElement;
}

describe('paceEffort', () => {
  it('is 0 for no pace, zero, or nonsense', () => {
    expect(paceEffort(null)).toBe(0);
    expect(paceEffort(0)).toBe(0);
    expect(paceEffort(-500)).toBe(0);
    expect(paceEffort(NaN)).toBe(0);
    expect(paceEffort(Infinity)).toBe(0);
  });

  it('reaches full effort at the flat-out pace and clamps above it', () => {
    expect(paceEffort(GAIT.FLAT_OUT_PACE)).toBe(1);
    expect(paceEffort(GAIT.FLAT_OUT_PACE * 10)).toBe(1);
    // The server's rate cap (750 tok/s) must not overflow the range.
    expect(paceEffort(750 * 60)).toBe(1);
  });

  it('rises steeply at low pace so ordinary horses still differ', () => {
    // Square-rooted: a quarter of full effort is reached at 1/16th the pace.
    expect(paceEffort(GAIT.FLAT_OUT_PACE / 16)).toBeCloseTo(0.25, 5);
    expect(paceEffort(GAIT.FLAT_OUT_PACE / 4)).toBeCloseTo(0.5, 5);
    // A linear map would leave this horse at 0.0625; the curve gives it real signal.
    expect(paceEffort(375)).toBeGreaterThan(0.2);
  });

  it('is monotonic in pace', () => {
    let prev = -1;
    for (const p of [0, 10, 100, 500, 1000, 2000, 4000, 6000, 20000]) {
      const e = paceEffort(p);
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
  });
});

describe('paceDurationMs', () => {
  it('falls back to the original gait when pace is unknown', () => {
    expect(paceDurationMs(null)).toBe(GAIT.BASE_MS);
    expect(paceDurationMs(NaN)).toBe(GAIT.BASE_MS);
  });

  it('plods at zero pace and gallops flat out at the top', () => {
    expect(paceDurationMs(0)).toBe(GAIT.SLOW_MS);
    expect(paceDurationMs(GAIT.FLAT_OUT_PACE)).toBe(GAIT.FAST_MS);
    expect(paceDurationMs(GAIT.FLAT_OUT_PACE * 5)).toBe(GAIT.FAST_MS);
  });

  it('is faster (shorter cycle) the higher the pace', () => {
    const slow = paceDurationMs(100);
    const mid = paceDurationMs(1500);
    const fast = paceDurationMs(5000);
    expect(slow).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(fast);
  });

  it('never leaves the configured bounds', () => {
    for (const p of [0, 1, 50, 620, 1500, 6000, 45000, 1e9]) {
      const d = paceDurationMs(p);
      expect(d).toBeGreaterThanOrEqual(GAIT.FAST_MS);
      expect(d).toBeLessThanOrEqual(GAIT.SLOW_MS);
    }
  });
});

describe('gaitFor', () => {
  it('is stable for a given horse and pace, so polling does not re-roll it', () => {
    const a = gaitFor('horse-1', 1200);
    const b = gaitFor('horse-1', 1200);
    expect(a).toEqual(b);
  });

  it('gives different horses different phases', () => {
    const ids = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8'];
    const phases = ids.map((id) => gaitFor(id, 1000).phase);
    // Distinct, and spread rather than clustered at one end.
    expect(new Set(phases).size).toBe(ids.length);
    expect(Math.max(...phases) - Math.min(...phases)).toBeGreaterThan(0.4);
  });

  // Regression: FNV-1a without a finalizer left its high bits nearly unchanged
  // when only trailing characters differed, so a field of sequentially-named
  // horses stayed in near-lockstep (spread 0.06 across h1..h8).
  it('spreads phases for ids that differ only in the last character', () => {
    const phases = Array.from({ length: 8 }, (_, i) => gaitFor(`h${i + 1}`, 1000).phase);
    expect(Math.max(...phases) - Math.min(...phases)).toBeGreaterThan(0.5);
  });

  it('distributes phases roughly evenly across the cycle', () => {
    const deciles = new Array(10).fill(0);
    const n = 2000;
    for (let i = 0; i < n; i++) deciles[Math.floor(gaitFor(`horse-${i}`, 1000).phase * 10)]++;
    // A uniform hash puts n/10 in each; allow generous slack for hash noise but
    // still catch clustering into a few buckets.
    for (const count of deciles) {
      expect(count).toBeGreaterThan(n / 10 * 0.6);
      expect(count).toBeLessThan(n / 10 * 1.4);
    }
  });

  it('keeps every phase inside one cycle', () => {
    for (let i = 0; i < 500; i++) {
      const { phase } = gaitFor(`horse-${i}`, 800);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(1);
    }
  });

  it('spreads cycle length so equal-pace horses drift apart', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `horse-${i}`);
    const durations = ids.map((id) => gaitFor(id, 1500).durationMs);
    expect(new Set(durations).size).toBeGreaterThan(1);
    const base = paceDurationMs(1500);
    for (const d of durations) {
      expect(d).toBeGreaterThanOrEqual(Math.round(base * (1 - GAIT.SPREAD)) - 1);
      expect(d).toBeLessThanOrEqual(Math.round(base * (1 + GAIT.SPREAD)) + 1);
    }
  });

  it('still speeds a horse up when its pace rises', () => {
    const slow = gaitFor('horse-1', 100);
    const fast = gaitFor('horse-1', 5000);
    expect(fast.durationMs).toBeLessThan(slow.durationMs);
    // Same horse → same place in the stride, so a pace change does not snap it.
    expect(fast.phase).toBe(slow.phase);
  });
});

describe('applyGait', () => {
  it('writes both custom properties onto the element', () => {
    const el = makeHorse();
    applyGait(el, 'horse-1', 1500);
    const { durationMs, phase } = gaitFor('horse-1', 1500);
    expect(el.style.getPropertyValue('--gait-duration')).toBe(`${durationMs}ms`);
    expect(el.style.getPropertyValue('--gait-phase')).toBe(phase.toFixed(4));
  });

  it('writes a unitless phase, so the CSS calc multiplies cleanly', () => {
    const el = makeHorse();
    applyGait(el, 'horse-7', 900);
    const phase = el.style.getPropertyValue('--gait-phase');
    expect(phase).toMatch(/^\d\.\d{4}$/);
    expect(Number(phase)).toBeLessThan(1);
  });

  it('handles an unknown pace without emitting NaN', () => {
    const el = makeHorse();
    applyGait(el, 'horse-1', null);
    expect(el.style.getPropertyValue('--gait-duration')).not.toContain('NaN');
    expect(el.style.getPropertyValue('--gait-phase')).not.toContain('NaN');
  });

  it('gives two horses in the same field different clocks', () => {
    const a = makeHorse();
    const b = makeHorse();
    applyGait(a, 'alice-horse', 1500);
    applyGait(b, 'bob-horse', 1500);
    expect(a.style.getPropertyValue('--gait-phase'))
      .not.toBe(b.style.getPropertyValue('--gait-phase'));
  });
});
