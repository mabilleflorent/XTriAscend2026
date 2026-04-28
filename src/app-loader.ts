type BootstrapStats = {
  listed: number;
  fetched: number;
  decoded: number;
  skippedExisting: number;
  skippedNonFit: number;
  fetchErrors: number;
  decodeErrors: number;
  lastMessage: string;
};

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function computeProgress(stats: BootstrapStats): { ratio: number; label: string } {
  const total = Math.max(1, stats.listed);
  const done =
    stats.decoded +
    stats.skippedExisting +
    stats.skippedNonFit +
    stats.fetchErrors +
    stats.decodeErrors;
  const ratio = clamp01(done / total);
  const label = `${Math.round(ratio * 100)}%`;
  return { ratio, label };
}

export function mountAppLoader(): { hide: () => void; show: () => void } {
  const root = document.getElementById("app-loader");
  const hint = document.getElementById("app-loader-hint");
  const meta = document.getElementById("app-loader-meta");
  const fill = document.getElementById("app-loader-bar-fill") as HTMLDivElement | null;

  const show = () => {
    if (root) root.style.display = "grid";
  };
  const hide = () => {
    if (root) root.style.display = "none";
  };

  show();

  document.addEventListener("GARMIN_FIT_BOOTSTRAP_STATUS", ((ev: Event) => {
    const e = ev as CustomEvent<BootstrapStats>;
    const s = e.detail;
    if (!s) return;
    if (hint) hint.textContent = s.lastMessage || "Intégration des fichiers FIT…";
    const { ratio, label } = computeProgress(s);
    if (fill) fill.style.width = `${Math.round(ratio * 100)}%`;
    if (meta) meta.textContent = label;

    const total = s.listed;
    const done =
      s.decoded +
      s.skippedExisting +
      s.skippedNonFit +
      s.fetchErrors +
      s.decodeErrors;
    const msg = (s.lastMessage || "").toLowerCase();
    const isTerminal =
      msg.startsWith("bootstrap terminé") ||
      msg.includes("aucun .fit") ||
      msg.includes("échec liste") ||
      msg.includes("echec liste");

    // Ne pas cacher pendant "initialisation" (listed=0) : sinon le loader ne se voit jamais.
    if (total > 0 && done >= total) hide();
    if (total === 0 && isTerminal) hide();
  }) as EventListener);

  return { hide, show };
}

