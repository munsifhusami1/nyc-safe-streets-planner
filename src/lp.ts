import type { Option, Params } from './model';

/** Builds the multiple-choice knapsack as a CPLEX-LP string and solves it with HiGHS; returns chosen option indexes. */
export function solveOptions(highs: { solve: (lp: string, o?: Record<string, unknown>) => any }, options: Option[], p: Params) {
  const obj: string[] = [], bud: string[] = [], cap: string[] = [], eq: string[] = [], bins: string[] = [];
  const per = new Map<number, string[]>();
  options.forEach((o, i) => {
    const x = `x${i}`;
    obj.push(`${o.benefit.toFixed(6)} ${x}`);
    bud.push(`${o.cost} ${x}`);
    cap.push(`${o.crew} ${x}`);
    // low-income spend >= m * total spend  <=>  (1-m)*low - m*other >= 0
    eq.push(`${(o.site.low_income ? 1 - p.minLow : -p.minLow).toFixed(6)} ${x}`);
    bins.push(x);
    const a = per.get(o.site.site_id); a ? a.push(x) : per.set(o.site.site_id, [x]);
  });
  const one = [...per.values()].filter(v => v.length > 1).map((v, i) => ` one${i}: ${v.join(' + ')} <= 1`);
  const lp = `Maximize\n obj: ${obj.join(' + ')}\nSubject To\n budget: ${bud.join(' + ')} <= ${p.budget}\n crew: ${cap.join(' + ')} <= ${p.crew}\n equity: ${eq.join(' + ')} >= 0\n${one.join('\n')}\nBinary\n ${bins.join(' ')}\nEnd\n`;
  const sol = highs.solve(lp, { mip_rel_gap: 0.002, time_limit: 25 });
  const picked: number[] = [];
  for (const [name, c] of Object.entries(sol.Columns as Record<string, { Primal: number }>)) if (c.Primal > 0.5) picked.push(Number(name.slice(1)));
  return { picked, status: sol.Status as string };
}
