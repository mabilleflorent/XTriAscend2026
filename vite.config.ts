import { defineConfig } from "vite";

/** Proxy navigateur → connecteur Garmin local (évite CORS et blocages localhost vs 127.0.0.1). */
const garminConnectorProxy = {
  target: "http://127.0.0.1:8787",
  changeOrigin: true,
} as const;

export default defineConfig({
  root: ".",
  assetsInclude: ["**/*.fit"],
  server: {
    proxy: {
      "/api/garmin": garminConnectorProxy,
      "/garmin": garminConnectorProxy,
    },
  },
  preview: {
    // Railway sert l’app derrière un hostname dynamique *.up.railway.app
    // Pour éviter tout blocage lié aux hostnames dynamiques.
    allowedHosts: true,
    host: true,
    proxy: {
      "/api/garmin": garminConnectorProxy,
      "/garmin": garminConnectorProxy,
    },
  },
});
