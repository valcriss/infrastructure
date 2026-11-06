import { describe, expect, it } from "vitest";
import { mapContainers } from "./docker.js";

describe("mapContainers : détails en lecture seule", () => {
  it("reprend ports, réseaux, montages et libellés Compose, sans rien d'autre", () => {
    const [c] = mapContainers([
      {
        Id: "abc",
        Names: ["/legacy-web-1"],
        Image: "nginx",
        ImageID: "sha256:1",
        State: "running",
        Status: "Up",
        Created: 1,
        Labels: {
          "com.docker.compose.project": "legacy",
          "com.docker.compose.service": "web",
          "com.docker.compose.project.working_dir": "/srv/legacy",
          "com.docker.compose.project.config_files": "/srv/legacy/docker-compose.yml",
        },
        Ports: [{ IP: "0.0.0.0", PrivatePort: 80, PublicPort: 8080, Type: "tcp" }, { PrivatePort: 443, Type: "tcp" }, { nonsense: true }],
        Mounts: [{ Type: "bind", Source: "/srv/legacy/data", Destination: "/data", RW: false }, { Type: "volume", Name: "pgdata", Source: "/var/lib/docker/volumes/pgdata/_data", Destination: "/var/lib/postgresql/data", RW: true }, { Type: "bind" }],
        NetworkSettings: { Networks: { legacy_default: { IPAddress: "172.18.0.2" } } },
        Env: ["SECRET=ne-doit-jamais-sortir"],
      },
    ]);
    expect(c).toMatchObject({
      composeWorkingDir: "/srv/legacy",
      composeConfigFiles: "/srv/legacy/docker-compose.yml",
      networks: ["legacy_default"],
      ports: [{ privatePort: 80, publicPort: 8080, type: "tcp", ip: "0.0.0.0" }, { privatePort: 443, type: "tcp" }],
      mounts: [
        { type: "bind", source: "/srv/legacy/data", destination: "/data", rw: false },
        { type: "volume", source: "pgdata", destination: "/var/lib/postgresql/data", rw: true },
      ],
    });
    expect(JSON.stringify(c)).not.toContain("SECRET");
  });
});

describe("mapContainers", () => {
  it("extrait projet et service Compose depuis les labels", () => {
    const result = mapContainers([
      {
        Id: "abc",
        Names: ["/web-1"],
        Image: "nginx:1.27",
        ImageID: "sha256:123",
        State: "running",
        Status: "Up 2 minutes",
        Created: 1700000000,
        Labels: {
          "com.docker.compose.project": "monapp",
          "com.docker.compose.service": "web",
        },
      },
    ]);
    expect(result).toEqual([
      {
        id: "abc",
        names: ["web-1"],
        image: "nginx:1.27",
        imageId: "sha256:123",
        state: "running",
        status: "Up 2 minutes",
        created: 1700000000,
        composeProject: "monapp",
        composeService: "web",
      },
    ]);
  });

  it("ignore les entrées invalides et les réponses inattendues", () => {
    expect(mapContainers({})).toEqual([]);
    expect(mapContainers([{ Names: ["/x"] }])).toEqual([]);
  });

  it("n'invente pas de projet pour un conteneur hors Compose", () => {
    const [c] = mapContainers([{ Id: "x", Names: [], Labels: {} }]);
    expect(c?.composeProject).toBeUndefined();
  });
});
