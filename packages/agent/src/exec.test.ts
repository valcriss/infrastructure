import { describe, expect, it } from "vitest";
import { runCommand } from "./exec.js";

const env = { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" };
const sleeper = ["-e", "setTimeout(() => {}, 60000)"];

describe("runCommand : interruption par signal", () => {
  it("tue le processus quand le signal est déclenché et le signale", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const pending = runCommand(process.execPath, sleeper, { env, timeoutMs: 60_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    const res = await pending;
    expect(res.aborted).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("ne démarre pas de travail utile quand le signal est déjà déclenché", async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await runCommand(process.execPath, sleeper, { env, timeoutMs: 60_000, signal: ac.signal });
    expect(res.aborted).toBe(true);
  });

  it("sans signal, le comportement est inchangé", async () => {
    const res = await runCommand(process.execPath, ["-e", "console.log('ok')"], { env, timeoutMs: 10_000 });
    expect(res).toMatchObject({ code: 0, timedOut: false, aborted: false, stdout: "ok\n" });
  });
});
