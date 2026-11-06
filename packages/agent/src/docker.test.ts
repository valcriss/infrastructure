import { describe, expect, it } from "vitest";
import { mapContainers } from "./docker.js";

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
