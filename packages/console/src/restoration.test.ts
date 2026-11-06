import { Decrypter, Encrypter } from "age-encryption";
import { describe, expect, it } from "vitest";
import { createRestorationKey } from "./restoration.js";

describe("clé de restauration", () => {
  it("chiffre avec la clé publique et déchiffre avec la clé privée", async () => {
    const key = await createRestorationKey();
    const enc = new Encrypter();
    enc.addRecipient(key.recipient);
    const ciphertext = await enc.encrypt("DATABASE_URL=postgres://secret");

    const dec = new Decrypter();
    dec.addIdentity(key.identity);
    expect(await dec.decrypt(ciphertext, "text")).toBe("DATABASE_URL=postgres://secret");
  });

  it("refuse de déchiffrer avec une autre clé", async () => {
    const [a, b] = [await createRestorationKey(), await createRestorationKey()];
    const enc = new Encrypter();
    enc.addRecipient(a.recipient);
    const ciphertext = await enc.encrypt("x");
    const dec = new Decrypter();
    dec.addIdentity(b.identity);
    await expect(dec.decrypt(ciphertext, "text")).rejects.toThrow();
  });
});
