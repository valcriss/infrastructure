import { describe, expect, it } from "vitest";
import { cpuUsage, parseCpuStat, parseMeminfo } from "./host-metrics.js";

describe("métriques de l'hôte", () => {
  it("lit /proc/stat et calcule l'occupation entre deux relevés", () => {
    const a = parseCpuStat("cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 1 1 1 1 0 0 0\n");
    const b = parseCpuStat("cpu  200 0 200 800 100 0 0 0 0 0\n");
    expect(a).toEqual({ total: 1000, idle: 800 });
    // +200 occupés sur +300 de temps total : 66,7 %
    expect(cpuUsage(a, b)).toBeCloseTo(66.7, 1);
  });

  it("ne donne rien sans relevé précédent ou si les compteurs repartent de zéro", () => {
    expect(cpuUsage(null, { total: 10, idle: 5 })).toBeNull();
    expect(cpuUsage({ total: 100, idle: 50 }, { total: 90, idle: 40 })).toBeNull();
    expect(parseCpuStat("n'importe quoi")).toBeNull();
  });

  it("calcule la mémoire utilisée à partir de MemAvailable (le cache récupérable ne compte pas)", () => {
    const mem = parseMeminfo("MemTotal:       8000000 kB\nMemFree:         500000 kB\nMemAvailable:   6000000 kB\n");
    expect(mem).toEqual({ total: 8000000 * 1024, used: 2000000 * 1024 });
    expect(parseMeminfo("MemTotal: 1 kB\n")).toBeNull();
  });
});
