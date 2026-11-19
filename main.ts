// gta6-trophy-rarity-forecast-01 — Phase 1 skeleton forecaster.
//
// Forecasts each GTA VI (PS5) trophy's earn rate on Exophase at a
// case's target time, as five quantiles per trophy. This skeleton
// uses the house-baseline shape: the median holds the trophy's rate
// from the case's last read (persistence), and the spread widens
// like a random walk on the logit scale with horizon:
//
//   q_tau = 100 * sigmoid(logit(r) + z_tau * sigma * sqrt(days))
//
// where r is the last-read rate in percent, days is
// horizon_minutes / 1440, sigma is 0.5 logit units per
// square-root day, and z_tau is the standard normal quantile at
// each scored level. Phase 2 replaces the median/spread core with
// a real forecaster; the I/O and output contract below stay.
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

interface TrophySpec {
  id: number;
}

interface Read {
  rates: Array<number | null>;
}

interface TrophyCase {
  levels: number[];
  horizon_minutes: number;
  trophies: TrophySpec[];
  history: Read[];
}

interface ForecastRow {
  id: number;
  q: number[];
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
 * The five quantiles for one trophy: persistence median from its
 * last-read rate, spread widening with the horizon's square root.
 * A null rate means the read lacked the trophy; count it as 0%.
 */
function quantilesForRate(lastRate: number | null, horizonDays: number): number[] {
  const centre = logitOf(lastRate ?? 0);
  const spread = SIGMA_PER_SQRT_DAY * Math.sqrt(horizonDays);
  return Z_SCORES.map((z) => round4(invLogit(centre + z * spread)));
}

/** Forecast every trophy of one parsed case. */
function forecastCase(c: TrophyCase, fileName: string): ForecastRow[] {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${fileName} asks for levels ${JSON.stringify(c.levels)}, expected ${JSON.stringify(LEVELS)}`);
  }
  const lastRead = c.history[c.history.length - 1];
  if (lastRead === undefined) {
    throw new Error(`${fileName} has no history`);
  }
  const horizonDays = c.horizon_minutes / MINUTES_PER_DAY;
  return c.trophies.map((t, i) => ({
    id: t.id,
    q: quantilesForRate(lastRead.rates[i] ?? null, horizonDays),
  }));
}

mkdirSync(OUTPUT_DIR, { recursive: true });

// Every case file, sorted by name, so two runs write identical bytes.
const caseFiles = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of caseFiles) {
  const caseId = file.slice(0, -'.in'.length);
  const parsed = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as TrophyCase;
  const rows = forecastCase(parsed, file);
  writeFileSync(join(OUTPUT_DIR, `${caseId}.out`), `${JSON.stringify({ trophies: rows })}\n`);
}
