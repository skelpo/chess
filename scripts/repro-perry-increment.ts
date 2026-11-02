// Synthetic short scan; no application source or dependencies.
const STEPS: number[] = [-17, -16, -15, -1, 1, 15, 16, 17];
class Probe {
  cells: number[] = new Array<number>(128).fill(0);
  constructor() {
    for (let i = 0; i < 128; i++) this.cells[i] = (i & 0x88) === 0 ? ((i * 3) % 7) - 3 : 0;
  }
  probe(origin: number): boolean {
    const cells = this.cells;
    for (let j = 0; j < STEPS.length; j++) {
      const square = origin + (STEPS[j] ?? 0);
      if (square >= 0 && square < 128 && (square & 0x88) === 0 && (cells[square] ?? 0) === 2) return true;
    }
    return false;
  }
}
function scan(board: Probe, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) if (board.probe(i & 127)) sum++;
  return sum;
}
const n = Number(process.argv[2] ?? "5000000");
const board = new Probe();
const warmup = scan(board, 100000);
const t = performance.now();
const checksum = scan(board, n);
console.log(JSON.stringify({ n, warmup, checksum, milliseconds: performance.now() - t }));
