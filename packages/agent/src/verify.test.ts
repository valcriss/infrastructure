import type { VerifyCheck } from "@infra/shared";
import { describe, expect, it } from "vitest";
import { evaluateRun, runVerify, verifyRunArgs, type VerifyExec } from "./verify.js";

const check = (over: Partial<VerifyCheck> = {}): VerifyCheck => ({ command: ["nginx", "-t"], expectExit: 0, outputContains: null, ...over });

describe("conteneur de vérification : isolation", () => {
  const args = verifyRunArgs("n", "alpine:3.22", ["nginx", "-t"]);

  it("n'a ni réseau, ni écriture, ni capacités, ni élévation de privilèges, ni téléchargement", () => {
    const flag = (name: string): string | undefined => args[args.indexOf(name) + 1];
    expect(flag("--network")).toBe("none");
    expect(args).toContain("--read-only");
    expect(flag("--cap-drop")).toBe("ALL");
    expect(flag("--security-opt")).toBe("no-new-privileges");
    expect(flag("--pull")).toBe("never");
    expect(flag("--pids-limit")).toBe("64");
    expect(flag("--memory")).toBe("256m");
    expect(flag("--tmpfs")).toContain("noexec");
  });

  it("ne monte aucun volume et ne transmet aucune variable d'environnement de l'application", () => {
    for (const forbidden of ["-v", "--volume", "--mount", "-e", "--env", "--env-file", "--privileged", "-p", "--publish", "--network=host", "--user"]) expect(args).not.toContain(forbidden);
  });

  it("place l'image avant la commande, sans shell, et nomme le conteneur", () => {
    expect(args.slice(args.indexOf("alpine:3.22"))).toEqual(["alpine:3.22", "nginx", "-t"]);
    expect(args).not.toContain("sh");
    expect(args.slice(0, 3)).toEqual(["run", "--name", "n"]);
    // Une option déguisée en argument reste un argument de la commande : elle suit l'image.
    const sneaky = verifyRunArgs("n", "alpine:3.22", ["--privileged", "-v", "/:/host"]);
    expect(sneaky.indexOf("--privileged")).toBeGreaterThan(sneaky.indexOf("alpine:3.22"));
  });
});

describe("résultat d'une vérification", () => {
  it("réussit sur le code attendu, et le signale", () => {
    expect(evaluateRun(check(), { code: 0, timedOut: false, output: "ok" })).toEqual({ ok: true, exitCode: 0, timedOut: false, outputMatched: null });
    expect(evaluateRun(check({ expectExit: 3 }), { code: 3, timedOut: false, output: "" }).ok).toBe(true);
    expect(evaluateRun(check(), { code: 1, timedOut: false, output: "" })).toMatchObject({ ok: false, exitCode: 1 });
    expect(evaluateRun(check(), { code: 127, timedOut: false, output: "" }).ok).toBe(false); // commande introuvable
  });

  it("exige le texte attendu (comparaison littérale) quand il est demandé, sans jamais renvoyer la sortie", () => {
    const c = check({ outputContains: "syntax is ok" });
    expect(evaluateRun(c, { code: 0, timedOut: false, output: "nginx: the configuration file syntax is ok" })).toMatchObject({ ok: true, outputMatched: true });
    expect(evaluateRun(c, { code: 0, timedOut: false, output: "erreur" })).toMatchObject({ ok: false, outputMatched: false });
    // Pas d'expression régulière : « . » n'est qu'un point.
    expect(evaluateRun(check({ outputContains: "1.2" }), { code: 0, timedOut: false, output: "version 1x2" }).outputMatched).toBe(false);
    expect(Object.keys(evaluateRun(c, { code: 0, timedOut: false, output: "secret-dans-la-sortie" })).sort()).toEqual(["exitCode", "ok", "outputMatched", "timedOut"]);
  });

  it("un délai dépassé échoue, sans code de sortie", () => {
    expect(evaluateRun(check(), { code: null, timedOut: true, output: "" })).toEqual({ ok: false, exitCode: null, timedOut: true, outputMatched: null });
    expect(evaluateRun(check(), { code: 0, timedOut: true, output: "" }).ok).toBe(false);
  });

  it("supprime toujours le conteneur, même quand la commande échoue", async () => {
    const calls: string[][] = [];
    const exec: VerifyExec = async (args) => {
      calls.push(args);
      return { code: args[0] === "run" ? 1 : 0, timedOut: false, stdout: "", tail: "" };
    };
    expect((await runVerify(exec, "ctr", "img", check())).ok).toBe(false);
    expect(calls.map((c) => c[0])).toEqual(["run", "rm"]);
    expect(calls[1]).toEqual(["rm", "-f", "ctr"]);
  });
});
