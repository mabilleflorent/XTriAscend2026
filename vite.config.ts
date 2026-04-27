import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  assetsInclude: ["**/*.fit"],
  preview: {
    allowedHosts: ["*.up.railway.app", "localhost"],
  },
});
