# Safe Streets NYC

A guided planner for deciding which New York City intersections to fix first so fewer people get hurt. It walks through six steps: who we protect, the most dangerous intersections, proven fixes with effect and cost, hard rules, an optimizer, and a comparison with simply fixing the worst first. The chosen plan can be downloaded as CSV or GeoJSON.

**Hosted app** (CARTO login required, shared with the organization):
https://workspace-gcp-us-east1.app.carto.com/app/safe-streets-munsif/

## Data

CARTO Data Warehouse (`carto_dw`, BigQuery), read live with two fixed SQL queries (`src/queries.ts`):

- `cartobq.docs.nyc_safety_sites`: intersections, with low-income, leading pedestrian interval (LPI) and turn-calming flags.
- `cartobq.docs.nyc_safety_site_year`: injuries by year, mode and severity per intersection.
- `cartobq.docs.nyc_safety_people_hurt`: every person hurt, used for the "who we protect" step.

Harm is measured over 2021-2025. Each intersection scores harm points per year: 1 per injury and 10 per serious injury or death (adjustable). Highway sites are excluded because these street fixes do not apply to them.

## Optimizer

A multiple-choice knapsack solved with HiGHS (WebAssembly, in a web worker): at most one fix per intersection, maximizing harm points avoided, subject to budget, crew-day capacity and a minimum share of spend in low-income areas (`src/lp.ts`). To keep the solve fast it considers the roughly 9,800 highest-value site-and-fix options out of about 59,000.

Result with the defaults ($3M budget, 200 crew-days, at least 40% of spend in low-income areas):

| | Optimizer | Fix worst first |
|---|---|---|
| Intersections fixed | 144 | 5 |
| Spend | $2.42M | $3.0M |
| People spared per year | about 45 | about 15 |
| Low-income share of spend | 46% | 100% |

Worst-first puts a $600k redesign on each of a few notorious intersections. The optimizer buys many cheaper fixes where they pay off most. Crew-days, not budget, was the binding limit.

## Assumptions

- **Fix effects, costs and crew-days are planning-grade estimates** based on published before/after studies (NYC DOT, FHWA). They are editable in the app. Replace them with local engineering estimates before committing funds.
  - Leading pedestrian interval: $10k, 1 crew-day, -13% pedestrian harm.
  - Daylighting and curb extension: $45k, 3 crew-days, -20% pedestrian and -10% cyclist harm.
  - Turn calming: $70k, 4 crew-days, -30% harm from turning vehicles hitting pedestrians.
  - Protected intersection redesign: $600k, 25 crew-days, -35% pedestrian, -35% cyclist, -15% motorist harm.
- Past crashes are assumed to repeat at the same rate.
- A site gets at most one fix. Sites that already have an LPI or turn calming cannot get it again.
- "Low-income" uses the flag in the sites table.

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
