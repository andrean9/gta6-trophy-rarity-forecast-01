[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/andrean9/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/andrean9/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

# gta6-trophy-rarity-forecast-01

Forecast how many GTA VI players earn each trophy in week one: for
every PlayStation 5 trophy of Grand Theft Auto VI, this program
forecasts its earn rate on Exophase at the case's target time, as
five quantiles (0.05, 0.25, 0.5, 0.75, 0.95) per trophy. It reads a
case's history of Exophase reads and writes one forecast file per
case. Scored by mean pinball loss on the logit scale; a prize needs
a loss strictly below the best house entry's.

Phase 2 is a real forecaster. Each trophy's median blends a
logit trend (least squares of logit(rate) against ln(1 + hours
since release) over the recent reads, slope shrunk toward the
tier mean and toward zero when thin) with a dilution model
(earned counts projected forward and divided by projected
players_tracked, whose growth carries a launch-week prior when
history is flat). The spread combines a random-walk term
(sigma 0.5 per square-root day), trend/residual uncertainty,
and a refresh-jump term with a floor wide enough to cover a
launch-night-scale Exophase refresh when history is flat.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=~/bounties/gta6-trophy-rarity-forecast-01-kit/gta6-trophy-rarity-forecast-01-kit/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only, no network. The program reads every
`*.in` case in `$MAKEFUN_INPUT_DIR` (else `/input`) and writes
`/output/<id>.out` per case: `{"trophies":[{"id":n,"q":[q05,q25,q50,q75,q95]}]}`,
one row per trophy, five finite numbers 0..100, non-decreasing.

<sub>Entered on [make.fun](https://make.fun/?ref=66rnv3bx&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
