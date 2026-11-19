// gta6-trophy-rarity-forecast-01 — Phase 2 forecaster.
//
// Forecasts each GTA VI (PS5) trophy's earn rate on Exophase at a
// case's target time, as five quantiles per trophy. The median
// blends two views of each trophy's rate:
//
//   * a logit trend: least squares of logit(rate) against
//     ln(1 + hours since release) over the recent reads, slope
//     shrunk toward the tier mean and toward zero when thin;
//   * a dilution model: earned counts (rate x players, which
//     only grow) projected forward and divided by projected
//     players_tracked, whose log-linear growth carries a prior
//     (doubling per day, decaying with observed growth) so a
//     flat history still dilutes over a multi-day horizon.
//
// The spread combines a random-walk term (sigma 0.5 per
// square-root day), trend/residual uncertainty, and a
// refresh-jump term: Exophase refreshes hours apart, so a flat
// history gets a floor wide enough to cover a launch-night-scale
// refresh, while a history with jumps uses their observed size.
//
// Degenerate inputs degrade instead of crashing: an empty
// history, a zero horizon, or an unparseable case still yields
// a valid forecast (neutral and wide, or anchored at the last
// rate), and one bad case never aborts the run.
//
// Node 22, standard library only, no network, deterministic.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The quantile levels the contest scores, in row order.
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
// Standard normal quantiles at those levels.
const Z_SCORES = [-1.645, -0.674, 0, 0.674, 1.645];
// Random-walk spread, in logit units per square-root day.
const SIGMA_PER_SQRT_DAY = 0.5;
// Minutes in a day; converts a case's horizon to days.
const MINUTES_PER_DAY = 1440;
// Milliseconds in an hour.
const MS_PER_HOUR = 3_600_000;
// Release instant the trend clock runs from (RULES: the curve
// baseline's ln(1 + hours since 2026-11-19T00:00:00Z)).
const RELEASE_MS = Date.parse('2026-11-19T00:00:00Z');
// Trend and growth fits use the recent reads only; with fewer
// than 3 in the window, all reads are used instead.
const RECENT_WINDOW_MS = 24 * MS_PER_HOUR;
// Prior player growth when history shows none: players double
// per day, decaying with observed growth evidence (launch week).
const PRIOR_GROWTH_PER_HOUR = Math.LN2 / 24;
// Sanity caps on fitted hourly log-growth rates.
const MAX_PLAYER_GROWTH_PER_HOUR = Math.LN2 / 12;
const MAX_EARNED_GROWTH_PER_HOUR = 0.06;
// Refresh-jump spread, in logit units: the floor when history
// is flat (no jump ever seen), and the bounds when jumps are
// observed. A flat history must still cover a launch-night-scale
// refresh: the one the rules document took players 638 -> 3,868
// (a 6x jump), dropping most rates by 1.1-1.8 logit, so the flat
// floor sits at 0.9, putting the 5% quantile ~1.5 logit below
// the median. A history with jumps is more informative, so its
// observed size caps lower.
const REFRESH_FLOOR_FLAT = 0.9;
const REFRESH_MIN = 0.15;
const REFRESH_MAX = 0.8;
// Slope shrinkage: a trophy's own slope gets weight n/(n+k),
// the rest goes to its tier's mean slope.
const SHRINK_K = 3;
// Blend weight on the trend median vs the dilution median.
const TREND_WEIGHT = 0.5;
// Trend uncertainty when a trophy has too few points to fit.
const THIN_TREND_UNC = 0.3;
// Cap on the trend/residual uncertainty term.
const MAX_TREND_UNC = 1.0;
// Neutral forecast for a case with no usable history (or a
// non-finite median/spread): median 50% with a wide spread, so
// the case still emits valid output instead of crashing.
const NEUTRAL_SIGMA = 2.0;

interface TrophySpec {
  id: number;
  tier: string;
}

interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}

interface TrophyCase {
  levels: number[];
  horizon_minutes: number;
  target: string;
  trophies: TrophySpec[];
  history: Read[];
}

interface ForecastRow {
  id: number;
  q: number[];
}

/** Hours from release to an ISO timestamp (never negative). */
function hoursSinceRelease(iso: string): number {
  return Math.max(0, (Date.parse(iso) - RELEASE_MS) / MS_PER_HOUR);
}

/** The trend clock: ln(1 + hours since release). */
function logTime(iso: string): number {
  return Math.log1p(hoursSinceRelease(iso));
}

interface Fit {
  intercept: number;
  slope: number;
  residStd: number;
  n: number;
  xbar: number;
  sxx: number;
}

/** Ordinary least squares of ys on xs (n >= 1; slope 0 if degenerate). */
function ols(xs: number[], ys: number[]): Fit {
  const n = xs.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const xbar = sx / n;
  const ybar = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xbar;
    sxx += dx * dx;
    sxy += dx * (ys[i] - ybar);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = ybar - slope * xbar;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (intercept + slope * xs[i]);
    sse += r * r;
  }
  const residStd = n > 2 ? Math.sqrt(sse / (n - 2)) : 0;
  return { intercept, slope, residStd, n, xbar, sxx };
}

/** Median of a non-empty array (the input is left untouched). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Clamp a percent into the range the scorer's logit is defined on. */
function clampRate(pct: number): number {
  return Math.min(99.99, Math.max(0.01, pct));
}

/** Logit of a percent (0..100), clamped first like the scorer does. */
function logitOf(pct: number): number {
  const p = clampRate(pct) / 100;
  return Math.log(p / (1 - p));
}

/** Inverse logit, back to a percent. */
function invLogit(x: number): number {
  return 100 / (1 + Math.exp(-x));
}

/** Round to 4 decimals, the precision the output format uses. */
function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

/**
 * The five quantiles for one trophy from its median logit and
 * total logit spread. Rounding is applied last; monotonicity is
 * enforced afterwards so equal neighbours stay non-decreasing.
 */
function quantilesFrom(medianLogit: number, sigma: number): number[] {
  // A non-finite median or spread (bad timestamps, absurd
  // horizons) must never reach the output as null: fall back
  // to the neutral forecast.
  if (!Number.isFinite(medianLogit) || !Number.isFinite(sigma)) {
    return quantilesFrom(0, NEUTRAL_SIGMA);
  }
  const qs = Z_SCORES.map((z) => round4(invLogit(medianLogit + z * sigma)));
  for (let i = 1; i < qs.length; i++) {
    if (qs[i] < qs[i - 1]) qs[i] = qs[i - 1];
  }
  return qs;
}

/** Forecast every trophy of one parsed case. */
function forecastCase(c: TrophyCase, fileName: string): ForecastRow[] {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${fileName} asks for levels ${JSON.stringify(c.levels)}, expected ${JSON.stringify(LEVELS)}`);
  }
  const history = c.history ?? [];
  const lastRead = history[history.length - 1];
  if (lastRead === undefined) {
    // No history at all: a crash would invalidate the whole
    // case, so emit a neutral, wide forecast instead.
    return c.trophies.map((t) => ({ id: t.id, q: quantilesFrom(0, NEUTRAL_SIGMA) }));
  }
  // A negative or missing horizon is meaningless; clamp it so
  // the square-root terms below stay finite.
  const horizonMinutes = Number.isFinite(c.horizon_minutes) ? Math.max(0, c.horizon_minutes) : 0;
  const horizonDays = horizonMinutes / MINUTES_PER_DAY;
  const horizonHours = horizonMinutes / 60;
  // At a zero horizon the target is the checkpoint itself, so
  // uncertainty terms that need time to act (refresh jumps,
  // trend extrapolation) vanish; the median is the last rate.
  const spreadGate = horizonDays > 0 ? 1 : 0;
  const xTarget = logTime(c.target);
  const lastAtMs = Date.parse(lastRead.at);
  const windowStartMs = lastAtMs - RECENT_WINDOW_MS;
  let window = history.filter((r) => Date.parse(r.at) >= windowStartMs);
  if (window.length < 3) window = history;

  // --- Player growth: log-linear fit over the recent reads. ---
  const playerFit = ols(
    window.map((r) => hoursSinceRelease(r.at)),
    window.map((r) => Math.log(Math.max(1, r.players_tracked))),
  );
  const firstPlayers = Math.max(1, history[0].players_tracked);
  const lastPlayers = Math.max(1, lastRead.players_tracked);
  const observedGrowth = Math.log(lastPlayers / firstPlayers);
  // Prior growth decays as observed growth evidence accumulates.
  const priorGrowth = PRIOR_GROWTH_PER_HOUR / (1 + Math.max(0, observedGrowth));
  const growthPerHour = Math.min(
    MAX_PLAYER_GROWTH_PER_HOUR,
    Math.max(0, playerFit.slope, priorGrowth),
  );
  const playersTarget = lastPlayers * Math.exp(growthPerHour * horizonHours);

  // --- Refresh jumps: the typical biggest single-read logit move. ---
  const maxJumps: number[] = [];
  for (let i = 0; i < c.trophies.length; i++) {
    let prev: number | null = null;
    let maxJump = 0;
    for (const r of history) {
      const rate = r.rates[i] ?? null;
      if (rate === null) continue;
      if (prev !== null) {
        maxJump = Math.max(maxJump, Math.abs(logitOf(rate) - logitOf(prev)));
      }
      prev = rate;
    }
    if (prev !== null) maxJumps.push(maxJump);
  }
  const pooledJump = maxJumps.length > 0 ? median(maxJumps) : 0;
  const refreshSigma = pooledJump > 0.02
    ? Math.min(REFRESH_MAX, Math.max(REFRESH_MIN, pooledJump))
    : REFRESH_FLOOR_FLAT;

  // --- First pass: per-trophy trend fits and tier mean slopes. ---
  interface TrendFit {
    fit: Fit | null;
    lastRate: number;
    xLast: number;
  }
  const trends: TrendFit[] = c.trophies.map((_, i) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const r of window) {
      const rate = r.rates[i] ?? null;
      if (rate !== null) {
        xs.push(logTime(r.at));
        ys.push(logitOf(rate));
      }
    }
    let lastRate = 0;
    let xLast = logTime(lastRead.at);
    for (let j = history.length - 1; j >= 0; j--) {
      const rate = history[j].rates[i] ?? null;
      if (rate !== null) {
        lastRate = rate;
        xLast = logTime(history[j].at);
        break;
      }
    }
    return { fit: xs.length >= 2 ? ols(xs, ys) : null, lastRate, xLast };
  });
  const tierSlopes = new Map<string, number[]>();
  c.trophies.forEach((t, i) => {
    const f = trends[i].fit;
    if (f !== null && f.sxx > 0) {
      const list = tierSlopes.get(t.tier) ?? [];
      list.push(f.slope);
      tierSlopes.set(t.tier, list);
    }
  });
  const tierMean = new Map<string, number>();
  for (const [tier, slopes] of tierSlopes) {
    tierMean.set(tier, slopes.reduce((a, b) => a + b, 0) / slopes.length);
  }

  // --- Second pass: median (trend + dilution blend) and spread. ---
  const randomWalk = SIGMA_PER_SQRT_DAY * Math.sqrt(horizonDays);
  return c.trophies.map((t, i) => {
    const trend = trends[i];
    const f = trend.fit;

    // Trend median, anchored at the last observed rate so a
    // shrunk slope cannot drift the level away from the data.
    let slope = 0;
    let trendUnc = THIN_TREND_UNC;
    if (f !== null && f.sxx > 0) {
      const w = f.n / (f.n + SHRINK_K);
      const shrunk = w * f.slope + (1 - w) * (tierMean.get(t.tier) ?? 0);
      // Soft-shrink toward zero when the slope is poorly pinned.
      const se = f.residStd / Math.sqrt(f.sxx);
      slope = Math.abs(shrunk) + se > 0 ? shrunk * (Math.abs(shrunk) / (Math.abs(shrunk) + se)) : 0;
      const leverage = ((xTarget - f.xbar) * (xTarget - f.xbar)) / f.sxx;
      trendUnc = Math.min(MAX_TREND_UNC, f.residStd * Math.sqrt(1 + leverage));
    } else if (f !== null) {
      trendUnc = 0; // Points exist but share one time: no trend info.
    }
    const trendLogit = logitOf(trend.lastRate) + slope * (xTarget - trend.xLast);

    // Dilution median: earned counts only grow, so project them
    // forward (log-linear, floored at zero growth) and divide by
    // projected players.
    const exs: number[] = [];
    const eys: number[] = [];
    for (const r of window) {
      const rate = r.rates[i] ?? null;
      if (rate !== null) {
        const earned = (rate / 100) * Math.max(1, r.players_tracked);
        exs.push(hoursSinceRelease(r.at));
        eys.push(Math.log(Math.max(0.5, earned)));
      }
    }
    const earnedFit = exs.length >= 2 ? ols(exs, eys) : null;
    // Earned counts only grow. The floor says newcomers earn
    // the trophy at its current rate, so a trophy everyone
    // holds (100%) has its earned count track players exactly
    // and its rate stays put, while a rare trophy barely gains
    // from newcomers and dilutes almost fully.
    const newcomerFloor = growthPerHour * (trend.lastRate / 100);
    const earnedGrowth = earnedFit !== null && earnedFit.sxx > 0
      ? Math.min(MAX_EARNED_GROWTH_PER_HOUR, Math.max(newcomerFloor, earnedFit.slope))
      : Math.min(MAX_EARNED_GROWTH_PER_HOUR, newcomerFloor);
    const earnedLast = Math.max(0.5, (trend.lastRate / 100) * lastPlayers);
    const earnedTarget = earnedLast * Math.exp(earnedGrowth * horizonHours);
    const dilutionLogit = logitOf((100 * earnedTarget) / playersTarget);

    const medianLogit = TREND_WEIGHT * trendLogit + (1 - TREND_WEIGHT) * dilutionLogit;
    const sigma = Math.sqrt(
      randomWalk * randomWalk +
      (spreadGate * trendUnc) ** 2 +
      (spreadGate * refreshSigma) ** 2,
    );
    return { id: t.id, q: quantilesFrom(medianLogit, sigma) };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });

// Every case file, sorted by name, so two runs write identical bytes.
const caseFiles = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of caseFiles) {
  const caseId = file.slice(0, -'.in'.length);
  let parsed: TrophyCase | null = null;
  try {
    parsed = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as TrophyCase;
    const rows = forecastCase(parsed, file);
    writeFileSync(join(OUTPUT_DIR, `${caseId}.out`), `${JSON.stringify({ trophies: rows })}\n`);
  } catch {
    // One bad case must not abort the whole run: fall back to a
    // neutral forecast when the trophy list survived parsing.
    // (If even parsing failed there is nothing valid to emit.)
    if (parsed !== null && Array.isArray(parsed.trophies)) {
      const rows = parsed.trophies.map((t) => ({ id: t.id, q: quantilesFrom(0, NEUTRAL_SIGMA) }));
      writeFileSync(join(OUTPUT_DIR, `${caseId}.out`), `${JSON.stringify({ trophies: rows })}\n`);
    }
  }
}
