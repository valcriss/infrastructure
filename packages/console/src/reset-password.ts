// Réinitialisation du mot de passe d'un compte depuis le conteneur de la console, quand plus personne ne peut se connecter :
//   docker compose exec -it console node packages/console/dist/reset-password.js
// L'identifiant (e-mail ou ancien identifiant) est demandé, puis le mot de passe, saisi sans écho et confirmé.
import { createInterface } from "node:readline/promises";
import { PasswordSchema } from "@infra/shared";
import { hashPassword } from "./crypto.js";
import { audit, createPool } from "./db.js";

/** Lit une ligne sans l'afficher (mode brut du terminal). */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      reject(new Error("Terminal interactif requis : utilisez « docker compose exec -it »."));
      return;
    }
    process.stdout.write(prompt);
    let value = "";
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          input.off("data", onData);
          input.setRawMode(false);
          input.pause();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          input.setRawMode(false);
          process.stdout.write("\n");
          reject(new Error("Annulé."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL absent : lancez ce script dans le conteneur de la console.");
  const pool = createPool(databaseUrl);
  try {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const login = (await rl.question("Identifiant (e-mail ou identifiant d'origine) : ")).trim().toLowerCase();
    rl.close();
    const found = await pool.query<{ id: string; email: string; role: string; totp_enabled: boolean }>(
      "SELECT id, email, role, totp_enabled FROM users WHERE lower(email) = $1 OR lower(username) = $1",
      [login],
    );
    const user = found.rows[0];
    if (!login || !user) throw new Error("Aucun compte avec cet identifiant.");

    const password = await readSecret("Nouveau mot de passe (12 caractères minimum) : ");
    const parsed = PasswordSchema.safeParse(password);
    if (!parsed.success) throw new Error("Mot de passe refusé : entre 12 et 256 caractères.");
    if ((await readSecret("Confirmez le mot de passe : ")) !== password) throw new Error("Les mots de passe diffèrent.");

    let disableMfa = false;
    if (user.totp_enabled) {
      const rl2 = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl2.question("Un deuxième facteur (TOTP) est actif. Le désactiver aussi ? [o/N] ")).trim().toLowerCase();
      rl2.close();
      disableMfa = answer === "o" || answer === "oui" || answer === "y";
    }

    await pool.query(
      "UPDATE users SET password_hash = $2, must_change_password = false, active = true, updated_at = now() WHERE id = $1",
      [user.id, await hashPassword(password)],
    );
    if (disableMfa) {
      await pool.query("UPDATE users SET totp_secret = NULL, totp_enabled = false, totp_last_step = NULL WHERE id = $1", [user.id]);
      await pool.query("DELETE FROM recovery_codes WHERE user_id = $1", [user.id]);
    }
    // Les sessions ouvertes avec l'ancien mot de passe sont fermées.
    await pool.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
    await audit(pool, "cli", disableMfa ? "user.password-reset+mfa-disable" : "user.password-reset", user.email, "success");
    console.log(`Mot de passe de ${user.email} (${user.role}) réinitialisé ; sessions fermées.`);
    if (disableMfa) console.log("Deuxième facteur et codes de secours désactivés.");
    else if (user.totp_enabled) {
      console.log("Le deuxième facteur reste actif : il faudra toujours un code à la connexion.");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
