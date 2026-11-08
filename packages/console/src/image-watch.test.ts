import { describe, expect, it } from "vitest";
import { evaluateImage, type EvaluateInput, type RegistryLike } from "./image-watch.js";
import { RegistryError } from "./registry.js";

const sha = (c: string) => "sha256:" + c.repeat(64);
const LOCAL_INDEX = sha("1");
const NEW_INDEX = sha("9");
const IMAGE_ID = sha("a");

const fakeClient = (over: Partial<Record<keyof RegistryLike, unknown>> = {}): RegistryLike & { calls: string[] } => {
  const calls: string[] = [];
  const client = {
    calls,
    headManifest: async () => {
      calls.push("head");
      return { digest: LOCAL_INDEX, mediaType: "x" };
    },
    resolvePlatform: async () => {
      calls.push("resolve");
      return { manifestDigest: sha("2"), configDigest: IMAGE_ID, indexDigest: NEW_INDEX };
    },
    configLayers: async () => {
      calls.push("layers");
      return [sha("e")];
    },
    listTags: async () => {
      calls.push("tags");
      return { tags: ["1.27.0", "1.27.1", "1.28.0", "2.0.0", "latest"], truncated: false };
    },
    ...over,
  };
  return client as never;
};

const input = (over: Partial<EvaluateInput> = {}): EvaluateInput => ({
  ref: "nginx:1.27.0",
  imageId: IMAGE_ID,
  image: { repoDigests: [`nginx@${LOCAL_INDEX}`], os: "linux", arch: "amd64" },
  policy: "same_tag",
  pattern: null,
  ...over,
});

describe("evaluateImage — même tag, contenu différent", () => {
  it("à jour quand le digest du registre est celui de l'image déployée", async () => {
    const c = fakeClient();
    const r = await evaluateImage(input(), c);
    expect(r.kind).toBe("up_to_date");
    expect(r.detail).toMatchObject({ contentChanged: false, deployedDigest: LOCAL_INDEX, remoteDigest: LOCAL_INDEX, platform: "linux/amd64" });
    expect(c.calls).toEqual(["head"]); // un seul HEAD : ni manifeste ni liste de tags
  });

  it("détecte un contenu différent pour la plateforme cible", async () => {
    const c = fakeClient({
      headManifest: async () => ({ digest: NEW_INDEX, mediaType: "x" }),
      resolvePlatform: async () => ({ manifestDigest: sha("2"), configDigest: sha("c"), indexDigest: NEW_INDEX }),
    });
    const r = await evaluateImage(input(), c);
    expect(r.kind).toBe("update_available");
    expect(r.detail).toMatchObject({ contentChanged: true, remoteDigest: NEW_INDEX });
  });

  it("ne signale pas de changement quand seul l'empaquetage diffère (mêmes couches)", async () => {
    const repackaged = fakeClient({
      headManifest: async () => ({ digest: NEW_INDEX, mediaType: "x" }),
      resolvePlatform: async () => ({ manifestDigest: sha("2"), configDigest: sha("c"), indexDigest: null }), // ni l'identifiant ni le digest locaux
      configLayers: async () => [sha("e"), sha("f")],
    });
    const r = await evaluateImage(input({ image: { repoDigests: [`nginx@${LOCAL_INDEX}`], os: "linux", arch: "amd64", layers: [sha("e"), sha("f")] } }), repackaged);
    expect(r.kind).toBe("up_to_date");
    expect(r.detail.contentChanged).toBe(false);
    expect(r.detail.notes.join(" ")).toContain("empaquetage");

    const different = fakeClient({
      headManifest: async () => ({ digest: NEW_INDEX, mediaType: "x" }),
      resolvePlatform: async () => ({ manifestDigest: sha("2"), configDigest: sha("c"), indexDigest: null }),
      configLayers: async () => [sha("e"), sha("9")],
    });
    const r2 = await evaluateImage(input({ image: { repoDigests: [`nginx@${LOCAL_INDEX}`], os: "linux", arch: "amd64", layers: [sha("e"), sha("f")] } }), different);
    expect(r2.kind).toBe("update_available");
    expect(r2.detail.contentChanged).toBe(true);
  });

  it("ignore un tag republié pour d'autres plateformes seulement (l'identifiant local correspond)", async () => {
    const c = fakeClient({ headManifest: async () => ({ digest: NEW_INDEX, mediaType: "x" }) }); // resolvePlatform renvoie notre configuration
    const r = await evaluateImage(input(), c);
    expect(r.kind).toBe("up_to_date");
    expect(r.detail.contentChanged).toBe(false);
    expect(r.detail.notes.join(" ")).toContain("d'autres plateformes");
  });

  it("signale l'incertitude quand la plateforme est inconnue ou absente du tag", async () => {
    const changed = { headManifest: async () => ({ digest: NEW_INDEX, mediaType: "x" }) };
    const noPlatform = await evaluateImage(input({ image: { repoDigests: [`nginx@${LOCAL_INDEX}`] } }), fakeClient(changed));
    expect(noPlatform.detail.contentChanged).toBeNull();
    const missing = await evaluateImage(
      input(),
      fakeClient({ ...changed, resolvePlatform: async () => { throw new RegistryError("unsupported", "Aucune variante linux/amd64 dans ce tag."); } }),
    );
    expect(missing.detail.contentChanged).toBeNull();
    expect(missing.kind).toBe("up_to_date");
  });
});

describe("evaluateImage — cas sans comparaison possible", () => {
  it("image locale sans registre", async () => {
    const c = fakeClient();
    const r = await evaluateImage(input({ ref: "monimage:dev", image: { repoDigests: [] } }), c);
    expect(r.kind).toBe("local");
    expect(c.calls).toEqual([]);
  });

  it("image épinglée par digest : aucun appel au registre", async () => {
    const c = fakeClient();
    const r = await evaluateImage(input({ ref: `nginx@${LOCAL_INDEX}` }), c);
    expect(r.kind).toBe("pinned");
    expect(r.detail.deployedDigest).toBe(LOCAL_INDEX);
    expect(c.calls).toEqual([]);
  });

  it("référence invalide ou informations d'image absentes", async () => {
    expect((await evaluateImage(input({ ref: "sha256:" + "a".repeat(64) }), fakeClient())).kind).toBe("unsupported");
    expect((await evaluateImage(input({ image: null }), fakeClient())).kind).toBe("unsupported");
  });

  it("image téléchargée depuis un autre dépôt que sa référence", async () => {
    const r = await evaluateImage(input({ image: { repoDigests: [`ghcr.io/o/autre@${LOCAL_INDEX}`] } }), fakeClient());
    expect(r.kind).toBe("local");
  });
});

describe("evaluateImage — nouveaux tags selon la politique", () => {
  it("propose des tags plus récents sans toucher au contenu du tag actuel", async () => {
    const r = await evaluateImage(input({ policy: "minor" }), fakeClient());
    expect(r.kind).toBe("update_available");
    expect(r.detail).toMatchObject({ contentChanged: false, candidates: ["1.28.0", "1.27.1"], uncertain: false, policy: "minor" });
  });

  it("applique la politique patch : même mineure uniquement", async () => {
    const r = await evaluateImage(input({ policy: "patch" }), fakeClient());
    expect(r.detail.candidates).toEqual(["1.27.1"]);
  });

  it("n'interroge pas la liste des tags pour la politique « même tag »", async () => {
    const c = fakeClient();
    await evaluateImage(input({ policy: "same_tag" }), c);
    expect(c.calls).not.toContain("tags");
  });

  it("tag flottant : seul le contenu compte, et l'incertitude est signalée", async () => {
    const c = fakeClient();
    const r = await evaluateImage(input({ ref: "nginx:latest", policy: "major" }), c);
    expect(r.detail.candidates).toEqual([]);
    expect(r.detail.uncertain).toBe(true);
    expect(r.kind).toBe("up_to_date");
  });

  it("ignore une expression de suivi invalide sans interroger le registre", async () => {
    const c = fakeClient();
    const r = await evaluateImage(input({ policy: "pattern", pattern: "(a+)+" }), c);
    expect(r.detail.notes.join(" ")).toContain("invalide");
    expect(c.calls).not.toContain("tags");
  });

  it("signale une liste de tags tronquée", async () => {
    const r = await evaluateImage(input({ policy: "major" }), fakeClient({ listTags: async () => ({ tags: ["9.0.0"], truncated: true }) }));
    expect(r.detail.tagsTruncated).toBe(true);
    expect(r.detail.notes.join(" ")).toContain("tronquée");
  });
});

describe("evaluateImage — erreurs du registre", () => {
  it("propage l'erreur (l'appelant conserve la dernière observation)", async () => {
    const down = fakeClient({ headManifest: async () => { throw new RegistryError("rate_limited", "Limite de requêtes du registre atteinte.", 30); } });
    await expect(evaluateImage(input(), down)).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("evaluateImage — image de base d'un service construit", () => {
  const built = { dockerfile: "build/app/Dockerfile" };

  it("marque la vérification comme portant sur l'image de base et compare son contenu", async () => {
    const r = await evaluateImage(input({ built, tagsOnly: true }), fakeClient());
    expect(r.kind).toBe("up_to_date");
    expect(r.detail.built).toEqual(built);
  });

  it("image de base absente de l'hôte : cherche quand même les nouvelles versions de tag", async () => {
    const c = fakeClient();
    const r = await evaluateImage(input({ built, tagsOnly: true, image: null, imageId: "", policy: "major" }), c);
    expect(r.kind).toBe("update_available");
    expect(r.detail.candidates[0]).toBe("2.0.0");
    expect(r.detail.contentChanged).toBeNull();
    expect(r.detail.notes.join(" ")).toMatch(/absente de l'hôte/);
    expect(c.calls).toEqual(["tags"]); // pas de HEAD : aucun digest local à comparer
  });

  it("sans tagsOnly, une image absente reste non comparable (comportement inchangé)", async () => {
    const r = await evaluateImage(input({ image: null }), fakeClient());
    expect(r.kind).toBe("unsupported");
  });
});

describe("evaluateImage — versions plus anciennes écartées", () => {
  const dates: Record<string, number> = { "cfg-1.27.0": Date.UTC(2025, 5, 1), "cfg-1.27.1": Date.UTC(2025, 6, 1), "cfg-1.28.0": Date.UTC(2025, 8, 1), "cfg-2.0.0": Date.UTC(2020, 1, 1) };
  const dated = () =>
    fakeClient({
      resolvePlatform: async (_ref: unknown, tag: string) => ({ manifestDigest: sha("2"), configDigest: `cfg-${tag}`, indexDigest: null }),
      configCreated: async (_ref: unknown, digest: string) => dates[digest] ?? null,
    });

  it("n'annonce pas une version au numéro plus grand mais plus ancienne", async () => {
    const r = await evaluateImage(input({ policy: "major" }), dated());
    expect(r.detail.candidates).toEqual(["1.28.0", "1.27.1"]);
    expect(r.detail.candidates).not.toContain("2.0.0");
    expect(r.detail.notes.join(" ")).toMatch(/2\.0\.0/);
    expect(r.kind).toBe("update_available");
  });

  it("à jour quand tous les candidats sont plus anciens", async () => {
    const onlyOld = fakeClient({
      listTags: async () => ({ tags: ["2.0.0"], truncated: false }),
      resolvePlatform: async (_ref: unknown, tag: string) => ({ manifestDigest: sha("2"), configDigest: `cfg-${tag}`, indexDigest: null }),
      configCreated: async (_ref: unknown, digest: string) => dates[digest] ?? null,
    });
    const r = await evaluateImage(input({ policy: "major" }), onlyOld);
    expect(r.detail.candidates).toEqual([]);
    expect(r.kind).toBe("up_to_date");
  });
});
