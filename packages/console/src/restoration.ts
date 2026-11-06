import { generateIdentity, identityToRecipient } from "age-encryption";

export interface RestorationKey {
  /** Clé privée (AGE-SECRET-KEY-…) : à remettre une seule fois, jamais stockée. */
  identity: string;
  /** Clé publique (age1…) : sert à chiffrer les secrets exportés vers Git. */
  recipient: string;
}

export async function createRestorationKey(): Promise<RestorationKey> {
  const identity = await generateIdentity();
  return { identity, recipient: await identityToRecipient(identity) };
}
