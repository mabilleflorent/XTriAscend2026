import { garminServerBase } from "./garmin-server-url";
import { isStrictLocalhost } from "./local-only";

const GARMIN_SCROLL_UNTIL_STORAGE_KEY = "xtriascend.garmin.scrollUntilActivityId";
export const GARMIN_SPLITS_STORAGE_KEY = "xtriascend.garmin.splits";
export const GARMIN_SPLITS_UPDATED_EVENT = "GARMIN_SPLITS_UPDATED";

export function mountGarminLocalPanel(): void {
  if (!isStrictLocalhost()) return;
  const btnLogin = document.getElementById("garmin-local-open-login");
  const btnClearSession = document.getElementById("garmin-local-clear-session");
  const btnExport = document.getElementById("garmin-local-export-fit");
  const btnFetchSplits = document.getElementById("garmin-local-fetch-splits");
  const scrollUntilInput = document.getElementById("garmin-local-scroll-until-id") as HTMLInputElement | null;
  const status = document.getElementById("garmin-local-status");
  if (!btnLogin && !btnExport && !btnClearSession && !btnFetchSplits) return;

  try {
    const saved = localStorage.getItem(GARMIN_SCROLL_UNTIL_STORAGE_KEY);
    if (saved != null && scrollUntilInput) scrollUntilInput.value = saved;
  } catch {
    /* ignore */
  }
  scrollUntilInput?.addEventListener("change", () => {
    try {
      localStorage.setItem(GARMIN_SCROLL_UNTIL_STORAGE_KEY, scrollUntilInput.value.trim());
    } catch {
      /* ignore */
    }
  });

  let pollTimer: number | null = null;
  let pollKind: "login" | "export" | "splits" | null = null;
  const stopPolling = () => {
    if (pollTimer != null) window.clearInterval(pollTimer);
    pollTimer = null;
    pollKind = null;
  };

  const setStatus = (s: string) => {
    if (status) status.textContent = s;
  };

  const pollLoginStatus = async () => {
    const base = garminServerBase();
    const r = await fetch(`${base}/api/garmin/login/status`, { method: "GET" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as {
      state?: string;
      message?: string;
      error?: string;
      inProgress?: boolean;
    };
    const msg = (j.message || "").trim();
    const err = (j.error || "").trim();
    const state = (j.state || "").trim();
    if (state === "success") {
      setStatus(msg || "Connexion Garmin OK.");
      stopPolling();
      return;
    }
    if (state === "error" || state === "timeout") {
      setStatus(`${msg || "Connexion Garmin KO."}${err ? ` (${err})` : ""}`);
      stopPolling();
      return;
    }
    setStatus(msg || "Connexion en cours…");
  };

  const pollExportStatus = async () => {
    const base = garminServerBase();
    const r = await fetch(`${base}/api/garmin/export/status`, { method: "GET" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { state?: string; message?: string; error?: string; inProgress?: boolean };
    const msg = (j.message || "").trim();
    const err = (j.error || "").trim();
    const state = (j.state || "").trim();
    if (state === "success") {
      setStatus(msg || "Export FIT terminé.");
      stopPolling();
      return;
    }
    if (state === "error") {
      setStatus(`${msg || "Export FIT en erreur."}${err ? ` (${err})` : ""}`);
      stopPolling();
      return;
    }
    setStatus(msg || "Export FIT en cours…");
  };

  const pollSplitsStatus = async () => {
    const base = garminServerBase();
    const r = await fetch(`${base}/api/garmin/splits/status`, { method: "GET" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as {
      state?: string;
      message?: string;
      error?: string;
      inProgress?: boolean;
      data?: { headers: string[]; rows: string[][] };
    };
    const msg = (j.message || "").trim();
    const err = (j.error || "").trim();
    const state = (j.state || "").trim();
    if (state === "success") {
      setStatus(msg || "Splits récupérés.");
      stopPolling();
      const splitsData = { headers: j.data?.headers ?? [], rows: j.data?.rows ?? [] };
      try {
        localStorage.setItem(GARMIN_SPLITS_STORAGE_KEY, JSON.stringify(splitsData));
      } catch {
        /* ignore */
      }
      document.dispatchEvent(new CustomEvent(GARMIN_SPLITS_UPDATED_EVENT, { detail: splitsData }));
      return;
    }
    if (state === "error") {
      setStatus(`${msg || "Erreur splits."}${err ? ` (${err})` : ""}`);
      stopPolling();
      return;
    }
    setStatus(msg || "Récupération splits en cours…");
  };

  btnLogin?.addEventListener("click", async () => {
    stopPolling();
    setStatus("Démarrage du login…");
    try {
      const base = garminServerBase();
      const r = await fetch(`${base}/api/garmin/login/start`, { method: "POST" });
      if (r.status === 409) {
        setStatus("Serveur occupé (login / export déjà en cours).");
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus("Login lancé : la fenêtre Garmin va s’ouvrir. Connecte-toi puis reviens ici.");
      // Poll: état partagé côté serveur.
      await pollLoginStatus().catch(() => {});
      pollKind = "login";
      pollTimer = window.setInterval(() => {
        void pollLoginStatus().catch((e: unknown) =>
          setStatus(`Statut login indisponible (${String((e as any)?.message ?? e)})`)
        );
      }, 2000);
    } catch (e) {
      setStatus(`Impossible de joindre le serveur Garmin local (${String((e as any)?.message ?? e)}).`);
    }
  });

  btnClearSession?.addEventListener("click", async () => {
    stopPolling();
    setStatus("Suppression de la session…");
    try {
      const base = garminServerBase();
      const url = `${base}/api/garmin/session/clear`;
      const opts = { method: "POST" as const, cache: "no-store" as RequestCache };
      let r = await fetch(url, opts);
      if (r.status === 404) {
        r = await fetch(url, { method: "GET", cache: "no-store" });
      }
      if (r.status === 409) {
        const j = (await r.json().catch(() => ({}))) as { message?: string };
        setStatus(j.message || "Serveur occupé : impossible de supprimer la session pendant login / export.");
        return;
      }
      if (r.status === 404) {
        const r2 = await fetch(`${base}/garmin/logout`, { method: "GET", redirect: "manual", cache: "no-store" });
        if ([200, 301, 302, 303, 307, 308].includes(r2.status)) {
          setStatus(
            "Fichiers de session supprimés (mode compatibilité via /garmin/logout). Pense à relancer `npm run garmin:server` avec le code à jour pour l’API JSON complète."
          );
          return;
        }
        setStatus(
          `Aucune route de suppression sur ${base} (HTTP 404). Relance le connecteur depuis le dossier du projet : npm run garmin:server`
        );
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus(
        "Session supprimée (fichiers + profil Chrome du connecteur). Le prochain « Ouvrir connexion Garmin » devrait afficher l’écran de connexion Garmin."
      );
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const hint =
        msg === "Failed to fetch"
          ? " — connecteur injoignable (lance `npm run garmin:server`) ou page HTTPS qui bloque l’accès HTTP au connecteur ; ouvre l’app en http://localhost."
          : "";
      setStatus(`Suppression session impossible (${msg}).${hint}`);
    }
  });

  btnExport?.addEventListener("click", async () => {
    stopPolling();
    setStatus("Démarrage export FIT…");
    try {
      const base = garminServerBase();
      const scrollUntil = scrollUntilInput?.value.trim() ?? "";
      try {
        localStorage.setItem(GARMIN_SCROLL_UNTIL_STORAGE_KEY, scrollUntil);
      } catch {
        /* ignore */
      }
      const r = await fetch(`${base}/api/garmin/export/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scrollUntil }),
      });
      if (r.status === 409) {
        setStatus("Serveur occupé (login / export déjà en cours).");
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus("Export lancé : Playwright va défiler la liste et télécharger les .fit.");
      await pollExportStatus().catch(() => {});
      pollKind = "export";
      pollTimer = window.setInterval(() => {
        void pollExportStatus().catch((e: unknown) =>
          setStatus(`Statut export indisponible (${String((e as any)?.message ?? e)})`)
        );
      }, 2000);
    } catch (e) {
      setStatus(`Impossible de joindre le serveur Garmin local (${String((e as any)?.message ?? e)}).`);
    }
  });

  btnFetchSplits?.addEventListener("click", async () => {
    stopPolling();
    setStatus("Lancement récupération des splits…");
    try {
      const base = garminServerBase();
      const r = await fetch(`${base}/api/garmin/splits/fetch`, { method: "POST" });
      if (r.status === 409) {
        setStatus("Serveur occupé (login / export / splits déjà en cours).");
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus("Récupération lancée : Playwright navigue vers Power Guidance…");
      await pollSplitsStatus().catch(() => {});
      pollKind = "splits";
      pollTimer = window.setInterval(() => {
        void pollSplitsStatus().catch((e: unknown) =>
          setStatus(`Statut splits indisponible (${String((e as any)?.message ?? e)})`)
        );
      }, 2000);
    } catch (e) {
      setStatus(`Impossible de joindre le serveur Garmin local (${String((e as any)?.message ?? e)}).`);
    }
  });

  document.addEventListener("GARMIN_FIT_BOOTSTRAP_STATUS", ((ev: Event) => {
    if (pollKind) return;
    const e = ev as CustomEvent<{ lastMessage?: string }>;
    const msg = e.detail?.lastMessage;
    if (msg && status) status.textContent = msg;
  }) as EventListener);
}
