import highsLoader from 'highs';
import wasmUrl from 'highs/runtime?url';
import type { Option, Params } from './model';
import { solveOptions } from './lp';

self.onmessage = async (e: MessageEvent<{ options: Option[]; p: Params }>) => {
  try {
    const highs = await highsLoader({ locateFile: () => wasmUrl });
    const { picked, status } = solveOptions(highs, e.data.options, e.data.p);
    (self as unknown as Worker).postMessage({ ok: true, picked, status });
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: String(err) });
  }
};
