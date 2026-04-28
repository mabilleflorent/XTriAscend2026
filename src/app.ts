import { mountAthleteSettingsRail } from "./athlete-settings-rail";
import {
  getEntrainementPanelHtml,
  bootstrapFitSessionsFromGarminBikeFolder,
  mountEntrainementPanel,
  refreshFtpFromVeloSessionsBadge,
  revokeFitBlobUrls,
} from "./entrainement";
import {
  ensureSimBikeKmEtaAthleteListener,
  getSimulationPanelHtml,
  mountSimulationPanel,
} from "./simulation";
import { mountGarminLocalPanel } from "./garmin-local";
import { mountAppLoader } from "./app-loader";
import { isStrictLocalhost } from "./local-only";

type ViewId = "entrainement" | "simulation";

const panels: Record<ViewId, string> = {
  entrainement: getEntrainementPanelHtml(),
  simulation: getSimulationPanelHtml(),
};

export function initApp(): void {
  const main = document.getElementById("main");
  if (!main) return;
  const mainEl = main;
  const isLocal = isStrictLocalhost();

  mountAppLoader();
  mountAthleteSettingsRail();
  mountGarminLocalPanel();
  void bootstrapFitSessionsFromGarminBikeFolder();
  void refreshFtpFromVeloSessionsBadge();
  ensureSimBikeKmEtaAthleteListener();

  const buttons = document.querySelectorAll<HTMLButtonElement>(".nav__btn");

  function show(view: ViewId): void {
    if (!isLocal && view === "simulation") view = "entrainement";
    revokeFitBlobUrls(mainEl);
    mainEl.innerHTML = panels[view];
    buttons.forEach((btn) => {
      const active = btn.dataset.view === view;
      btn.classList.toggle("nav__btn--active", active);
    });
    if (view === "entrainement") {
      void mountEntrainementPanel(mainEl);
    }
    if (view === "simulation") {
      void mountSimulationPanel(mainEl);
    }
  }

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.view as ViewId | undefined;
      if (id) show(id);
    });
  });

  show(isLocal ? "simulation" : "entrainement");
}
