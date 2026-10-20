import { Deck, FlyToInterpolator } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { BASEMAP } from '@deck.gl/carto';
import { query } from '@carto/api-client';
import maplibregl from 'maplibre-gl';
import { NTA_SQL, PEOPLE_SQL, SITES_SQL } from './src/queries';
import {
  DEFAULT_PARAMS, DEFAULT_TREATMENTS, Option, Params, Plan, Site, Treatment, YEARS,
  buildOptions, candidates, fmt$, fmtN, greedyPlan, siteHarm, summarize,
} from './src/model';

const cfg = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL,
  accessToken: import.meta.env.VITE_API_ACCESS_TOKEN,
  connectionName: import.meta.env.VITE_CONNECTION_NAME,
};
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

type PeopleRow = { year: number; mode: string; severity: string; turning: boolean; n: number };
let sites: Site[] = [];
let people: PeopleRow[] = [];
let ntaOf = new Map<number, { nta: string; name: string }>();
let ntaRows = 12;
let treatments: Treatment[] = structuredClone(DEFAULT_TREATMENTS);
let params: Params = { ...DEFAULT_PARAMS };
let step = 0;
let optimal: Plan | null = null;
let naive: Plan | null = null;
let solving = false;
let hover: Site | null = null;
let highlight: number | null = null;

const STEPS = ['Who', 'Where', 'Fixes', 'Rules', 'Optimize', 'Compare'];
const MODE_LABEL: Record<string, string> = { ped: 'Pedestrians', cyc: 'Cyclists', mot: 'Motorists' };
const MODE_COLOR: Record<string, string> = { ped: '#E8743B', cyc: '#7A4FD6', mot: '#036FE2' };

// ---------- map ----------
const INITIAL = { longitude: -73.95, latitude: 40.72, zoom: 10.4, pitch: 0, bearing: 0 };
const map = new maplibregl.Map({ container: 'map', style: BASEMAP.POSITRON, interactive: false, ...INITIAL });
const deck = new Deck({
  canvas: 'deck-canvas', initialViewState: INITIAL, controller: true, layers: [],
  onViewStateChange: ({ viewState }: any) => { const { longitude, latitude, ...r } = viewState; map.jumpTo({ center: [longitude, latitude], zoom: r.zoom, bearing: r.bearing, pitch: r.pitch }); },
  onHover: (info: any) => {
    const t = $('tooltip');
    if (info.object) { hover = info.object.site ?? info.object; const s = hover!; t.style.display = 'block'; t.style.left = info.x + 12 + 'px'; t.style.top = info.y + 12 + 'px'; t.innerHTML = `<b>${esc(s.name)}</b><br>${s.borough} · ${fmtN(siteHarm(s, params.skWeight), 1)} harm pts/yr${s.low_income ? ' · low-income area' : ''}`; }
    else t.style.display = 'none';
  },
} as any);

const ramp = (v: number): [number, number, number, number] => {
  const t = Math.min(1, Math.log1p(v) / Math.log1p(40));
  const a = [254, 224, 144], b = [215, 48, 39];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 70 + 170 * t];
};

function layers() {
  const L: any[] = [];
  if (step <= 3) {
    const sorted = [...sites].sort((a, b) => siteHarm(a, params.skWeight) - siteHarm(b, params.skWeight));
    L.push(new ScatterplotLayer<Site>({
      id: 'sites', data: sorted, pickable: true, getPosition: d => [d.lon, d.lat],
      getFillColor: d => ramp(siteHarm(d, params.skWeight)), radiusUnits: 'pixels',
      getRadius: d => 1.5 + Math.min(7, Math.sqrt(siteHarm(d, params.skWeight)) * 1.4),
      updateTriggers: { getFillColor: params.skWeight, getRadius: params.skWeight },
    }));
    if (step === 1) {
      const top = topSites(10);
      L.push(new ScatterplotLayer<Site>({ id: 'top', data: top, getPosition: d => [d.lon, d.lat], stroked: true, filled: false, getLineColor: [20, 20, 20, 255], lineWidthUnits: 'pixels', getLineWidth: 2, radiusUnits: 'pixels', getRadius: 13, pickable: true }));
    }
  } else {
    L.push(new ScatterplotLayer<Site>({ id: 'ctx', data: sites, getPosition: d => [d.lon, d.lat], getFillColor: [150, 156, 160, 60], radiusUnits: 'pixels', getRadius: 1.5 }));
    const o = new Map((optimal?.picks ?? []).map(p => [p.site.site_id, p]));
    const n = new Map((naive?.picks ?? []).map(p => [p.site.site_id, p]));
    const both = [...o.keys()].filter(k => n.has(k));
    const rows = [
      ...(naive && step === 5 ? [...n.values()].map(p => ({ site: p.site, c: both.includes(p.site.site_id) ? [122, 79, 214] : [232, 116, 59] })) : []),
      ...(optimal ? [...o.values()].filter(p => !(step === 5 && n.has(p.site.site_id))).map(p => ({ site: p.site, c: [15, 143, 107] })) : []),
    ];
    L.push(new ScatterplotLayer<any>({ id: 'plan', data: rows, pickable: true, getPosition: d => [d.site.lon, d.site.lat], getFillColor: d => [d.c[0], d.c[1], d.c[2], 230], stroked: true, getLineColor: [255, 255, 255, 255], lineWidthUnits: 'pixels', getLineWidth: 1, radiusUnits: 'pixels', getRadius: 5 }));
  }
  if (highlight != null) {
    const s = sites.find(x => x.site_id === highlight);
    if (s) L.push(new ScatterplotLayer<Site>({ id: 'hl', data: [s], getPosition: d => [d.lon, d.lat], stroked: true, filled: false, getLineColor: [3, 111, 226, 255], lineWidthUnits: 'pixels', getLineWidth: 3, radiusUnits: 'pixels', getRadius: 16 }));
  }
  deck.setProps({ layers: L });
}

function legend() {
  const el = $('legend');
  if (step <= 3) el.innerHTML = `<b>Harm points per year</b><div style="height:8px;margin:6px 0 2px;border-radius:4px;background:linear-gradient(90deg,rgb(254,224,144),rgb(215,48,39))"></div><div class="row small"><span>low</span><span>high</span></div>`;
  else if (step === 4) el.innerHTML = `<span class="sw" style="background:var(--opt)"></span>Optimizer plan`;
  else el.innerHTML = `<div><span class="sw" style="background:var(--opt)"></span>Optimizer only</div><div><span class="sw" style="background:var(--naive)"></span>Worst-first only</div><div><span class="sw" style="background:var(--both)"></span>Both plans</div>`;
}

function flyTo(s: Site) {
  highlight = s.site_id;
  deck.setProps({ initialViewState: { longitude: s.lon, latitude: s.lat, zoom: 15, pitch: 0, bearing: 0, transitionDuration: 900, transitionInterpolator: new FlyToInterpolator() } } as any);
  layers();
}

// ---------- data helpers ----------
const topSites = (n: number) => [...sites].sort((a, b) => siteHarm(b, params.skWeight) - siteHarm(a, params.skWeight)).slice(0, n);
const bar = (parts: { v: number; c: string }[]) => { const t = parts.reduce((a, p) => a + p.v, 0) || 1; return `<div class="bar">${parts.map(p => `<span style="width:${(100 * p.v / t).toFixed(2)}%;background:${p.c}"></span>`).join('')}</div>`; };


// ---------- neighborhoods (NTA) ----------
function ntaChart() {
  const m = new Map<string, { name: string; harm: number; fixes: number; avoided: number; cost: number }>();
  for (const s of sites) {
    const n = ntaOf.get(s.site_id); if (!n) continue;
    const e = m.get(n.nta) ?? { name: n.name, harm: 0, fixes: 0, avoided: 0, cost: 0 }; e.harm += siteHarm(s, params.skWeight); m.set(n.nta, e);
  }
  for (const o of optimal?.picks ?? []) { const e = m.get(ntaOf.get(o.site.site_id)?.nta ?? ''); if (e) { e.fixes++; e.avoided += o.benefit; e.cost += o.cost; } }
  const rows = [...m.values()].sort((a, b) => b.harm - a.harm), shown = rows.slice(0, ntaRows), mx = Math.max(...shown.map(r => r.harm), 1);
  return `<div class="card"><b>By neighborhood</b> <span class="small">top ${shown.length} of ${rows.length} by harm</span>
  <div class="small" style="margin:4px 0 8px"><span class="sw2" style="background:#D73027"></span>Harm points / yr${optimal ? ` &nbsp;<span class="sw2" style="background:#E8743B"></span>Avoided by optimizer` : ''}</div>
  ${shown.map(r => `<div class="nta" title="${esc(r.name)}: ${fmtN(r.harm, 1)} harm pts/yr${optimal ? `, ${r.fixes} fixes, ${fmtN(r.avoided, 1)} avoided, ${fmt$(r.cost)}` : ''}"><div class="row"><span class="nm">${esc(r.name)}</span><span class="small">${fmtN(r.harm, 0)}${optimal ? ` · ${r.fixes} fix${r.fixes === 1 ? '' : 'es'}` : ''}</span></div>
  <div class="ntabar" style="width:${(100 * r.harm / mx).toFixed(1)}%"><span style="width:${r.harm ? (100 * Math.min(1, r.avoided / r.harm)).toFixed(1) : 0}%"></span></div></div>`).join('')}
  ${rows.length > 12 ? `<button class="ghost" id="nta-more" style="margin-top:8px;padding:4px 10px">${ntaRows > 12 ? 'Show fewer' : 'Show top 30'}</button>` : ''}</div>`;
}

// ---------- steps ----------
function stepWho() {
  const yrs = people.filter(r => r.year >= 2012 && r.year <= 2025);
  const sum = (f: (r: PeopleRow) => boolean) => yrs.filter(f).reduce((a, r) => a + r.n, 0);
  const total = sum(() => true), killed = sum(r => r.severity === 'killed'), serious = sum(r => r.severity === 'serious');
  const modes = ['ped', 'cyc', 'mot'].map(m => ({ m, inj: sum(r => r.mode === m && r.severity === 'injured'), sk: sum(r => r.mode === m && r.severity !== 'injured'), k: sum(r => r.mode === m && r.severity === 'killed') }));
  const ped = yrs.filter(r => r.mode === 'ped' && r.year >= 2021), turnShare = ped.filter(r => r.turning).reduce((a, r) => a + r.n, 0) / (ped.reduce((a, r) => a + r.n, 0) || 1);
  const years = [...new Set(yrs.map(r => r.year))].sort();
  const vul = years.map(y => yrs.filter(r => r.year === y && r.mode !== 'mot').reduce((a, r) => a + r.n, 0));
  const mx = Math.max(...vul, 1);
  const spark = `<svg viewBox="0 0 ${years.length * 24} 52" width="100%" height="64">${years.map((y, i) => `<rect x="${i * 24 + 3}" y="${48 - 44 * vul[i] / mx}" width="18" height="${44 * vul[i] / mx}" rx="2" fill="#E8743B" opacity=".85"/><text x="${i * 24 + 12}" y="52" font-size="7" text-anchor="middle" fill="#6F777C">${String(y).slice(2)}</text>`).join('')}</svg>`;
  return `<h2>1 · Who are we protecting?</h2>
  <p class="lede">Every person hurt in a New York crash, 2012–2025. Walkers and cyclists have no steel around them, so they bear the worst outcomes.</p>
  <div class="kpis"><div class="kpi"><div class="v">${fmtN(total)}</div><div class="l">people hurt</div></div><div class="kpi"><div class="v">${fmtN(serious)}</div><div class="l">seriously injured</div></div><div class="kpi"><div class="v">${fmtN(killed)}</div><div class="l">killed</div></div></div>
  ${modes.map(x => `<div class="card"><div class="row"><b style="color:${MODE_COLOR[x.m]}">${MODE_LABEL[x.m]}</b><span>${fmtN(x.inj + x.sk)} hurt · ${fmtN(x.k)} killed</span></div>${bar([{ v: x.inj, c: MODE_COLOR[x.m] + '66' }, { v: x.sk - x.k, c: MODE_COLOR[x.m] }, { v: x.k, c: '#2C3032' }])}<div class="small">${(100 * x.k / (x.inj + x.sk)).toFixed(2)}% of those hurt were killed</div></div>`).join('')}
  <div class="card"><b>Pedestrians and cyclists hurt per year</b>${spark}</div>
  <div class="note"><b>${(100 * turnShare).toFixed(0)}%</b> of pedestrians hurt since 2021 were struck by a <b>turning</b> vehicle, which is why signal timing and turn design are the first tools we try.</div>`;
}

function stepWhere() {
  const w = params.skWeight, arr = [...sites].sort((a, b) => siteHarm(b, w) - siteHarm(a, w));
  const tot = arr.reduce((a, s) => a + siteHarm(s, w), 0), n10 = Math.ceil(arr.length * 0.1);
  const share10 = arr.slice(0, n10).reduce((a, s) => a + siteHarm(s, w), 0) / tot;
  return `<h2>2 · Where is it most dangerous?</h2>
  <p class="lede">Each intersection scores <b>harm points per year</b> (2021–2025): 1 per injury and ${w} per serious injury or death. Highways are left out because these street fixes don't apply.</p>
  <div class="kpis"><div class="kpi"><div class="v">${fmtN(arr.length)}</div><div class="l">intersections with harm</div></div><div class="kpi"><div class="v">${(100 * share10).toFixed(0)}%</div><div class="l">of harm in worst 10%</div></div><div class="kpi"><div class="v">${(100 * arr.filter(s => s.low_income).length / arr.length).toFixed(0)}%</div><div class="l">in low-income areas</div></div></div>
  <b>Ten most dangerous</b> <span class="small">(click to zoom)</span>
  <ul class="top">${arr.slice(0, 10).map((s, i) => `<li data-id="${s.site_id}"><span class="n">${i + 1}</span><span class="t"><b>${esc(s.name)}</b><span class="small">${s.borough} · ${fmtN(siteHarm(s, w), 1)} pts/yr · ${fmtN((s.ped_inj + s.ped_sk) / YEARS, 1)} ped/yr</span></span>${s.low_income ? '<span class="chip">low income</span>' : ''}${s.has_lpi ? '<span class="chip g">has LPI</span>' : ''}</li>`).join('')}</ul>
  ${ntaChart()}`;
}

function stepFixes() {
  return `<h2>3 · What fixes work, and what do they cost?</h2>
  <p class="lede">Each fix cuts the harm it targets. Effects are per-category reductions; costs and crew-days come from typical NYC projects.</p>
  <div class="note warn"><b>Planning assumptions.</b> These figures are approximations from published before/after studies (NYC DOT, FHWA). Edit any of them and the plan recomputes. Check them against local engineering estimates before spending money.</div>
  ${treatments.map((t, i) => `<div class="card"><b>${t.name}</b><div class="small">${t.blurb}</div>
  <table><tr><th>Cost ($)</th><th>Crew-days</th><th class="r">Ped %</th><th class="r">Cyc %</th><th class="r">Mot %</th><th class="r">Turn %</th></tr>
  <tr><td><input type="number" data-t="${i}" data-k="cost" value="${t.cost}"></td><td><input type="number" data-t="${i}" data-k="crew" value="${t.crew}"></td>
  ${(['ped', 'cyc', 'mot', 'turn'] as const).map(k => `<td><input type="number" data-t="${i}" data-k="fx.${k}" value="${Math.round(t.fx[k] * 100)}"></td>`).join('')}</tr></table></div>`).join('')}
  <div class="small">Turn % applies to pedestrians hit by turning vehicles. A site can receive at most one fix. Sites that already have a leading pedestrian interval or turn calming can't get it again.</div>`;
}

function stepRules() {
  const opts = buildOptions(sites, treatments, params);
  return `<h2>4 · What are the hard rules?</h2>
  <p class="lede">The optimizer must obey all of these at once.</p>
  <div class="field"><label>Budget <span id="v-budget">${fmt$(params.budget)}</span></label><input type="range" id="budget" min="500000" max="10000000" step="250000" value="${params.budget}"></div>
  <div class="field"><label>Work capacity <span id="v-crew">${params.crew} crew-days</span></label><input type="range" id="crew" min="20" max="1000" step="10" value="${params.crew}"><div class="hint">Total installation effort the crews can deliver.</div></div>
  <div class="field"><label>Minimum spend in low-income areas <span id="v-low">${Math.round(params.minLow * 100)}%</span></label><input type="range" id="minLow" min="0" max="100" step="5" value="${params.minLow * 100}"><div class="hint">At least this share of dollars must go to sites flagged low-income.</div></div>
  <div class="field"><label>Weight of a serious injury or death <span id="v-sk">${params.skWeight}×</span></label><input type="range" id="sk" min="1" max="30" step="1" value="${params.skWeight}"><div class="hint">Relative to a minor injury (1 point).</div></div>
  <div class="note">${fmtN(opts.length)} possible site-and-fix combinations across ${fmtN(new Set(opts.map(o => o.site.site_id)).size)} intersections.</div>`;
}

function stepOptimize() {
  return `<h2>5 · Let the optimizer pick</h2>
  <p class="lede">An integer program (HiGHS, running in your browser) chooses at most one fix per intersection to maximize harm avoided under your rules.</p>
  <button class="primary" id="run" ${solving ? 'disabled' : ''}>${solving ? '<span class="spin"></span>Solving…' : optimal ? 'Re-run optimizer' : 'Run optimizer'}</button>
  ${optimal ? planCard(optimal, 'Optimized plan') + mixCard(optimal) + ntaChart() : ''}`;
}

const mixCard = (p: Plan) => {
  const m = new Map<string, { n: number; c: number }>(); p.picks.forEach(o => { const x = m.get(o.t.name) ?? { n: 0, c: 0 }; x.n++; x.c += o.cost; m.set(o.t.name, x); });
  return `<div class="card"><b>Fix mix</b><table>${[...m.entries()].map(([k, v]) => `<tr><td>${k}</td><td class="r">${fmtN(v.n)} sites</td><td class="r">${fmt$(v.c)}</td></tr>`).join('')}</table></div>`;
};

function planCard(p: Plan, title: string) {
  const share = p.cost ? p.lowCost / p.cost : 0;
  return `<div class="card"><b>${title}</b>${p.status ? ` <span class="small">solver: ${esc(p.status)}</span>` : ''}
  <div class="kpis"><div class="kpi"><div class="v">${fmtN(p.picks.length)}</div><div class="l">intersections fixed</div></div><div class="kpi"><div class="v">${fmt$(p.cost)}</div><div class="l">of ${fmt$(params.budget)}</div></div><div class="kpi"><div class="v">${fmtN(p.people, 0)}</div><div class="l">fewer people hurt / yr</div></div></div>
  <div class="row small"><span>Crew-days ${fmtN(p.crew)} / ${params.crew}</span><span>Low-income spend ${(100 * share).toFixed(0)}% (min ${Math.round(params.minLow * 100)}%)</span></div></div>`;
}

function stepCompare() {
  if (!optimal || !naive) return `<h2>6 · Compare and download</h2><p class="lede">Run the optimizer in step 5 first.</p>`;
  const o = optimal, n = naive, sh = (p: Plan) => p.cost ? p.lowCost / p.cost : 0;
  const d = (a: number, b: number) => b > 0 ? `${a >= b ? '+' : ''}${(100 * (a - b) / b).toFixed(0)}%` : '–';
  const row = (l: string, a: string, b: string) => `<tr><td>${l}</td><td class="r o">${a}</td><td class="r nv">${b}</td></tr>`;
  return `<h2>6 · Compare and download</h2>
  <p class="lede">Optimizer vs. simply fixing the most dangerous intersections first with the same budget and crews.</p>
  <div class="card"><table class="cmp"><tr><th></th><th class="r">Optimizer</th><th class="r">Worst first</th></tr>
  ${row('Intersections fixed', fmtN(o.picks.length), fmtN(n.picks.length))}
  ${row('Spend', fmt$(o.cost), fmt$(n.cost))}
  ${row('Crew-days', fmtN(o.crew), fmtN(n.crew))}
  ${row('Low-income share of spend', (100 * sh(o)).toFixed(0) + '%', (100 * sh(n)).toFixed(0) + '%' + (sh(n) + 1e-9 < params.minLow ? ' ✗' : ''))}
  ${row('Harm points avoided / yr', fmtN(o.benefit, 1), fmtN(n.benefit, 1))}
  ${row('People spared / yr', fmtN(o.people, 0), fmtN(n.people, 0))}</table></div>
  <div class="note"><b>${d(o.people, n.people)}</b> more people spared per year${sh(n) + 1e-9 < params.minLow ? ', and worst-first breaks the low-income rule' : ''}. Worst-first spends big on a few notorious intersections; the optimizer buys more cheap, high-return fixes across the city.</div>
  <div class="small">Map: <span style="color:var(--opt)">●</span> optimizer only · <span style="color:var(--naive)">●</span> worst-first only · <span style="color:var(--both)">●</span> both. Estimates assume the effect rates in step 3 and past crashes repeating.</div>
  ${ntaChart()}
  <div class="btns"><a class="btn" id="dl-csv">Download plan (CSV)</a><a class="btn alt" id="dl-geo">GeoJSON</a><a class="btn alt" id="dl-naive">Worst-first (CSV)</a></div>`;
}

// ---------- plan export ----------
const csvRows = (p: Plan) => {
  const h = ['rank', 'site_id', 'name', 'borough', 'low_income', 'lon', 'lat', 'treatment', 'cost_usd', 'crew_days', 'harm_points_avoided_per_year', 'people_spared_per_year'];
  const rows = [...p.picks].sort((a, b) => b.benefit / b.cost - a.benefit / a.cost).map((o, i) => [i + 1, o.site.site_id, `"${o.site.name.replace(/"/g, '""')}"`, o.site.borough, o.site.low_income, o.site.lon, o.site.lat, o.t.name, o.cost, o.crew, o.benefit.toFixed(3), o.people.toFixed(3)]);
  return [h, ...rows].map(r => r.join(',')).join('\n');
};
const geo = (p: Plan) => JSON.stringify({ type: 'FeatureCollection', features: p.picks.map(o => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [o.site.lon, o.site.lat] }, properties: { site_id: o.site.site_id, name: o.site.name, borough: o.site.borough, low_income: o.site.low_income, treatment: o.t.name, cost_usd: o.cost, harm_points_avoided_per_year: +o.benefit.toFixed(3) } })) });
const link = (id: string, text: string, name: string, mime: string) => { const a = document.getElementById(id) as HTMLAnchorElement | null; if (a) { a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name; } };

// ---------- optimizer ----------
function runOptimizer() {
  const all = buildOptions(sites, treatments, params);
  naive = greedyPlan(sites, all, params);
  const cand = candidates(all);
  solving = true; render();
  const w = new Worker(new URL('./src/solver.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent) => {
    solving = false; w.terminate();
    if (!e.data.ok) { alert('Solver error: ' + e.data.error); render(); return; }
    optimal = summarize((e.data.picked as number[]).map(i => cand[i]), e.data.status);
    render();
  };
  w.postMessage({ options: cand, p: params });
}

// ---------- render ----------
function render() {
  $('steps').innerHTML = STEPS.map((s, i) => `<button class="${i === step ? 'on' : i < step ? 'done' : ''}" data-s="${i}"><b>${i + 1}</b>${s}</button>`).join('');
  const c = $('content');
  if (!sites.length) { c.innerHTML = '<div class="loading">Loading New York crash data…</div>'; return; }
  c.innerHTML = [stepWho, stepWhere, stepFixes, stepRules, stepOptimize, stepCompare][step]();
  $<HTMLButtonElement>('back').disabled = step === 0;
  $<HTMLButtonElement>('next').disabled = step === STEPS.length - 1 || (step === 4 && !optimal);
  c.querySelectorAll<HTMLElement>('.top li').forEach(li => li.onclick = () => flyTo(sites.find(s => s.site_id === +li.dataset.id!)!));
  c.querySelectorAll<HTMLInputElement>('input[data-t]').forEach(inp => inp.onchange = () => {
    const t = treatments[+inp.dataset.t!], k = inp.dataset.k!, v = Math.max(0, +inp.value);
    if (k.startsWith('fx.')) (t.fx as any)[k.slice(3)] = Math.min(100, v) / 100; else (t as any)[k] = v;
    optimal = naive = null;
  });
  const bind = (id: string, cb: (v: number) => void, lab: (v: number) => string) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el) el.oninput = () => { cb(+el.value); optimal = naive = null; $('v-' + (id === 'minLow' ? 'low' : id)).textContent = lab(+el.value); layers(); }; };
  bind('budget', v => params.budget = v, v => fmt$(v));
  bind('crew', v => params.crew = v, v => `${v} crew-days`);
  bind('minLow', v => params.minLow = v / 100, v => `${v}%`);
  bind('sk', v => params.skWeight = v, v => `${v}×`);
  document.getElementById('nta-more')?.addEventListener('click', () => { ntaRows = ntaRows > 12 ? 12 : 30; render(); });
  document.getElementById('run')?.addEventListener('click', runOptimizer);
  if (step === 5 && optimal && naive) { link('dl-csv', csvRows(optimal), 'nyc_safety_optimized_plan.csv', 'text/csv'); link('dl-geo', geo(optimal), 'nyc_safety_optimized_plan.geojson', 'application/geo+json'); link('dl-naive', csvRows(naive), 'nyc_safety_worst_first_plan.csv', 'text/csv'); }
  $('steps').querySelectorAll<HTMLButtonElement>('button').forEach(b => b.onclick = () => go(+b.dataset.s!));
  legend(); layers();
}
function go(n: number) { step = Math.max(0, Math.min(STEPS.length - 1, n)); highlight = null; render(); }
$('back').onclick = () => go(step - 1);
$('next').onclick = () => go(step + 1);

// ---------- boot ----------
render();
(async () => {
  try {
    const [s, p, n] = await Promise.all([
      query({ ...cfg, sqlQuery: SITES_SQL }),
      query({ ...cfg, sqlQuery: PEOPLE_SQL }),
      query({ ...cfg, sqlQuery: NTA_SQL }),
    ]);
    ntaOf = new Map((n.rows as any[]).map(r => [Number(r.site_id), { nta: String(r.nta), name: String(r.nta_name) }]));
    const num = (v: unknown) => Number(v) || 0;
    sites = (s.rows as any[]).map(r => ({ ...r, site_id: num(r.site_id), lon: num(r.lon), lat: num(r.lat), ped_inj: num(r.ped_inj), ped_sk: num(r.ped_sk), cyc_inj: num(r.cyc_inj), cyc_sk: num(r.cyc_sk), mot_inj: num(r.mot_inj), mot_sk: num(r.mot_sk), ped_turning: num(r.ped_turning) }));
    people = (p.rows as any[]).map(r => ({ year: num(r.year), mode: r.mode, severity: r.severity, turning: r.turning === true || r.turning === 'true', n: num(r.n) }));
    render();
  } catch (e) {
    $('content').innerHTML = `<div class="note warn">Couldn't load data: ${esc(String(e))}</div>`;
  }
})();
