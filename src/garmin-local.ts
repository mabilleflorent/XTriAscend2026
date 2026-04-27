/** Base du connecteur Express + Playwright (`npm run garmin:server`). */
function garminServerBase(): string {
  const raw = import.meta.env.VITE_GARMIN_SERVER_URL?.trim();
  if (raw) return raw.replace(/\/$/, "");
  return "http://127.0.0.1:8787";
}

export function mountGarminLocalPanel(): void {
  const btnLogin = document.getElementById("garmin-local-open-login");
  const btnExport = document.getElementById("garmin-local-export-fit");
  const status = document.getElementById("garmin-local-status");
  if (!btnLogin && !btnExport) return;

  let pollTimer: number | null = null;
  let pollKind: "login" | "export" | null = null;
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

  btnExport?.addEventListener("click", async () => {
    stopPolling();
    setStatus("Démarrage export FIT…");
    try {
      const base = garminServerBase();
      const r = await fetch(`${base}/api/garmin/export/start`, { method: "POST" });
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

  document.addEventListener("GARMIN_FIT_BOOTSTRAP_STATUS", ((ev: Event) => {
    if (pollKind) return;
    const e = ev as CustomEvent<{ lastMessage?: string }>;
    const msg = e.detail?.lastMessage;
    if (msg && status) status.textContent = msg;
  }) as EventListener);
}
