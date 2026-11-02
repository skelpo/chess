// Synthetic mutable numeric-array probe. Run plain/bounded at 1M and 2M.
// The bounded control assumes untouched array prototypes; it is not a valid
// general rewrite when negative/index properties or prototype getters exist.
function scanPlain(iterations: number): number {
  const bins = new Array<number>(8).fill(0);
  let checksum = 0;
  for (let i = 0; i < iterations; i++) {
    const file = i & 7;
    bins[file] = ((i >>> 3) & 7) + 1;
    checksum += (bins[file - 1] ?? 0) + (bins[file + 1] ?? 0);
  }
  return checksum;
}
function scanBounded(iterations: number): number {
  const bins = new Array<number>(8).fill(0);
  let checksum = 0;
  for (let i = 0; i < iterations; i++) {
    const file = i & 7;
    bins[file] = ((i >>> 3) & 7) + 1;
    checksum += (file === 0 ? 0 : (bins[file - 1] ?? 0)) +
      (file === 7 ? 0 : (bins[file + 1] ?? 0));
  }
  return checksum;
}
const mode = process.argv[2] ?? "plain";
const amount = Number(process.argv[3] ?? "1000000");
if ((mode !== "plain" && mode !== "bounded") || !Number.isSafeInteger(amount) || amount <= 0) {
  throw new Error("Expected plain|bounded and a positive iteration count");
}
const warmup = mode === "plain" ? scanPlain(10000) : scanBounded(10000);
const started = performance.now();
const checksum = mode === "plain" ? scanPlain(amount) : scanBounded(amount);
const milliseconds = performance.now() - started;
console.log(JSON.stringify({ mode, amount, warmup, checksum, milliseconds }));
