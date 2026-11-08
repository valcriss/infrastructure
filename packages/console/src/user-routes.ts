import { PasswordSchema } from "@infra/shared";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { SESSION_COOKIE, createSession, type AuthUser, type LoginLimiter } from "./auth.js";
import type { Config } from "./config.js";
import { hashPassword, randomToken, sha256, verifyPassword } from "./crypto.js";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { ChallengeStore, consumeRecoveryCode, consumeTotp, newTotpSecret, otpauthUrl, regenerateRecoveryCodes } from "./mfa.js";
import { ROLES, type Role } from "./permissions.js";
import type { SecretBox } from "./secretbox.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const ISSUER = "Console Docker";
/** Un deuxième facteur présenté depuis moins de ce délai suffit pour ouvrir un terminal. */
export const STEP_UP_MAX_AGE_MS = 10 * 60_000;

const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const RoleSchema = z.enum(ROLES as unknown as [Role, ...Role[]]);
const IdParams = z.object({ id: z.uuid() });

export const CreateUserBody = z.object({
  email: Email,
  displayName: z.string().trim().max(100).default(""),
  role: RoleSchema,
  terminalAllowed: z.boolean().default(false),
});
export const UpdateUserBody = z.object({
  displayName: z.string().trim().max(100).optional(),
  role: RoleSchema.optional(),
  terminalAllowed: z.boolean().optional(),
  active: z.boolean().optional(),
});

interface DbUser {
  id: string;
  email: string;
  username: string | null;
  display_name: string;
  role: Role;
  terminal_allowed: boolean;
  password_hash: string | null;
  must_change_password: boolean;
  totp_secret: string | null;
  totp_enabled: boolean;
  active: boolean;
  created_at: Date;
  last_login_at: Date | null;
  passkeys: number;
}

const USER_SELECT = `SELECT u.*, (SELECT count(*)::int FROM passkeys p WHERE p.user_id = u.id) AS passkeys FROM users u`;

const view = (u: DbUser) => ({
  id: u.id,
  email: u.email,
  username: u.username,
  displayName: u.display_name,
  role: u.role,
  terminalAllowed: u.terminal_allowed,
  active: u.active,
  hasPassword: u.password_hash !== null,
  mustChangePassword: u.must_change_password,
  totpEnabled: u.totp_enabled,
  passkeys: u.passkeys,
  createdAt: u.created_at.toISOString(),
  lastLoginAt: u.last_login_at?.toISOString() ?? null,
});

/** Description de la session pour l'interface (droits, état du deuxième facteur). */
export function sessionInfo(user: AuthUser, config: Config) {
  return {
    username: user.username ?? user.email,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    terminalAllowed: user.terminalAllowed,
    mustChangePassword: user.mustChangePassword,
    totpEnabled: user.totpEnabled,
    passkeysAvailable: Boolean(config.webauthnRpId && config.webauthnOrigin),
    mfaRecent: user.mfaAt !== null && Date.now() - user.mfaAt.getTime() <= STEP_UP_MAX_AGE_MS,
  };
}

export function registerUserRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; config: Config; box: SecretBox; auth: Guard; limiter: LoginLimiter },
): { challenges: ChallengeStore } {
  const { pool, config, box, auth, limiter } = deps;
  const challenges = new ChallengeStore();
  const rpID = config.webauthnRpId ?? "";
  const origin = config.webauthnOrigin ?? "";
  const passkeysOn = Boolean(rpID && origin);
  const requirePasskeys = (): void => {
    if (!passkeysOn) throw new HttpError(409, "passkeys_disabled", "Les clés d'accès ne sont pas configurées (WEBAUTHN_RP_ID et WEBAUTHN_ORIGIN).");
  };
  const me = (request: FastifyRequest): AuthUser => {
    if (!request.user) throw new HttpError(401, "unauthorized", "Authentification requise");
    return request.user;
  };
  const getUser = async (id: string): Promise<DbUser> => {
    const { rows } = await pool.query<DbUser>(`${USER_SELECT} WHERE u.id = $1`, [id]);
    if (!rows[0]) throw new HttpError(404, "user_not_found", "Utilisateur introuvable");
    return rows[0];
  };
  const activeAdmins = async (): Promise<number> => ((await pool.query("SELECT 1 FROM users WHERE role = 'admin' AND active")).rowCount ?? 0);

  // --- Administration des utilisateurs -------------------------------------------------------------

  app.get("/api/v1/users", { preHandler: auth }, async () => {
    const { rows } = await pool.query<DbUser>(`${USER_SELECT} ORDER BY lower(u.email)`);
    return { users: rows.map(view) };
  });

  app.post("/api/v1/users", { preHandler: auth }, async (request, reply) => {
    const body = CreateUserBody.parse(request.body);
    const temporaryPassword = randomToken(12);
    try {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, display_name, role, terminal_allowed, password_hash, must_change_password)
         VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
        [body.email, body.displayName, body.role, body.terminalAllowed, await hashPassword(temporaryPassword)],
      );
      await audit(pool, request.actor, "user.create", body.email, "success");
      reply.header("Cache-Control", "no-store");
      return reply.code(201).send({ user: view(await getUser(rows[0]?.id ?? "")), temporaryPassword });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new HttpError(409, "email_taken", "Un utilisateur porte déjà cet e-mail");
      throw err;
    }
  });

  app.patch("/api/v1/users/:id", { preHandler: auth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = UpdateUserBody.parse(request.body);
    const target = await getUser(id);
    const self = me(request).id === id;
    const losesAdmin = (body.role !== undefined && body.role !== "admin" && target.role === "admin") || (body.active === false && target.role === "admin" && target.active);
    if (self && (losesAdmin || body.active === false)) {
      throw new HttpError(409, "self_lockout", "Vous ne pouvez pas retirer vos propres droits d'administrateur ni désactiver votre compte.");
    }
    if (losesAdmin && (await activeAdmins()) <= 1) throw new HttpError(409, "last_admin", "Il doit rester au moins un administrateur actif.");
    await pool.query(
      `UPDATE users SET display_name = COALESCE($2, display_name), role = COALESCE($3, role),
              terminal_allowed = COALESCE($4, terminal_allowed), active = COALESCE($5, active), updated_at = now()
        WHERE id = $1`,
      [id, body.displayName ?? null, body.role ?? null, body.terminalAllowed ?? null, body.active ?? null],
    );
    if (body.active === false) await pool.query("DELETE FROM sessions WHERE user_id = $1", [id]);
    await audit(pool, request.actor, "user.update", target.email, "success");
    return { user: view(await getUser(id)) };
  });

  // Remet le compte à zéro : mot de passe provisoire, deuxième facteur et clés d'accès effacés, sessions fermées.
  app.post("/api/v1/users/:id/reset-access", { preHandler: auth }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const target = await getUser(id);
    const temporaryPassword = randomToken(12);
    await pool.query(
      `UPDATE users SET password_hash = $2, must_change_password = true, totp_secret = NULL, totp_enabled = false,
              totp_last_step = NULL, updated_at = now() WHERE id = $1`,
      [id, await hashPassword(temporaryPassword)],
    );
    await pool.query("DELETE FROM passkeys WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM recovery_codes WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM sessions WHERE user_id = $1", [id]);
    await audit(pool, request.actor, "user.reset-access", target.email, "success");
    reply.header("Cache-Control", "no-store");
    return { user: view(await getUser(id)), temporaryPassword };
  });

  app.delete("/api/v1/users/:id", { preHandler: auth }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const target = await getUser(id);
    if (me(request).id === id) throw new HttpError(409, "self_lockout", "Vous ne pouvez pas supprimer votre propre compte.");
    if (target.role === "admin" && target.active && (await activeAdmins()) <= 1) throw new HttpError(409, "last_admin", "Il doit rester au moins un administrateur actif.");
    await pool.query("DELETE FROM users WHERE id = $1", [id]);
    await audit(pool, request.actor, "user.delete", target.email, "success");
    return reply.code(204).send();
  });

  // --- Mon compte ----------------------------------------------------------------------------------

  app.patch("/api/v1/me/profile", { preHandler: auth }, async (request) => {
    const body = z.object({ displayName: z.string().trim().max(100) }).parse(request.body);
    await pool.query("UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1", [me(request).id, body.displayName]);
    return { displayName: body.displayName };
  });

  app.get("/api/v1/me/security", { preHandler: auth }, async (request) => {
    const user = me(request);
    const keys = await pool.query<{ id: string; name: string; created_at: Date; last_used_at: Date | null; transports: string[] }>(
      "SELECT id, name, created_at, last_used_at, transports FROM passkeys WHERE user_id = $1 ORDER BY created_at",
      [user.id],
    );
    const codes = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL", [user.id]);
    return {
      ...sessionInfo(user, config),
      recoveryCodesRemaining: codes.rows[0]?.n ?? 0,
      passkeys: keys.rows.map((k) => ({ id: k.id, name: k.name, createdAt: k.created_at.toISOString(), lastUsedAt: k.last_used_at?.toISOString() ?? null, transports: k.transports })),
    };
  });

  // Vérifie une preuve récente d'identité avant une action sensible : mot de passe, ou deuxième facteur récent.
  const confirmIdentity = async (request: FastifyRequest, currentPassword: string | undefined): Promise<void> => {
    const user = me(request);
    const { rows } = await pool.query<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id = $1", [user.id]);
    const hash = rows[0]?.password_hash;
    if (hash) {
      if (!currentPassword || !(await verifyPassword(currentPassword, hash))) throw new HttpError(403, "invalid_credentials", "Mot de passe actuel invalide");
    } else if (!sessionInfo(user, config).mfaRecent) {
      throw new HttpError(403, "step_up_required", "Confirmez d'abord votre identité avec un deuxième facteur.");
    }
  };

  // TOTP : le secret est créé « en attente » puis activé par un premier code valide.
  app.post("/api/v1/me/totp", { preHandler: auth }, async (request, reply) => {
    const user = me(request);
    if (user.totpEnabled) throw new HttpError(409, "totp_enabled", "Un code à usage unique est déjà configuré.");
    const secret = newTotpSecret();
    await pool.query("UPDATE users SET totp_secret = $2, totp_enabled = false WHERE id = $1", [user.id, box.seal(secret)]);
    reply.header("Cache-Control", "no-store");
    return { secret, otpauthUrl: otpauthUrl(secret, user.email, ISSUER) };
  });

  app.post("/api/v1/me/totp/confirm", { preHandler: auth }, async (request, reply) => {
    const user = me(request);
    const { code } = z.object({ code: z.string().min(6).max(8) }).parse(request.body);
    const { rows } = await pool.query<{ totp_secret: string | null; totp_enabled: boolean }>("SELECT totp_secret, totp_enabled FROM users WHERE id = $1", [user.id]);
    const sealed = rows[0]?.totp_secret;
    if (!sealed || rows[0]?.totp_enabled) throw new HttpError(409, "totp_not_pending", "Aucune configuration TOTP en attente.");
    if (!(await consumeTotp(pool, user.id, box.open(sealed), code))) throw new HttpError(400, "invalid_code", "Code invalide");
    await pool.query("UPDATE users SET totp_enabled = true WHERE id = $1", [user.id]);
    await pool.query("UPDATE sessions SET mfa_at = now() WHERE id_hash = $1", [sha256(request.cookies[SESSION_COOKIE] ?? "")]);
    const recoveryCodes = await regenerateRecoveryCodes(pool, user.id);
    await audit(pool, request.actor, "totp.enable", null, "success");
    reply.header("Cache-Control", "no-store");
    return { recoveryCodes };
  });

  app.delete("/api/v1/me/totp", { preHandler: auth }, async (request, reply) => {
    const body = z.object({ currentPassword: z.string().max(256).optional() }).parse(request.body ?? {});
    await confirmIdentity(request, body.currentPassword);
    await pool.query("UPDATE users SET totp_secret = NULL, totp_enabled = false, totp_last_step = NULL WHERE id = $1", [me(request).id]);
    await audit(pool, request.actor, "totp.disable", null, "success");
    return reply.code(204).send();
  });

  app.post("/api/v1/me/recovery-codes", { preHandler: auth }, async (request, reply) => {
    const user = me(request);
    const body = z.object({ currentPassword: z.string().max(256).optional() }).parse(request.body ?? {});
    const keys = (await pool.query("SELECT 1 FROM passkeys WHERE user_id = $1", [user.id])).rowCount ?? 0;
    if (!user.totpEnabled && keys === 0) throw new HttpError(409, "no_second_factor", "Configurez d'abord un code à usage unique ou une clé d'accès.");
    await confirmIdentity(request, body.currentPassword);
    reply.header("Cache-Control", "no-store");
    return { recoveryCodes: await regenerateRecoveryCodes(pool, user.id) };
  });

  // Deuxième facteur « récent » pour les actions sensibles (ouverture d'un terminal).
  const markStepUp = (request: FastifyRequest) => pool.query("UPDATE sessions SET mfa_at = now() WHERE id_hash = $1", [sha256(request.cookies[SESSION_COOKIE] ?? "")]);

  app.post("/api/v1/me/step-up", { preHandler: auth }, async (request, reply) => {
    const user = me(request);
    const { code } = z.object({ code: z.string().min(6).max(16) }).parse(request.body);
    const key = `step-up|${user.id}`;
    if (limiter.isBlocked(key)) return reply.code(429).send({ error: { code: "too_many_attempts", message: "Trop de tentatives, réessayez plus tard" } });
    const { rows } = await pool.query<{ totp_secret: string | null; totp_enabled: boolean }>("SELECT totp_secret, totp_enabled FROM users WHERE id = $1", [user.id]);
    const sealed = rows[0]?.totp_enabled ? rows[0].totp_secret : null;
    const ok = (sealed !== null && sealed !== undefined && (await consumeTotp(pool, user.id, box.open(sealed), code))) || (await consumeRecoveryCode(pool, user.id, code));
    if (!ok) {
      limiter.recordFailure(key);
      await audit(pool, request.actor, "step-up", null, "failure");
      throw new HttpError(401, "invalid_code", "Code invalide");
    }
    limiter.reset(key);
    await markStepUp(request);
    return reply.code(204).send();
  });

  // --- Clés d'accès (WebAuthn) -----------------------------------------------------------------------

  app.post("/api/v1/me/passkeys/options", { preHandler: auth }, async (request) => {
    requirePasskeys();
    const user = me(request);
    const existing = await pool.query<{ credential_id: string; transports: string[] }>("SELECT credential_id, transports FROM passkeys WHERE user_id = $1", [user.id]);
    const options = await generateRegistrationOptions({
      rpName: ISSUER,
      rpID,
      userName: user.email,
      userDisplayName: user.displayName || user.email,
      userID: new TextEncoder().encode(user.id),
      attestationType: "none",
      excludeCredentials: existing.rows.map((r) => ({ id: r.credential_id, transports: r.transports })),
      // Clé « avec identifiant » : la saisie de l'e-mail reste obligatoire ; la vérification de l'utilisateur est exigée.
      authenticatorSelection: { residentKey: "discouraged", userVerification: "required" },
    });
    return { challengeId: challenges.put(options.challenge, "register", user.id), options };
  });

  app.post("/api/v1/me/passkeys", { preHandler: auth }, async (request, reply) => {
    requirePasskeys();
    const user = me(request);
    const body = z.object({ challengeId: z.string().max(64), name: z.string().trim().min(1).max(60), response: z.record(z.string(), z.unknown()) }).parse(request.body);
    const challenge = challenges.take(body.challengeId, "register");
    if (!challenge || challenge.userId !== user.id) throw new HttpError(400, "challenge_expired", "Demande expirée, recommencez.");
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response: body.response as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch (err) {
      throw new HttpError(400, "invalid_passkey", `Clé d'accès refusée : ${(err as Error).message}`);
    }
    if (!verified.verified) throw new HttpError(400, "invalid_passkey", "Clé d'accès refusée.");
    const c = verified.registrationInfo.credential;
    try {
      await pool.query(
        "INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, name) VALUES ($1, $2, $3, $4, $5, $6)",
        [user.id, c.id, Buffer.from(c.publicKey).toString("base64url"), c.counter, c.transports ?? [], body.name],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new HttpError(409, "passkey_exists", "Cette clé est déjà enregistrée.");
      throw err;
    }
    await markStepUp(request);
    await audit(pool, request.actor, "passkey.add", body.name, "success");
    return reply.code(201).send({ ok: true });
  });

  app.patch("/api/v1/me/passkeys/:id", { preHandler: auth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(request.body);
    const res = await pool.query("UPDATE passkeys SET name = $3 WHERE id = $1 AND user_id = $2", [id, me(request).id, name]);
    if ((res.rowCount ?? 0) === 0) throw new HttpError(404, "passkey_not_found", "Clé introuvable");
    return { name };
  });

  app.delete("/api/v1/me/passkeys/:id", { preHandler: auth }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const user = me(request);
    const keys = (await pool.query("SELECT 1 FROM passkeys WHERE user_id = $1", [user.id])).rowCount ?? 0;
    if (keys <= 1 && !user.hasPassword) throw new HttpError(409, "last_method", "Impossible de supprimer votre seul moyen de connexion.");
    const res = await pool.query("DELETE FROM passkeys WHERE id = $1 AND user_id = $2", [id, user.id]);
    if ((res.rowCount ?? 0) === 0) throw new HttpError(404, "passkey_not_found", "Clé introuvable");
    await audit(pool, request.actor, "passkey.remove", id, "success");
    return reply.code(204).send();
  });

  // Défi de connexion par clé d'accès : l'e-mail est obligatoire ; la réponse ne révèle pas si le compte existe.
  const authOptions = async (userId: string | null, email: string, purpose: string) => {
    const keys = userId ? await pool.query<{ credential_id: string; transports: string[] }>("SELECT credential_id, transports FROM passkeys WHERE user_id = $1", [userId]) : { rows: [] };
    const allowCredentials = keys.rows.length > 0
      ? keys.rows.map((r) => ({ id: r.credential_id, transports: r.transports }))
      : [{ id: Buffer.from(box.hmac(`fake|${email}`), "hex").toString("base64url") }];
    const options = await generateAuthenticationOptions({ rpID, allowCredentials, userVerification: "required" });
    return { challengeId: challenges.put(options.challenge, purpose, keys.rows.length > 0 ? userId : null), options };
  };

  app.post("/api/v1/session/passkey/options", async (request, reply) => {
    requirePasskeys();
    const { email } = z.object({ email: z.string().trim().toLowerCase().max(254) }).parse(request.body);
    const key = `passkey|${request.ip}`;
    if (limiter.isBlocked(key)) return reply.code(429).send({ error: { code: "too_many_attempts", message: "Trop de tentatives, réessayez plus tard" } });
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE (lower(email) = $1 OR lower(username) = $1) AND active", [email]);
    return authOptions(rows[0]?.id ?? null, email, "login");
  });

  const verifyAssertion = async (userId: string, response: AuthenticationResponseJSON, expectedChallenge: string): Promise<boolean> => {
    const { rows } = await pool.query<{ id: string; public_key: string; counter: string; transports: string[] }>(
      "SELECT id, public_key, counter, transports FROM passkeys WHERE user_id = $1 AND credential_id = $2",
      [userId, response.id],
    );
    const key = rows[0];
    if (!key) return false;
    try {
      const verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: response.id,
          publicKey: Buffer.from(key.public_key, "base64url"),
          counter: Number(key.counter),
          transports: key.transports as never,
        },
      });
      if (!verified.verified) return false;
      await pool.query("UPDATE passkeys SET counter = $2, last_used_at = now() WHERE id = $1", [key.id, verified.authenticationInfo.newCounter]);
      return true;
    } catch {
      return false;
    }
  };

  const AssertionBody = z.object({ challengeId: z.string().max(64), response: z.record(z.string(), z.unknown()) });

  app.post("/api/v1/session/passkey", async (request, reply) => {
    requirePasskeys();
    const body = AssertionBody.parse(request.body);
    const key = `passkey|${request.ip}`;
    if (limiter.isBlocked(key)) return reply.code(429).send({ error: { code: "too_many_attempts", message: "Trop de tentatives, réessayez plus tard" } });
    const challenge = challenges.take(body.challengeId, "login");
    const response = body.response as unknown as AuthenticationResponseJSON;
    const ok = challenge?.userId ? await verifyAssertion(challenge.userId, response, challenge.challenge) : false;
    if (!challenge?.userId || !ok) {
      limiter.recordFailure(key);
      await audit(pool, "anonymous", "login.passkey", null, "failure");
      return reply.code(401).send({ error: { code: "invalid_credentials", message: "Identifiants invalides" } });
    }
    limiter.reset(key);
    // Compte désactivé depuis l'émission du défi : pas de session.
    const { rows } = await pool.query<DbUser>(`${USER_SELECT} WHERE u.id = $1 AND u.active`, [challenge.userId]);
    const user = rows[0];
    if (!user) return reply.code(401).send({ error: { code: "invalid_credentials", message: "Identifiants invalides" } });
    // Une clé d'accès avec vérification de l'utilisateur vaut déjà deux facteurs.
    await createSession(pool, config, reply, { userId: user.id, method: "passkey", mfa: true });
    await audit(pool, user.username ?? user.email, "login.passkey", null, "success");
    return { username: user.username ?? user.email, email: user.email, role: user.role };
  });

  // Ouverture d'un terminal : même vérification, par clé d'accès, pour une session déjà connectée.
  app.post("/api/v1/me/step-up/passkey/options", { preHandler: auth }, async (request) => {
    requirePasskeys();
    const user = me(request);
    return authOptions(user.id, user.email, "step-up");
  });

  app.post("/api/v1/me/step-up/passkey", { preHandler: auth }, async (request, reply) => {
    requirePasskeys();
    const user = me(request);
    const body = AssertionBody.parse(request.body);
    const challenge = challenges.take(body.challengeId, "step-up");
    if (!challenge || challenge.userId !== user.id || !(await verifyAssertion(user.id, body.response as unknown as AuthenticationResponseJSON, challenge.challenge))) {
      await audit(pool, request.actor, "step-up.passkey", null, "failure");
      throw new HttpError(401, "invalid_credentials", "Clé d'accès refusée");
    }
    await markStepUp(request);
    return reply.code(204).send();
  });

  // Changement de mot de passe : voir `PUT /api/v1/admin/credentials` (mêmes règles, compte courant).
  void PasswordSchema;
  return { challenges };
}
