# Safe Streets NYC

A guided planner for deciding which New York City intersections to fix first so fewer people get hurt. It walks through six steps: who we protect, the most dangerous intersections, proven fixes with effect and cost, hard rules, an optimizer, and a comparison with simply fixing the worst first. The chosen plan can be downloaded as CSV or GeoJSON.

**Hosted app** (CARTO login required, shared with the organization):
https://workspace-gcp-us-east1.app.carto.com/app/safe-streets-munsif/

See [`DECISIONS.md`](DECISIONS.md) for how the app works and the reasoning behind every modeling decision.

## Key findings

Default run: $3M budget, 200 crew-days, at least 40% of spend in low-income areas, serious injury or death weighted 10x. Impacts are estimates from the assumptions below, not measured outcomes.

| | Optimizer | Fix worst first |
|---|---|---|
| Intersections fixed | 144 | 5 |
| Spend | $2.42M | $3.00M |
| Crew-days used (of 200) | 200 | 125 |
| Harm points avoided per year | 132 | 27.5 |
| People spared per year | about 45 | about 15 |
| Low-income share of spend | 44% | 80% |
| Fixes chosen | 116 leading pedestrian intervals, 28 daylighting | 5 full redesigns |

- **The optimizer spares about 3x as many people** with less money. Worst-first sends the whole budget to five $600k redesigns at the most notorious intersections. The optimizer favors cheap fixes (mostly leading pedestrian intervals) across many intersections. It never picked a full redesign or turn calming at these costs and effect sizes.
- **Crew capacity limited the optimizer, not money.** It used all 200 crew-days but left about $580k unspent. With 400 crew-days it spends $2.995M on 247 fixes and spares about 59 people per year.
- **The low-income rule was not binding.** The optimizer reached 44% low-income spend on its own, above the 40% minimum. Raising the minimum to 70% costs little: about 5% fewer harm points avoided (126 vs. 132, from 130 fixes costing $2.53M), and slightly more people spared (about 47), because low-income areas have many cheap, effective fixes.
- **Worst-first met the low-income rule by coincidence.** Four of its five sites are in low-income areas (80% of spend) and the fifth is not. That is not a result of design; the method ignores the rule.
- **Unknown income is not counted as low-income.** Intersections with no income data are treated as unknown and excluded from the low-income count (see Assumptions). This lowered the optimizer's low-income share from 46% to 44% and worst-first's from 100% to 80%, and left the other numbers essentially unchanged.
- **Harm is concentrated.** Canarsie, Mott Haven-Port Morris, South Ozone Park and Jamaica have the most harm points per year, but the optimizer places only 1 to 4 fixes in each, because many cheap fixes elsewhere pay off more.

## Data

CARTO Data Warehouse (`carto_dw`, BigQuery), read live with two fixed SQL queries (`src/queries.ts`):

- `cartobq.docs.nyc_safety_sites`: intersections, with low-income, leading pedestrian interval (LPI) and turn-calming flags.
- `cartobq.docs.nyc_safety_site_year`: injuries by year, mode and severity per intersection.
- `cartobq.docs.nyc_safety_people_hurt`: every person hurt, used for the "who we protect" step.
- `cartobq.docs.nyc_signal_nta`: neighborhood (NTA) boundaries, used to group intersections for the neighborhood chart.

Harm is measured over 2021-2025. Each intersection scores harm points per year: 1 per injury and 10 per serious injury or death (adjustable). Highway sites are excluded because these street fixes do not apply to them.

## Optimizer

A multiple-choice knapsack solved with HiGHS (WebAssembly, in a web worker): at most one fix per intersection, maximizing harm points avoided, subject to budget, crew-day capacity and a minimum share of spend in low-income areas (`src/lp.ts`). To keep the solve fast it considers the roughly 9,800 highest-value site-and-fix options out of about 59,000.

Results with the default settings are under Key findings.

## Assumptions

**Fix effects, costs and crew-days are my planning-grade estimates, not official figures.** They are based on published before/after studies (NYC DOT Vision Zero, FHWA) and are editable in the app. Replace them with local engineering estimates before committing funds.

| Fix | Cost | Crew-days | Assumed effect |
|---|---|---|---|
| Leading pedestrian interval (LPI) | $10k | 1 | -13% pedestrian harm |
| Daylighting + curb extension | $45k | 3 | -20% pedestrian, -10% cyclist harm |
| Turn calming | $70k | 4 | -30% harm from turning vehicles hitting pedestrians |
| Protected intersection redesign | $600k | 25 | -35% pedestrian, -35% cyclist, -15% motorist harm |

Other assumptions:
- **Harm score:** 2021-2025 crashes, 1 point per injury and 10 per serious injury or death (adjustable). Averaged per year.
- **Past repeats:** crashes are assumed to continue at the 2021-2025 rate. Effects are applied as simple percentage reductions with no interaction between fixes.
- **One fix per site.** Sites that already have an LPI or turn calming cannot get it again.
- **Highways excluded:** these street-level fixes do not apply to them.
- **Low-income** uses the flag in the sites table. The rule is a minimum share of dollars spent, not of sites. The source table flags all 728 intersections in the app that have no income data as low-income. This app overrides that: no income data means unknown, and unknown is not counted as low-income (7,498 low-income sites remain). See `DECISIONS.md` (D11).
- **Crew-days** are a single pooled capacity. Crew type, location and scheduling are not modeled.
- **Neighborhoods** come from the NTA boundaries in `nyc_signal_nta`. A few intersections fall outside every boundary and are left out of the neighborhood chart.
- **Optimizer shortcut:** it considers about 9,800 of the roughly 59,000 possible site-and-fix options (the highest-value ones overall plus the top low-income ones). The solve is within 0.2% of optimal for that set.

## Data snapshot (`data/`)

A frozen copy of every result the app queries from CARTO, exported on 2026-10-20, so the app can be rebuilt later without CARTO. The app does not read these files yet. Each CSV has exactly the columns the query returns (booleans as `true`/`false`).

| File | Rows | App query (`src/queries.ts`) | Source tables |
|---|---|---|---|
| `data/sites_by_intersection.csv` | 26,067 | `SITES_SQL`: one row per non-highway intersection with harm in 2021-2025: location, flags (`low_income` is false when income is unknown; `income_known` says which), and injury counts by mode (`ped`, `cyc`, `mot`) split into injured and serious-or-killed (`_sk`), plus `ped_turning` | `nyc_safety_sites`, `nyc_safety_site_year` |
| `data/people_hurt_by_year_mode.csv` | 237 | `PEOPLE_SQL`: people hurt counted by year, mode, severity and whether a vehicle was turning | `nyc_safety_people_hurt` |
| `data/site_neighborhood.csv` | 35,607 | `NTA_SQL`: neighborhood (`nta`, `nta_name`) of each non-highway intersection, by spatial join | `nyc_safety_sites`, `nyc_signal_nta` |

To go CARTO-free, load these in place of the `query()` calls in `index.ts` (same column names), for example by importing them as static files. All source tables are in `cartobq.docs`.

## Run locally

```bash
cp .env.example .env   # add a scoped CARTO API access token
npm install
npm run dev
```

The token needs the `sql` API and a grant for exactly the two queries in `src/queries.ts`, with allowed origins that include `http://localhost:5173/*`. Create one with `carto credentials create token`. Never commit `.env`.

## Deploy

```bash
npm run build
carto app deploy dist --name "Safe Streets NYC" --slug safe-streets-munsif
```

The API token is baked into the built bundle, so `dist/` is not committed. The token is read-only, limited to those two queries, and restricted to the hosted app origin and localhost.
