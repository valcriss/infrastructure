import { describe, expect, it } from "vitest";
import { LoginLimiter } from "./auth.js";
import { hashPassword, randomToken, sha256, verifyPassword } from "./crypto.js";

describe("mots de passe", () => {
  it("vérifie un mot de passe correct et rejette un mauvais", async () => {
    const hash = await hashPassword("un-mot-de-passe-solide");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword("un-mot-de-passe-solide", hash)).toBe(true);
    expect(await verifyPassword("autre-mot-de-passe", hash)).toBe(false);
  });

  it("produit des hash différents (sel aléatoire)", async () => {
    const [a, b] = await Promise.all([hashPassword("identique-12345"), hashPassword("identique-12345")]);
    expect(a).not.toBe(b);
  });

  it("rejette un hash mal formé sans lever d'exception", async () => {
    expect(await verifyPassword("x", "n'importe quoi")).toBe(false);
  });
});

describe("jetons", () => {
  it("génère des jetons uniques de forte entropie", () => {
    expect(randomToken()).not.toBe(randomToken());
    expect(randomToken().length).toBeGreaterThanOrEqual(43);
  });
  it("calcule une empreinte stable", () => {
    expect(sha256("a")).toBe(sha256("a"));
    expect(sha256("a")).not.toBe(sha256("b"));
  });
});

describe("LoginLimiter", () => {
  it("bloque après 5 échecs puis libère après la fenêtre", () => {
    let now = 0;
    const l = new LoginLimiter(5, 1000, () => now);
    for (let i = 0; i < 5; i++) l.recordFailure("k");
    expect(l.isBlocked("k")).toBe(true);
    now = 1001;
    expect(l.isBlocked("k")).toBe(false);
  });
  it("réinitialise après un succès", () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 5; i++) l.recordFailure("k");
    l.reset("k");
    expect(l.isBlocked("k")).toBe(false);
  });
});
