import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Les tests d'intégration partagent une même base jetable : pas de parallélisme entre fichiers.
    fileParallelism: false,
  },
});
