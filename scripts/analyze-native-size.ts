import { readFileSync, writeFileSync } from "node:fs";

interface Section {
  index: number; segment: string; name: string; address: number;
  virtualBytes: number; fileBytes: number; flags: number;
}
interface SymbolExtent { address: number; bytes: number; names: string[]; group: string }
function group(names: string[]): string {
  const name = names.find(n => n.includes("perry_method_") || n.includes("perry_fn_")) ?? names[0] ?? "";
  if (/perry_(?:method|fn)_engine_src_chess_ts/.test(name)) return "generated engine";
  if (/perry_(?:method|fn|closure)_tui_src_/.test(name)) return "generated TUI";
  if (name.startsWith("_perry_")) return "other Perry generated/support";
  if (name.startsWith("_js_")) return "Perry runtime C ABI";
  if (name.includes("perry_runtime")) {
    const tail = name.slice(name.indexOf("perry_runtime") + "perry_runtime".length);
    const length = /^\d+/.exec(tail)?.[0];
    return "perry_runtime::" + (length === undefined ? "other" : tail.slice(length.length, length.length + Number(length)));
  }
  if (name.startsWith("_sc_")) return "ScriptC generated program/support";
  if (name.startsWith("_scr_")) return "ScriptC runtime";
  return "other libraries/support";
}
function analyze(path: string): unknown {
  const binary = readFileSync(path);
  if (binary.readUInt32LE(0) !== 0xfeedfacf) throw new Error("Expected thin little-endian Mach-O 64: " + path);
  const str = (offset: number, length: number): string => binary.toString("utf8", offset, offset + length).split("\0")[0] ?? "";
  const u64 = (offset: number): number => Number(binary.readBigUInt64LE(offset));
  const sections: Section[] = [];
  const segments: { name: string; virtualBytes: number; fileBytes: number }[] = [];
  let command = 32;
  let symbolOffset = 0, symbolCount = 0, stringOffset = 0;
  for (let i = 0; i < binary.readUInt32LE(16); i++) {
    const kind = binary.readUInt32LE(command);
    if (kind === 0x19) {
      const segment = str(command + 8, 16);
      segments.push({ name: segment, virtualBytes: u64(command + 32), fileBytes: u64(command + 48) });
      for (let j = 0; j < binary.readUInt32LE(command + 64); j++) {
        const offset = command + 72 + j * 80;
        const flags = binary.readUInt32LE(offset + 64);
        const size = u64(offset + 40);
        sections.push({ index: sections.length + 1, segment, name: str(offset, 16),
          address: u64(offset + 32), virtualBytes: size,
          fileBytes: [1, 12, 18].includes(flags & 255) ? 0 : size, flags });
      }
    } else if (kind === 2) {
      symbolOffset = binary.readUInt32LE(command + 8);
      symbolCount = binary.readUInt32LE(command + 12);
      stringOffset = binary.readUInt32LE(command + 16);
    }
    command += binary.readUInt32LE(command + 4);
  }
  const code = sections.find(s => s.segment === "__TEXT" && s.name === "__text");
  if (code === undefined) throw new Error("Missing __text");
  const byAddress = new Map<number, string[]>();
  for (let i = 0; i < symbolCount; i++) {
    const offset = symbolOffset + i * 16;
    const type = binary.readUInt8(offset + 4);
    const section = binary.readUInt8(offset + 5);
    if ((type & 0xe0) !== 0 || (type & 0x0e) !== 0x0e || section !== code.index) continue;
    const address = u64(offset + 8);
    if (address < code.address || address >= code.address + code.virtualBytes) continue;
    const nameOffset = stringOffset + binary.readUInt32LE(offset);
    const end = binary.indexOf(0, nameOffset);
    const name = binary.toString("utf8", nameOffset, end < 0 ? binary.length : end);
    const names = byAddress.get(address) ?? [];
    names.push(name); byAddress.set(address, names);
  }
  const addresses = [...byAddress.keys()].sort((a, b) => a - b);
  const symbols: SymbolExtent[] = addresses.map((address, i) => {
    const names = byAddress.get(address) ?? [];
    return { address, bytes: (addresses[i + 1] ?? code.address + code.virtualBytes) - address, names, group: group(names) };
  });
  const groups: Record<string, number> = {};
  for (const symbol of symbols) groups[symbol.group] = (groups[symbol.group] ?? 0) + symbol.bytes;
  return {
    path, fileBytes: binary.length, segments, sections, codeBytes: code.virtualBytes,
    groupedCodeBytes: Object.fromEntries(Object.entries(groups).sort((a, b) => b[1] - a[1])),
    attributedCodeBytes: symbols.reduce((sum, s) => sum + s.bytes, 0),
    largestSymbols: [...symbols].sort((a, b) => b.bytes - a.bytes).slice(0, 40),
    generatedSymbols: symbols.filter(s => s.group.startsWith("generated ") || s.names.some(n => n.startsWith("_sc_bf_"))),
    ...(includeAllSymbols ? { symbols } : {}),
    note: "Address-delta upper bounds within __text only. Aliases share one extent; zero-fill sections consume no file bytes. Padding belongs to the preceding symbol. This is retained code, not a proof of removability.",
  };
}
const paths = process.argv.slice(2);
const allSymbolsIndex = paths.indexOf("--all-symbols");
const includeAllSymbols = allSymbolsIndex >= 0;
if (includeAllSymbols) paths.splice(allSymbolsIndex, 1);
let output = "dist/comparison/sizes.json";
if (paths[0] === "--output") {
  paths.shift();
  const requested = paths.shift();
  if (requested === undefined) throw new Error("Expected output path");
  output = requested;
}
if (paths.length === 0) throw new Error("Pass symbol-preserving Mach-O executable paths");
writeFileSync(output, JSON.stringify(paths.map(analyze), null, 2) + "\n");
console.log("Wrote " + output);
