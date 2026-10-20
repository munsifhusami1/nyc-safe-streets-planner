export type Site = {
  site_id: number; name: string; borough: string; low_income: boolean; vz_priority: boolean;
  has_lpi: boolean; has_turn_calming: boolean; lon: number; lat: number;
  ped_inj: number; ped_sk: number; cyc_inj: number; cyc_sk: number; mot_inj: number; mot_sk: number; ped_turning: number;
};
export type Effects = { ped: number; cyc: number; mot: number; turn: number };
export type Treatment = { id: string; name: string; blurb: string; cost: number; crew: number; fx: Effects };
export type Params = { budget: number; crew: number; minLow: number; skWeight: number };
export type Option = { site: Site; t: Treatment; cost: number; crew: number; benefit: number; people: number };
export type Plan = { picks: Option[]; cost: number; crew: number; lowCost: number; benefit: number; people: number; status?: string };

export const YEARS = 5; // 2021-2025 window
export const BOROUGH_COLORS: Record<string, string> = {};

// Planning-grade assumptions drawn from published before/after studies (NYC DOT Vision Zero, FHWA CMF Clearinghouse).
// They are editable in the app: replace them with local engineering estimates before committing funds.
export const DEFAULT_TREATMENTS: Treatment[] = [
  { id: 'lpi', name: 'Leading pedestrian interval', blurb: 'Walk signal starts 3-7 s before turning traffic is released.', cost: 10_000, crew: 1, fx: { ped: 0.13, cyc: 0, mot: 0, turn: 0 } },
  { id: 'daylight', name: 'Daylighting + curb extension', blurb: 'Clear parking at the corner so drivers and walkers see each other.', cost: 45_000, crew: 3, fx: { ped: 0.20, cyc: 0.10, mot: 0, turn: 0 } },
  { id: 'turn', name: 'Turn calming', blurb: 'Hardened centerlines and wedges force slower, squarer left turns.', cost: 70_000, crew: 4, fx: { ped: 0, cyc: 0, mot: 0, turn: 0.30 } },
  { id: 'redesign', name: 'Protected intersection redesign', blurb: 'Raised crossings, islands and protected bike/ped space.', cost: 600_000, crew: 25, fx: { ped: 0.35, cyc: 0.35, mot: 0.15, turn: 0 } },
];

export const DEFAULT_PARAMS: Params = { budget: 3_000_000, crew: 200, minLow: 0.4, skWeight: 10 };

export const siteHarm = (s: Site, w: number) => (s.ped_inj + s.cyc_inj + s.mot_inj + w * (s.ped_sk + s.cyc_sk + s.mot_sk)) / YEARS;
export const sitePeople = (s: Site) => (s.ped_inj + s.cyc_inj + s.mot_inj + s.ped_sk + s.cyc_sk + s.mot_sk) / YEARS;

export function eligible(s: Site, t: Treatment) {
  if (t.id === 'lpi' && s.has_lpi) return false;
  if (t.id === 'turn' && s.has_turn_calming) return false;
  return true;
}

export function buildOptions(sites: Site[], ts: Treatment[], p: Params): Option[] {
  const out: Option[] = [];
  for (const s of sites) for (const t of ts) {
    if (!eligible(s, t)) continue;
    const { ped, cyc, mot, turn } = t.fx, w = p.skWeight;
    const benefit = (ped * (s.ped_inj + w * s.ped_sk) + cyc * (s.cyc_inj + w * s.cyc_sk) + mot * (s.mot_inj + w * s.mot_sk) + turn * s.ped_turning) / YEARS;
    const people = (ped * (s.ped_inj + s.ped_sk) + cyc * (s.cyc_inj + s.cyc_sk) + mot * (s.mot_inj + s.mot_sk) + turn * s.ped_turning) / YEARS;
    if (benefit > 1e-9) out.push({ site: s, t, cost: t.cost, crew: t.crew, benefit, people });
  }
  return out;
}

export function summarize(picks: Option[], status?: string): Plan {
  let cost = 0, crew = 0, lowCost = 0, benefit = 0, people = 0;
  for (const o of picks) { cost += o.cost; crew += o.crew; benefit += o.benefit; people += o.people; if (o.site.low_income) lowCost += o.cost; }
  return { picks, cost, crew, lowCost, benefit, people, status };
}

/** Baseline: walk intersections from most to least dangerous and give each the strongest fix that still fits. */
export function greedyPlan(sites: Site[], opts: Option[], p: Params): Plan {
  const bySite = new Map<number, Option[]>();
  for (const o of opts) { const a = bySite.get(o.site.site_id); a ? a.push(o) : bySite.set(o.site.site_id, [o]); }
  const ranked = [...sites].sort((a, b) => siteHarm(b, p.skWeight) - siteHarm(a, p.skWeight));
  let cost = 0, crew = 0; const picks: Option[] = [];
  for (const s of ranked) {
    const os = (bySite.get(s.site_id) ?? []).filter(o => cost + o.cost <= p.budget && crew + o.crew <= p.crew).sort((a, b) => b.benefit - a.benefit);
    if (!os.length) continue;
    picks.push(os[0]); cost += os[0].cost; crew += os[0].crew;
    if (cost >= p.budget || crew >= p.crew) break;
  }
  return summarize(picks);
}

/** Shrinks the MIP: keep the highest-benefit sites overall and within low-income areas. */
export function candidates(opts: Option[]): Option[] {
  const best = new Map<number, number>(); const low = new Set<number>();
  for (const o of opts) { best.set(o.site.site_id, Math.max(best.get(o.site.site_id) ?? 0, o.benefit)); if (o.site.low_income) low.add(o.site.site_id); }
  const ids = [...best.entries()].sort((a, b) => b[1] - a[1]);
  const keep = new Set<number>(ids.slice(0, 3000).map(e => e[0]));
  let n = 0; for (const [id] of ids) if (low.has(id) && n < 1500) { keep.add(id); n++; }
  return opts.filter(o => keep.has(o.site.site_id));
}

export const fmt$ = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;
export const fmtN = (n: number, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
