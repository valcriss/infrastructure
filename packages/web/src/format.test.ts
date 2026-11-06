import { describe, expect, it } from "vitest";
import { ago, formatBytes } from "./api";

describe("ago", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  it("formate des durées relatives lisibles", () => {
    expect(ago(null, now)).toBe("jamais");
    expect(ago("2026-11-06T11:59:58Z", now)).toBe("à l'instant");
    expect(ago("2026-11-06T11:59:15Z", now)).toBe("il y a 45 s");
    expect(ago("2026-11-06T11:55:00Z", now)).toBe("il y a 5 min");
    expect(ago("2026-11-06T09:00:00Z", now)).toBe("il y a 3 h");
    expect(ago("2026-11-04T12:00:00Z", now)).toBe("il y a 2 j");
  });
});

describe("formatBytes", () => {
  it("utilise des unités binaires avec une précision adaptée", () => {
    expect(formatBytes(512)).toBe("512 o");
    expect(formatBytes(2048)).toBe("2.0 Kio");
    expect(formatBytes(50 * 1024 * 1024)).toBe("50.0 Mio");
    expect(formatBytes(512 * 1024 * 1024)).toBe("512 Mio");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 Gio");
  });
});
