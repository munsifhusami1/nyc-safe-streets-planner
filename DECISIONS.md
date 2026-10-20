# How this app works, and why

Plain-language notes on what the app does and every choice behind it. For each decision: what I chose, why, what else I could have done, and where it lives in the code. Where a choice is an assumption of mine rather than something from your data or instructions, it says so.

## What the app is

A six-step guide that helps decide which New York City intersections to fix first so fewer people get hurt. You see who is hurt, where it is most dangerous, what fixes exist and what they cost, the rules you must obey (budget, crew time, a minimum share of spend in low-income areas), and then an optimizer picks the plan. It compares that plan with simply fixing the most dangerous intersections first, and lets you download the result.

In one sentence: **score every intersection by how much harm it sees, estimate how much each fix would cut, then choose the combination of fixes that avoids the most harm without breaking the rules.**

## How the pieces fit

1. The browser asks CARTO three fixed questions (SQL queries) about the crash data and gets back plain tables of numbers.
2. All the scoring, optimizing and charting happens in the browser. CARTO is only a data source.
3. The map is drawn with deck.gl on a CARTO basemap.
4. The optimizer (HiGHS, a mathematical solver compiled to WebAssembly) runs in a background thread so the page stays responsive.

| Piece | File |
|---|---|
| Page, six steps, charts, map, downloads | `index.ts` |
| Scoring, fixes, baseline plan, option pruning | `src/model.ts` |
| Optimizer model (the math) | `src/lp.ts` |
| Background worker that runs the solver | `src/solver.worker.ts` |
| The three data queries | `src/queries.ts` |
| Look and feel | `style.css`, `index.html` |
| Frozen copy of the data | `data/*.csv` |

---

## Data decisions

### D1. Three fixed queries, results processed in the browser
- **What:** the app runs three SQL queries (`SITES_SQL`, `PEOPLE_SQL`, `NTA_SQL` in `src/queries.ts`) and does everything else itself.
- **Why:** the optimizer needs every candidate intersection at once, and the sliders (budget, weights, effects) must respond instantly. Fetching map tiles or re-querying on every change would be slow and could not feed an optimizer.
- **Alternatives:** (a) draw the map from CARTO tile sources and compute elsewhere; (b) run the analysis as a CARTO Workflow and have the app read its output table. CARTO's own guidance prefers (b) for heavy analysis. I chose the browser because the whole point is trying different rules interactively.
- **Cost:** the sites query returns about 8 MB, so first load takes a few seconds.
- **Code:** `src/queries.ts`; loading at the bottom of `index.ts` ("boot").

### D2. Only crashes from 2021 to 2025 count
- **What:** harm per intersection is totaled over five full years and divided by five.
- **Why:** 2026 is a partial year, so including it would understate harm. In the data I inspected, two fields appear empty for early years: serious injuries and turning-vehicle crashes were zero in 2012. I only checked 2012 directly, so I did not verify exactly when they start; a recent window avoids the problem either way. Recent years also better reflect today's streets and signals.
- **Alternatives:** use all years 2012-2025 (more data, but older conditions and missing fields); use 3 years (more current, but noisier).
- **Code:** `WHERE y.year BETWEEN 2021 AND 2025` in `SITES_SQL`; `YEARS = 5` in `src/model.ts`.

### D3. Highway intersections are left out
- **What:** sites flagged `highway` are excluded.
- **Why:** leading pedestrian intervals, daylighting and similar street fixes do not apply to highway interchanges. Including them would let the optimizer propose impossible fixes.
- **Alternative:** keep them and give them a separate fix list. I had no data on highway fixes.
- **Code:** `WHERE NOT s.highway` in `SITES_SQL` and `NTA_SQL`.

### D4. Neighborhoods come from the NTA boundaries
- **What:** the safety tables only have borough, so each intersection is matched to the neighborhood polygon (NTA) that contains it, using a spatial join in SQL.
- **Why:** you told me to use `nyc_signal_nta` if the safety data had no neighborhoods.
- **Result:** 35,607 of 35,637 non-highway intersections match; 6 of the intersections with harm fall outside every boundary and are left out of the neighborhood chart.
- **Alternative:** group by borough only (coarser).
- **Code:** `NTA_SQL`; chart in `ntaChart()` in `index.ts`.

---

## Scoring decisions

### D5. "Harm points": 1 per injury, 10 per serious injury or death
- **What:** each intersection's score is injuries plus ten times (serious injuries + deaths), per year. The weight of 10 is a slider.
- **Why:** a death or serious injury is far worse than a minor one, and plain counts would hide that. Serious injuries and deaths share one weight because the data only separates them in the raw tables, and treating them as one "severe" bucket keeps the model simple.
- **This is my assumption.** Transport agencies use different weights; some count deaths much higher than serious injuries.
- **Alternatives:** raw injury counts (ignores severity); separate weights for serious and fatal; "killed or seriously injured" only.
- **Code:** `siteHarm()` in `src/model.ts`; the weight slider in `stepRules()`.

### D6. The optimizer maximizes harm points avoided; the app also reports people spared
- **What:** the objective is harm points avoided per year. "People spared per year" uses the same fix effects but counts every person as 1, and is shown beside it.
- **Why:** harm points reflect severity; head counts are easier to explain. Showing both keeps the result honest. They can disagree: with a 70% low-income minimum, harm points avoided fell slightly while people spared rose slightly.
- **Code:** `benefit` and `people` in `buildOptions()` in `src/model.ts`.

---

## Fix decisions

### D7. Four fixes, with effects, costs and crew-days that I estimated
- **What:** leading pedestrian interval (a walk signal that starts before turning traffic is released), daylighting with a curb extension, turn calming, and a full protected-intersection redesign.
- **Why four:** they span cheap-and-small to expensive-and-large, which is what makes the budget trade-off interesting. They are common, well-known Vision Zero tools.
- **You did not give me these numbers.** They are my planning-grade estimates based on the range of published before/after studies (NYC DOT, FHWA). I did not look up or verify any specific study while building this, so treat them as placeholders. All are editable in step 3.

  | Fix | Cost | Crew-days | Assumed effect |
  |---|---|---|---|
  | Leading pedestrian interval | $10k | 1 | -13% pedestrian harm |
  | Daylighting + curb extension | $45k | 3 | -20% pedestrian, -10% cyclist |
  | Turn calming | $70k | 4 | -30% of pedestrians hurt by turning vehicles |
  | Protected redesign | $600k | 25 | -35% pedestrian, -35% cyclist, -15% motorist |
- **Effect on results:** the optimizer chose only leading pedestrian intervals and daylighting. A different cost or effect for turn calming or redesign could change that. The results are only as good as these numbers.
- **Code:** `DEFAULT_TREATMENTS` in `src/model.ts`; editing table in `stepFixes()` in `index.ts`.

### D8. A fix reduces harm by a percentage of the group it targets
- **What:** each fix has a percentage reduction for pedestrians, cyclists and motorists, plus one for pedestrians hit by turning vehicles. Avoided harm is the percentage times that group's harm points.
- **Why:** it is simple, transparent and easy to edit.
- **Limits:** the turn-calming effect is applied to turning-pedestrian injuries counted as plain injuries (weight 1), so it slightly undervalues the severe ones. A fixed percentage also ignores that high-harm intersections may respond differently, and that very high counts can partly be chance that fades on its own ("regression to the mean"), which would make real benefits smaller than shown.
- **Code:** `buildOptions()` in `src/model.ts`.

### D9. One fix per intersection, and no repeating what exists
- **What:** each intersection gets at most one fix. If it already has a leading pedestrian interval or turn calming, that fix is not offered there.
- **Why:** stacking fixes needs a rule for how effects combine, and I had none. Not repeating existing fixes avoids paying for something already in place.
- **Alternative:** allow combinations with diminishing returns. That is more realistic but needs assumptions I could not support.
- **Code:** `eligible()` in `src/model.ts`; the "one per site" rows in `src/lp.ts`.

---

## Rule decisions

### D10. Three hard rules: budget, crew-days, minimum low-income spend
- **Budget:** default $3M (your number).
- **Work capacity:** default 200 crew-days, pooled. **This default is mine**; you asked for a capacity rule but gave no figure. I picked a value that makes crews matter alongside the budget. It turned out to be the limit that actually constrains the plan.
- **Minimum low-income share:** default 40% (my choice; you gave no figure). It is a minimum share of **dollars** spent at known low-income sites, not of sites. That keeps a few huge projects from satisfying it on paper.
- **Alternatives for equity:** a share of sites; a share of harm avoided; or giving low-income sites extra weight instead of a hard floor.
- **Code:** `DEFAULT_PARAMS` in `src/model.ts`; constraints in `src/lp.ts` (the `budget`, `crew` and `equity` lines).

### D11. "Low-income" excludes intersections with unknown income
- **What:** the source table `nyc_safety_sites` flags all 1,161 intersections with **no income data** (median income stored as the placeholder -666,666,666) as low-income. I found this after the first version. The app now overrides it: an intersection counts as low-income only if the source flag is true **and** its income is known. Unknown-income intersections are neither low nor high; they simply do not count toward the low-income spending floor.
- **Size of the change:** in the app's data, 728 of the 8,226 originally flagged intersections (about 9%) have unknown income, leaving 7,498 low-income. A new `income_known` column carries the distinction.
- **Effect on the default run:** the optimizer's low-income share of spend went from 46% to 44%, and worst-first's from 100% to 80% (its fifth site is not low-income). Fixes chosen, spend and people spared did not change (144 fixes, $2.42M, about 45 people per year); harm points avoided went from 132.0 to 131.9, which is within the solver's 0.2% tolerance. 5 of the optimizer's 144 picks are unknown-income sites; they still get fixes, they just don't count toward the floor. With a 70% minimum, the plan is 130 fixes for $2.53M and avoids about 5% fewer harm points than the unconstrained plan (126 vs. 132); people spared stay about 47.
- **Alternatives:** keep the source flag as is (counts unknown as low-income, which overstates equity spending); exclude unknown-income sites from the model entirely (loses real harm); treat them as their own group with a separate floor.
- **Code:** `(s.low_income AND s.median_income > 0) AS low_income` and `income_known` in `SITES_SQL` (`src/queries.ts`); the equity row in `src/lp.ts`.

---

## Optimizer decisions

### D12. A real optimizer instead of a ranking rule
- **What:** the plan is found by an integer program: for every possible site-and-fix pair, a yes/no choice; maximize harm avoided; obey the rules above and "at most one fix per site".
- **Why:** with several rules interacting, ranking by benefit per dollar cannot guarantee the best plan, and it does not know about crew time or the equity floor. An optimizer can show it is within a stated distance of the best possible.
- **Alternatives:** greedy "best value per dollar" (fast, no guarantee); run it on CARTO's servers (see D1).
- **Settings:** stop when within 0.2% of the best possible, or after 25 seconds. On my test machine the default run took about a second.
- **Code:** `solveOptions()` in `src/lp.ts`; runs in `src/solver.worker.ts`; started by `runOptimizer()` in `index.ts`.

### D13. The optimizer only looks at the most promising options
- **What:** of roughly 59,000 possible site-and-fix pairs, it keeps about 9,800: the 3,000 sites with the highest possible benefit, plus the 1,500 best low-income sites.
- **Why:** it keeps the solve fast in a browser.
- **Risk:** the best plan could in theory use a pair I filtered out. I did not test the full 59,000, so I cannot say how close the shortcut is to the true optimum. "Within 0.2%" refers only to the reduced set.
- **Code:** `candidates()` in `src/model.ts`.

### D14. The comparison plan, "fix the most dangerous first"
- **What:** go down the list from most to least dangerous; give each intersection the strongest fix that still fits the remaining budget and crew time; skip it if nothing fits.
- **Why:** this is how I read "simply fixing the most dangerous first".
- **Fairness caveat:** "strongest fix" means the full redesign, so the baseline spends the budget on five expensive projects. A smarter baseline, such as giving every dangerous intersection the cheapest fix, would do much better, and the 3x gap would shrink. The comparison shows the cost of the specific naive approach, not of ranking in general. This baseline also ignores the low-income rule; in the default run it reached 80% low-income spend by coincidence (four of its five sites are low-income).
- **Code:** `greedyPlan()` in `src/model.ts`.

---

## Presentation decisions

### D15. Map colors and symbols
- **What:** intersections run from pale yellow to deep red on a log scale, with larger dots for higher harm, so a few extreme sites do not wash out the rest. After the optimizer runs, picks show green (optimizer), orange (worst-first), purple (both). The neighborhood chart uses the red and orange you asked to keep.
- **Code:** `ramp()` and `layers()` in `index.ts`; chart styles at the end of `style.css`.

### D16. Neighborhood chart
- **What:** top 12 neighborhoods by harm (expandable to 30), a red bar for harm points and an orange part for the share the optimizer avoids, with the number of fixes beside the name. Shown in steps 2, 5 and 6.
- **Code:** `ntaChart()` in `index.ts`.

### D17. Plain TypeScript, no UI framework
- **What:** vanilla TypeScript with Vite, MapLibre and deck.gl.
- **Why:** it is a one-screen demo; this is the lightest setup. React would be better if this grew to multiple screens or logins.
- **Code:** `package.json`, `index.ts`.

---

## Access, hosting and saving decisions

### D18. A restricted data token baked into the app
- **What:** the app reads data with a CARTO access token that can only run these three exact queries and only from the hosted address and localhost. The token is built into the downloaded app files.
- **Why:** you asked for an access token that works on the hosted URL.
- **Trade-offs:** anyone who can open the app can read the token from its code. That is low-risk because the token is read-only and limited to these queries, but it is not zero. CARTO's hosted-app feature can instead hand each viewer their own token at runtime, which avoids baking one in; I did not use that because you asked for a token. The token never expires; rotate it if it leaks.
- **What went wrong once:** the first allowed-address rule used the full app path. Browsers send only the site name to a different address, so the app got "403 Unauthorized referer". The rule now allows the whole site.
- **Code:** `.env` (not committed); `.env.example`; token grants are the queries in `src/queries.ts`.

### D19. Sharing and the repository
- **What:** the hosted app is shared with your organization only; the GitHub repo is public.
- **Secrets:** `.env` and the built `dist/` folder (which contains the token) are in `.gitignore`. I scanned staged files for credentials before each commit.
- **Code:** `.gitignore`.

### D20. A frozen copy of the data
- **What:** CSV copies of all three query results in `data/`, so the app could be rebuilt without CARTO. The app does not use them yet. The README maps each file to its query.
- **Code:** `data/`, README "Data snapshot".

---

## What this app does not do

- It does not check that the fix effects are right. Those are my estimates (D7).
- It does not show uncertainty. All numbers are single estimates, and past crashes are assumed to repeat.
- It does not model combining fixes, construction sequencing, or which crew can work where (D9, D10).
- It does not use traffic volumes, so a busy intersection and a quiet one with the same crash count score the same.
- It was not clicked through end-to-end in a browser by me. The optimizer logic, queries, build and deployment were tested; the on-screen behaviour, including the hosted version loading data, was not directly observed.
