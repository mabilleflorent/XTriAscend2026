/**
 * URL du connecteur Express Garmin (`npm run garmin:server`, port 8787 par défaut).
 * En local, chaîne vide → requêtes same-origin, proxy Vite → 127.0.0.1:8787 (évite CORS / contenu mixte).
 */
export function garminServerBase(): string {
  const raw = import.meta.env.VITE_GARMIN_SERVER_URL?.trim();
  if (raw) return raw.replace(/\/$/, "");
  if (typeof window !== "undefined") {
    const h = window.location.hostname;
    if (h === "localhost" || h === "127.0.0.1") return "";
  }
  return "http://127.0.0.1:8787";
}
