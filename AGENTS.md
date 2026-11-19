# AGENTS.md — gta6-trophy-rarity-forecast-01

## What this entry is

A make.fun bounty entry ("Forecast how many GTA VI players earn each
trophy in week one", competition `gta6-trophy-rarity-forecast-01`).
The program forecasts, for every PlayStation 5 trophy of Grand Theft
Auto VI, its earn rate on Exophase at a target time, as five quantiles
(0.05, 0.25, 0.5, 0.75, 0.95) per trophy. The final case forecasts
2026-11-26T00:00:00Z from reads cut at the deadline
2026-11-21T11:30:00Z. Score is mean pinball loss on the logit scale;
a prize needs a loss strictly below the best house entry's.

## Program contract

- Entry point: `node main.ts` (Node 22, standard library only) at the
  repo root. TypeScript only — there is no `main.py`, and there must
  never be both.
- Reads every `*.in` file in `$MAKEFUN_INPUT_DIR` (else `/input`), in
  name order. Each case is JSON schema
  `makefun/gta6-trophies-case/v1`: `id`, `at`, `horizon_minutes`,
  `target`, `levels` `[0.05,0.25,0.5,0.75,0.95]`, `trophies` (in id
  order), `history` (valid reads before `at`, oldest first, each with
  `rates` in trophy order, `null` where a read lacked the trophy).
- Writes one file per case to `$MAKEFUN_OUTPUT_DIR` (else `/output`):
  `/output/<id>.out`, a regular file of at most 65,536 bytes of UTF-8
  JSON: exactly `{"trophies":[{"id":n,"q":[q05,q25,q50,q75,q95]}]}` —
  one row per trophy, each id once, each row exactly the keys `id`
  and `q`, five finite numbers from 0 to 100, non-decreasing.
- No network, no installed dependencies, deterministic (two runs of
  the same case must be byte-identical), at most 8 seconds per case,
  1 CPU, 1024 MB. Seed any randomness; prefer none at all.
- Scoring clamps rates to 0.01..99.99 before the logit. A missing or
  invalid output is scored as if every quantile equalled the trophy's
  rate in the case's last read, and an entry with any invalid case
  ranks below every fully-valid entry and takes no prize.

## Build and test

```sh
# Run on the kit's practice cases (kit lives outside this repo; read-only):
mkdir -p /tmp/forecast-out
MAKEFUN_INPUT_DIR=~/bounties/gta6-trophy-rarity-forecast-01-kit/gta6-trophy-rarity-forecast-01-kit/input \
MAKEFUN_OUTPUT_DIR=/tmp/forecast-out \
node main.ts
```

Verify after every change to `main.ts`:

- `p00.out` and `p01.out` exist, parse as JSON, hold exactly 55 rows,
  each row exactly `{"id","q"}` with 5 non-decreasing finite numbers
  in 0..100, each file at most 65,536 bytes.
- Runtime well under 8 s per case.
- Two runs produce byte-identical output (`diff` the two runs).
- Never commit test output: keep it in `/tmp`, not in the repo.

## Rules for working in this repo

- Write code with the write/edit tools; never copy, clone, or `cp`
  starter or kit files into this repo. The entry's code must be
  authored in agent sessions (the transcript gate counts only code
  the sessions wrote).
- Do not submit anything from this repo without the coordinator's
  explicit go-ahead, and never create a sealed recording for this
  competition — it uses a transcript bundle, not a recording.
- Keep `main.ts` the only entry point. Keep the output contract
  above intact: any model change must still emit valid rows for
  every trophy in every case, including edge cases (empty history
  is an error; `null` rates mean the trophy was absent from that
  read — treat as 0% before clamping).
- No secrets in this repo, in any commit, in any encoding.
