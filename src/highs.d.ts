declare module 'highs' {
  const loader: (o?: { locateFile?: (f: string) => string }) => Promise<{ solve: (lp: string, o?: Record<string, unknown>) => any }>;
  export default loader;
}
declare module 'highs/runtime?url' { const u: string; export default u; }
