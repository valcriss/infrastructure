import { describe, expect, it } from "vitest";
import { AgentMessageSchema, PROTOCOL_VERSION } from "./protocol.js";

describe("protocole agent", () => {
  it("accepte un hello d'enrôlement valide", () => {
    const r = AgentMessageSchema.safeParse({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      agentVersion: "0.0.0",
      hostname: "h1",
      capabilities: ["docker.standalone"],
      auth: { kind: "enrollment", token: "a".repeat(32) },
    });
    expect(r.success).toBe(true);
  });

  it("rejette un type de message inconnu", () => {
    expect(AgentMessageSchema.safeParse({ type: "exec", cmd: "ls" }).success).toBe(false);
  });

  it("rejette des identifiants d'agent mal formés", () => {
    const r = AgentMessageSchema.safeParse({
      type: "hello",
      protocol: 1,
      agentVersion: "0",
      hostname: "h",
      capabilities: [],
      auth: { kind: "credentials", agentId: "pas-un-uuid", secret: "x".repeat(32) },
    });
    expect(r.success).toBe(false);
  });
});
