import { describe, expect, it } from "vitest";
import { drawerWidth, isNarrow, maxWidth, minWidth, widthFromPointer } from "./drawer-width";

describe("drawerWidth", () => {
  it("prend un tiers de la page sans préférence mémorisée", () => {
    expect(drawerWidth(null, 1500)).toBe(500);
    expect(drawerWidth(undefined, 1500)).toBe(500);
    expect(minWidth(1500)).toBe(500);
  });

  it("garde une préférence valide et la ramène dans les bornes (jamais moins d'un tiers, au plus 90 %)", () => {
    expect(drawerWidth(800, 1500)).toBe(800);
    expect(drawerWidth(200, 1500)).toBe(500);
    expect(drawerWidth(5000, 1500)).toBe(maxWidth(1500));
    expect(maxWidth(1500)).toBe(1350);
  });

  it("ignore une valeur mémorisée invalide", () => {
    for (const bad of ["800", NaN, Infinity, {}, [], true]) expect(drawerWidth(bad, 1500)).toBe(500);
  });

  it("suit la taille de la fenêtre : une grande largeur mémorisée est réduite sur un petit écran", () => {
    expect(drawerWidth(1200, 1000)).toBe(900);
    expect(drawerWidth(300, 3000)).toBe(1000);
  });
});

describe("widthFromPointer", () => {
  it("calcule la largeur depuis le bord droit et la borne", () => {
    expect(widthFromPointer(700, 1500)).toBe(800);
    expect(widthFromPointer(1200, 1500)).toBe(500);
    expect(widthFromPointer(10, 1500)).toBe(1350);
  });
});

describe("isNarrow", () => {
  it("considère étroit un écran de moins de 768 px", () => {
    expect(isNarrow(767)).toBe(true);
    expect(isNarrow(768)).toBe(false);
  });
});
