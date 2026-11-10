import type { Container, NetworkInfo } from "@infra/shared";
import { describe, expect, it } from "vitest";
import { networkCandidates, portConflicts } from "./traefik-routes.js";

const net = (name: string, over: Partial<NetworkInfo> = {}): NetworkInfo => ({ name, driver: "bridge", scope: "local", internal: false, ...over });
const ctr = (name: string, project: string | undefined, networks: string[], over: Partial<Container> = {}): Container => ({
  id: name.padEnd(12, "0"),
  names: [name],
  image: "img",
  imageId: "sha256:1",
  state: "running",
  status: "Up",
  created: 1,
  ...(project ? { composeProject: project } : {}),
  networks,
  ...over,
});

describe("networkCandidates", () => {
  it("écarte les réseaux par défaut des projets, internes, d'autres pilotes et ceux de la console", () => {
    const networks = [
      net("blog_default", { project: "blog" }),
      net("isole", { internal: true }),
      net("overlay-1", { driver: "overlay", scope: "swarm" }),
      net("console-docker_internal", { project: "console-docker" }),
      net("traefik-public", { project: "traefik" }),
      net("monreseau"),
    ];
    expect(networkCandidates(networks, [], ["console-docker", "console-docker-agent"]).map((n) => n.name)).toEqual(["traefik-public", "monreseau"]);
  });

  it("indique les applications qui utilisent le réseau et suggère un réseau partagé ou au nom évocateur", () => {
    const networks = [net("partage"), net("seul"), net("proxy"), net("autre")];
    const containers = [ctr("a-web", "a", ["partage", "seul"]), ctr("b-web", "b", ["partage"]), ctr("b-db", "b", ["partage"]), ctr("solo", undefined, ["autre"])];
    const out = networkCandidates(networks, containers);
    expect(out.find((n) => n.name === "partage")).toMatchObject({ usedBy: ["a", "b"], suggested: true });
    expect(out.find((n) => n.name === "seul")).toMatchObject({ usedBy: ["a"], suggested: false });
    expect(out.find((n) => n.name === "proxy")).toMatchObject({ usedBy: [], suggested: true });
    expect(out.find((n) => n.name === "autre")?.usedBy).toEqual(["solo"]);
    // Les suggestions d'abord, puis l'ordre alphabétique.
    expect(out.map((n) => n.name)).toEqual(["partage", "proxy", "autre", "seul"]);
  });
});

describe("portConflicts", () => {
  it("signale les conteneurs en marche qui publient 80 ou 443 en TCP", () => {
    const tcp = (publicPort: number) => ({ privatePort: 8080, publicPort, type: "tcp" });
    const out = portConflicts([
      ctr("nginx", "site", [], { ports: [tcp(80), tcp(443)] }),
      ctr("arrete", "x", [], { state: "exited", ports: [tcp(80)] }),
      ctr("autre", "y", [], { ports: [tcp(8080), { privatePort: 53, publicPort: 80, type: "udp" }] }),
      ctr("interne", "z", [], { ports: [{ privatePort: 80, type: "tcp" }] }),
    ]);
    expect(out).toEqual([
      { port: 80, container: "nginx" },
      { port: 443, container: "nginx" },
    ]);
  });
});
