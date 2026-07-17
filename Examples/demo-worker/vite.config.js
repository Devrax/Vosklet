import { defineConfig } from "vite";

// Reuse the original demo's public assets — most importantly the 38 MB Vosk
// model archive — instead of duplicating them in the repository. Vite serves
// them in dev and copies them into dist/ at build time, so Capacitor still
// packages the model into the app.
export default defineConfig({
  publicDir: "../demo/public"
});
