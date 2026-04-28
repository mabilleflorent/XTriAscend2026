import "./style.css";
import { initApp } from "./app";
import { isStrictLocalhost } from "./local-only";

const isLocal = isStrictLocalhost();

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <header class="header">
    <div class="header__bar">
      <div class="header__brand">
        <img
          class="header__logo"
          src="https://static.wixstatic.com/media/b17a4f_b03d0b44ef4c4759a036d3f18287f917~mv2.png/v1/crop/x_155,y_141,w_935,h_928/fill/w_133,h_133,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/Capture%20d%E2%80%99%C3%A9cran%202025-06-04%20%C3%A0%2019_50_35.png"
          srcset="https://static.wixstatic.com/media/b17a4f_b03d0b44ef4c4759a036d3f18287f917~mv2.png/v1/crop/x_155,y_141,w_935,h_928/fill/w_133,h_133,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/Capture%20d%E2%80%99%C3%A9cran%202025-06-04%20%C3%A0%2019_50_35.png 1x, https://static.wixstatic.com/media/b17a4f_b03d0b44ef4c4759a036d3f18287f917~mv2.png/v1/crop/x_155,y_141,w_935,h_928/fill/w_266,h_266,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/Capture%20d%E2%80%99%C3%A9cran%202025-06-04%20%C3%A0%2019_50_35.png 2x"
          width="48"
          height="48"
          alt="ASCEND XTRI"
          loading="lazy"
          referrerpolicy="no-referrer"
        />
        <div class="header__titles">
          <h1 class="header__title">ASCEND <span class="header__title-x">XTRI</span></h1>
          <p class="header__tagline">Suivi d'entraînement & simulation</p>
        </div>
      </div>
      <a class="header__official" href="https://www.ascendxtri.com/" target="_blank" rel="noopener noreferrer">Site officiel</a>
    </div>
  </header>
  <section class="athlete-settings-rail athlete-settings-rail--bar" id="athlete-settings-rail" aria-label="Paramètres athlète">
    <div class="athlete-settings-rail__intro">
      <h2 class="athlete-settings-rail__title">Paramètres</h2>
      <p class="athlete-settings-rail__hint athlete-settings-rail__hint--bar">FTP, VMA, masse et heure de départ : entraînement, simulation vélo et horaires estimés au km. Disponibles dans les deux vues.</p>
    </div>
    <div class="athlete-settings-rail__row">
      <div class="athlete-settings-rail__stack-left">
        <div class="athlete-settings-rail__fields">
          <div class="ftp-config ftp-config--stack">
          <label class="ftp-config__label" for="ftp-rail-input">FTP vélo</label>
          <div class="athlete-settings-rail__input-row">
            <input class="ftp-config__input ftp-config__input--rail" id="ftp-rail-input" type="number" min="50" max="600" step="1" placeholder="250" aria-label="Seuil de puissance fonctionnelle (FTP) en watts"/>
            <span class="ftp-config__unit">W</span>
            <span class="ftp-rail-estimate" id="ftp-rail-estimate" aria-live="polite" title="">—</span>
          </div>
          </div>
          <div class="vma-config vma-config--stack">
          <label class="vma-config__label" for="vma-cap-rail-input">VMA CAP</label>
          <div class="athlete-settings-rail__input-row">
            <input class="vma-config__input vma-config__input--rail" id="vma-cap-rail-input" type="number" min="8" max="30" step="0.1" placeholder="14" aria-label="VMA course à pied en kilomètres par heure"/>
            <span class="vma-config__unit">km/h</span>
          </div>
          </div>
          <div class="mass-config mass-config--stack">
          <label class="mass-config__label" for="mass-rail-input" title="Cycliste + vélo + équipement">Masse totale</label>
          <div class="athlete-settings-rail__input-row">
            <input class="mass-config__input mass-config__input--rail" id="mass-rail-input" type="number" min="50" max="150" step="0.5" placeholder="82" aria-label="Masse totale cycliste vélo et équipement en kilogrammes"/>
            <span class="mass-config__unit">kg</span>
          </div>
          </div>
          <div class="race-start-config race-start-config--stack">
          <label class="race-start-config__label" for="race-start-rail-input" title="Référence pour le tableau vélo (heure à la fin de chaque km). En triathlon, indiquez plutôt l’heure de départ vélo si la natation précède.">Départ course</label>
          <div class="athlete-settings-rail__input-row">
            <input
              class="race-start-config__input race-start-config__input--rail"
              id="race-start-rail-input"
              type="time"
              step="60"
              value="03:00"
              aria-label="Heure de départ de la course (référence tableau vélo ; en triathlon souvent l’heure de départ vélo)"
            />
          </div>
          </div>
        </div>
        ${
          isLocal
            ? `<div class="garmin-local" id="garmin-local" aria-label="Connecteur Garmin local">
          <h2 class="athlete-settings-rail__title athlete-settings-rail__title--garmin">Garmin</h2>
          <div class="garmin-local__actions">
            <button type="button" class="garmin-local__btn" id="garmin-local-open-login">
              Ouvrir connexion Garmin
            </button>
            <button type="button" class="garmin-local__btn" id="garmin-local-export-fit">
              Récupérer les fichiers FIT
            </button>
          </div>
          <p class="garmin-local__status muted" id="garmin-local-status" role="status" aria-live="polite"></p>
        </div>`
            : ""
        }
      </div>
      <div class="athlete-settings-rail__extras">
        <div class="athlete-settings-rail__sim-final" id="sim-final-time" hidden aria-live="polite">
          <div class="athlete-settings-rail__sim-final-label">Heure finale (arrivée)</div>
          <div class="athlete-settings-rail__sim-final-value" id="sim-final-time-value">—</div>
          <div class="athlete-settings-rail__shirt" id="sim-shirt" hidden>
            <span class="athlete-settings-rail__shirt-icon" id="sim-shirt-icon" aria-hidden="true"></span>
            <span class="athlete-settings-rail__shirt-label" id="sim-shirt-label"></span>
          </div>
        </div>
      </div>
    </div>
  </section>
  <nav class="nav" aria-label="Navigation principale">
    ${
      isLocal
        ? `<button type="button" class="nav__btn nav__btn--active" data-view="simulation">
      Simulation
    </button>`
        : ""
    }
    <button type="button" class="nav__btn" data-view="entrainement">
      Suivi de l'entraînement
    </button>
  </nav>
  <div class="app-layout">
    <main class="main" id="main"></main>
  </div>
  <div class="app-loader" id="app-loader" role="dialog" aria-modal="true" aria-label="Chargement en cours">
    <div class="app-loader__card">
      <div class="app-loader__title">Chargement des activités</div>
      <div class="app-loader__hint" id="app-loader-hint">Initialisation…</div>
      <div class="app-loader__bar" aria-hidden="true">
        <div class="app-loader__barFill" id="app-loader-bar-fill" style="width:0%"></div>
      </div>
      <div class="app-loader__meta" id="app-loader-meta">0%</div>
    </div>
  </div>
`;

initApp();
