import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  assetsInclude: ["**/*.fit"],
  preview: {
    // Railway sert l’app derrière un hostname dynamique *.up.railway.app
    // Pour éviter tout blocage lié aux hostnames dynamiques.
    allowedHosts: true,
    host: true,
  },
});
