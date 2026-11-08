import { describe, expect, it } from "vitest";
import { guessPackageManager } from "./dockerfile.js";
import { parseBaseImage, replaceBaseImage, serviceBaseImage } from "./dockerfile-base.js";

describe("parseBaseImage", () => {
  it("lit l'image de base unique, avec options et alias", () => {
    expect(parseBaseImage("# commentaire\nFROM lscr.io/linuxserver/qbittorrent:5.3.0\nUSER root\n")).toEqual({ ref: "lscr.io/linuxserver/qbittorrent:5.3.0", line: 1 });
    expect(parseBaseImage("FROM --platform=linux/amd64 node:20-alpine AS base\n")).toEqual({ ref: "node:20-alpine", line: 0 });
  });

  it("ignore scratch et les étapes qui partent d'une étape précédente", () => {
    expect(parseBaseImage("FROM node:20 AS build\nFROM scratch AS out\nFROM build\n")).toEqual({ ref: "node:20", line: 0 });
  });

  it("refuse plusieurs images externes ou une image paramétrée", () => {
    expect(parseBaseImage("FROM golang:1.22 AS b\nFROM alpine:3.20\n")).toHaveProperty("error");
    expect(parseBaseImage("ARG V=1\nFROM app:${V}\n")).toHaveProperty("error");
    expect(parseBaseImage("RUN echo\n")).toHaveProperty("error");
  });
});

describe("replaceBaseImage", () => {
  it("ne change que l'image de la ligne FROM", () => {
    const d = "# FROM x:1\nFROM --platform=linux/amd64 node:20 AS base\nRUN echo node:20\n";
    expect(replaceBaseImage(d, 1, "node:22")).toBe("# FROM x:1\nFROM --platform=linux/amd64 node:22 AS base\nRUN echo node:20\n");
  });
});

describe("serviceBaseImage", () => {
  const files = { "build/app/Dockerfile": "FROM ghost:5.1\nUSER root\n", "other/Dockerfile.dev": "FROM nginx:1.27\n", Dockerfile: "FROM redis:7\n" };

  it("retrouve l'image de base via build: (chaîne ou objet)", () => {
    expect(serviceBaseImage("services:\n  app:\n    build: ./build/app\n", files, "app")).toEqual({ ref: "ghost:5.1", path: "build/app/Dockerfile", line: 0 });
    expect(serviceBaseImage("services:\n  w:\n    build:\n      context: other\n      dockerfile: Dockerfile.dev\n", files, "w")).toEqual({ ref: "nginx:1.27", path: "other/Dockerfile.dev", line: 0 });
    expect(serviceBaseImage("services:\n  r:\n    build: .\n", files, "r")).toMatchObject({ ref: "redis:7", path: "Dockerfile" });
  });

  it("null si le service n'est pas construit ; erreur expliquée sinon", () => {
    expect(serviceBaseImage("services:\n  app:\n    image: ghost:5\n", files, "app")).toBeNull();
    expect(serviceBaseImage("services:\n  app:\n    build: ./absent\n", files, "app")).toHaveProperty("error");
    expect(serviceBaseImage("services:\n  app:\n    build: https://github.com/x/y.git\n", files, "app")).toHaveProperty("error");
    expect(serviceBaseImage("services:\n  app:\n    build: ../hors\n", files, "app")).toHaveProperty("error");
  });
});

describe("guessPackageManager", () => {
  it("déduit le gestionnaire du nom de l'image, sinon null", () => {
    expect(guessPackageManager("node:20-alpine")).toBe("apk");
    expect(guessPackageManager("ghost:bookworm")).toBe("apt-get");
    expect(guessPackageManager("ubuntu:24.04")).toBe("apt-get");
    expect(guessPackageManager("registry.access.redhat.com/ubi9/ubi-minimal")).toBe("microdnf");
    expect(guessPackageManager("fedora:40")).toBe("dnf");
    expect(guessPackageManager("lscr.io/linuxserver/qbittorrent:5.3.0")).toBeNull();
  });
});
