import {
  getFtp,
  getVmaCapKmh,
} from "./athlete-settings";
import { ATHLETE_SETTINGS_CHANGED } from "./athlete-settings-rail";

export type Discipline = "natation" | "velo" | "course";

/** Catégorie de sortie vélo choisie par l'utilisateur lors de l'import. */
export type VeloCategory = "montagne" | "endurance" | "sortie-longue" | "strength";

const VELO_CATEGORY_LABELS: Record<VeloCategory, string> = {
  "montagne": "Montagne",
  "endurance": "Endurance",
  "sortie-longue": "Sortie Longue",
  strength: "Strength",
};

/** Catégorie de course à pied (CAP), déduite du nom de fichier à l'import. */
export type CourseCategory = "fractionnee" | "sortie-longue" | "sortie-tranquille";

const COURSE_CATEGORY_LABELS: Record<CourseCategory, string> = {
  fractionnee: "Fractionnée",
  "sortie-longue": "Sortie longue",
  "sortie-tranquille": "Sortie tranquille",
};

const ALL_VELO_CATEGORIES: VeloCategory[] = ["montagne", "endurance", "sortie-longue", "strength"];
const ALL_COURSE_CATEGORIES: CourseCategory[] = ["fractionnee", "sortie-longue", "sortie-tranquille"];

function isVeloCategory(v: string): v is VeloCategory {
  return v === "montagne" || v === "endurance" || v === "sortie-longue" || v === "strength";
}

function isCourseCategory(v: string): v is CourseCategory {
  return v === "fractionnee" || v === "sortie-longue" || v === "sortie-tranquille";
}

type FitSummaryRow = { label: string; value: string };
type FitSeries = { label: string; unit?: string; points: { t: number; y: number }[] };

type FitMetrics = {
  avgPowerW?: number;
  maxPowerW?: number;
  pnW?: number;
  /** Meilleure moyenne de puissance sur une fenêtre glissante de 20 min (records FIT). */
  best20MinAvgPowerW?: number;
  totalTimerS?: number;
  totalDistKm?: number;
  avgHr?: number;
  avgSpeedKmh?: number;
};

type FitDecoded = {
  summary: FitSummaryRow[];
  series?: FitSeries;
  metrics?: FitMetrics;
};

type FitUpload = {
  id: string; // sha256 hex du fichier FIT (unicité)
  fileName: string;
  size: number;
  data: ArrayBuffer;
  updatedAt: number;
};

type FitSession = {
  id: string; // sha256 hex (clé primaire)
  fileName: string;
  size: number;
  updatedAt: number;
  startMs?: number; // date/heure de l'activité si disponible
  decoded: FitDecoded; // informations importantes extraites
};

type StoredFitLink = {
  id: string; // `${discipline}:${sessionId}`
  discipline: Discipline;
  sessionId: string;
  linkedAt: number;
  veloCategory?: VeloCategory; // catégorie choisie lors de l'import (vélo uniquement)
  courseCategory?: CourseCategory; // catégorie CAP (course uniquement)
};

const DB_NAME = "xtriascend";
const DB_VERSION = 3;
const STORE_SESSIONS = "fitSessions";
const STORE_LINKS = "fitLinks";

const DISCIPLINES: readonly {
  id: Discipline;
  label: string;
  blurb: string;
}[] = [
  {
    id: "natation",
    label: "Natation",
    blurb: "Séances en piscine ou eau libre — importez l’extrait Garmin (.FIT).",
  },
  {
    id: "velo",
    label: "Vélo",
    blurb: "Sorties vélo — importez l’extrait Garmin (.FIT).",
  },
  {
    id: "course",
    label: "Course à pied",
    blurb: "Footing ou séances piste — importez l’extrait Garmin (.FIT).",
  },
];

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Migration depuis v1: l'ancien store s'appelait fitSessions (keyPath discipline)
      if (db.objectStoreNames.contains(STORE_SESSIONS)) {
        try {
          db.deleteObjectStore(STORE_SESSIONS);
        } catch {
          // ignore
        }
      }
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
      }
      // v2 -> v3 : fitLinks passe de 1 lien/disc à N liens/disc
      if (db.objectStoreNames.contains(STORE_LINKS)) {
        try {
          db.deleteObjectStore(STORE_LINKS);
        } catch {
          // ignore
        }
      }
      if (!db.objectStoreNames.contains(STORE_LINKS)) {
        const store = db.createObjectStore(STORE_LINKS, { keyPath: "id" });
        store.createIndex("byDiscipline", "discipline", { unique: false });
        store.createIndex("bySessionId", "sessionId", { unique: false });
      }
    };
  });
}

async function listLinks(discipline: Discipline): Promise<StoredFitLink[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LINKS, "readonly");
    const store = tx.objectStore(STORE_LINKS);
    const idx = store.index("byDiscipline");
    const req = idx.getAll(discipline);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve((req.result as StoredFitLink[]) ?? []);
  });
}

async function putLink(link: StoredFitLink): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LINKS, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE_LINKS).put(link);
  });
}

async function getSession(id: string): Promise<FitSession | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readonly");
    const store = tx.objectStore(STORE_SESSIONS);
    const r = store.get(id);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => resolve(r.result as FitSession | undefined);
  });
}

async function putSession(session: FitSession): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE_SESSIONS).put(session);
  });
}

/** Supprime tous les liens pointant vers cette séance puis l’entrée session (stats décodées incluses). */
async function deleteSessionAndLinks(sessionId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_LINKS, STORE_SESSIONS], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);

    const linkStore = tx.objectStore(STORE_LINKS);
    const idx = linkStore.index("bySessionId");
    const cur = idx.openCursor(IDBKeyRange.only(sessionId));
    cur.onerror = () => reject(cur.error);
    cur.onsuccess = () => {
      const cursor = cur.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        tx.objectStore(STORE_SESSIONS).delete(sessionId);
      }
    };
  });
}

async function hasSession(id: string): Promise<boolean> {
  return !!(await getSession(id));
}

/** Met à jour la catégorie vélo d'un lien existant (sans re-décoder le FIT). `null` retire la catégorie. */
async function updateLinkVeloCategory(sessionId: string, category: VeloCategory | null): Promise<void> {
  const linkId = `velo:${sessionId}`;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LINKS, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    const store = tx.objectStore(STORE_LINKS);
    const req = store.get(linkId);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const link = req.result as StoredFitLink | undefined;
      if (link) {
        if (category === null) {
          delete link.veloCategory;
        } else {
          link.veloCategory = category;
        }
        store.put(link);
      } else {
        resolve();
      }
    };
  });
}

/** Met à jour la catégorie course d'un lien existant (sans re-décoder le FIT). */
async function updateLinkCourseCategory(sessionId: string, category: CourseCategory): Promise<void> {
  const linkId = `course:${sessionId}`;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LINKS, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    const store = tx.objectStore(STORE_LINKS);
    const req = store.get(linkId);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const link = req.result as StoredFitLink | undefined;
      if (link) {
        link.courseCategory = category;
        store.put(link);
      } else {
        resolve();
      }
    };
  });
}

async function sha256Hex(ab: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", ab);
  const bytes = new Uint8Array(hash);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function formatDurationSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m > 0) return `${m} min ${String(sec).padStart(2, "0")} s`;
  return `${sec} s`;
}

function formatNumber(n: number, digits = 1): string {
  return n.toLocaleString("fr-FR", { maximumFractionDigits: digits });
}

export function getEntrainementPanelHtml(): string {
  const accordions = DISCIPLINES.map(
    (d) => `
      <details class="upload-accordion">
        <summary class="upload-accordion__summary">
          <span class="upload-accordion__label">${d.label}</span>
          <span class="upload-accordion__chev" aria-hidden="true"></span>
        </summary>
        <div class="upload-accordion__body">
          <ul class="uploads-list" data-uploads-list="${d.id}" aria-label="Fichiers ${d.label}"></ul>
        </div>
      </details>`
  ).join("");

  return `
    <section class="panel panel--entrainement" aria-labelledby="t-entrainement">
      <h2 id="t-entrainement">Suivi de l'entraînement</h2>
      <div class="entrain-layout">
        <div class="entrain-layout__main">
          <div class="upload-bar" aria-label="Données FIT">
            <div class="upload-bar__title">Données FIT</div>
            <p class="upload-bar__hint">Les fichiers FIT sont récupérés automatiquement depuis le connecteur Garmin local. Les catégories vélo et course à pied peuvent être déduites du nom du fichier (voir conventions dans l’app). Vous pouvez <strong>modifier la catégorie</strong> à tout moment dans la liste. La <strong>FTP</strong> et la <strong>VMA</strong> se règlent dans le menu de gauche.</p>
          </div>
          <div class="training-card" aria-label="Suivi d'entraînement">
            <div class="training-card__header">
              <h3 class="training-card__title">Suivi d'entraînement</h3>
            </div>
            <div class="training-card__body">
              <div class="training-block" data-training-block="velo">
                <h4 class="training-block__title">Vélo</h4>
                <div class="training-block__content"></div>
              </div>
              <div class="training-block" data-training-block="course">
                <h4 class="training-block__title">Course à pied</h4>
                <div class="training-block__content"></div>
              </div>
            </div>
          </div>
        </div>
        <aside class="uploads-sidebar" aria-label="Fichiers importés">
          <h3 class="uploads-sidebar__title">Fichiers importés</h3>
          <p class="uploads-sidebar__hint">Repliez une discipline pour réduire la hauteur. La colonne de droite défile si la liste est longue.</p>
          <div class="uploads-sidebar__accordions">
            ${accordions}
          </div>
        </aside>
      </div>
    </section>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Panneau entraînement actuellement dans le DOM (évite une référence `root` déconnectée après navigation). */
function resolveEntrainementPanel(): HTMLElement | null {
  return (
    document.getElementById("main")?.querySelector<HTMLElement>(".panel--entrainement") ??
    document.querySelector<HTMLElement>("main#main .panel--entrainement") ??
    document.querySelector<HTMLElement>(".panel--entrainement")
  );
}

let athleteSettingsListenerAttached = false;

function ensureAthleteSettingsListener(): void {
  if (athleteSettingsListenerAttached) return;
  athleteSettingsListenerAttached = true;
  document.addEventListener(ATHLETE_SETTINGS_CHANGED, ((ev: Event) => {
    const e = ev as CustomEvent<{ key: "ftp" | "vma" }>;
    const panel = resolveEntrainementPanel();
    if (!panel) return;
    if (e.detail?.key === "ftp") void renderVeloChart(panel);
    if (e.detail?.key === "vma") void renderCourseChart(panel);
  }) as EventListener);
}

function expandUploadsAccordion(root: HTMLElement, discipline: Discipline): void {
  const ul = root.querySelector(`[data-uploads-list="${discipline}"]`);
  const details = ul?.closest("details");
  if (details) (details as HTMLDetailsElement).open = true;
}

function escapeForCssSelector(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value;
}

function clearChartSessionHighlight(root: HTMLElement): void {
  root.querySelectorAll(".progress-chart__dot--selected").forEach((el) => el.classList.remove("progress-chart__dot--selected"));
  root.querySelectorAll(".uploads-item--chart-selected").forEach((el) => el.classList.remove("uploads-item--chart-selected"));
}

/** Clic sur un point du graphique : surbrillance du FIT correspondant dans la liste. */
function highlightSessionFromChartClick(root: HTMLElement, sessionId: string): void {
  clearChartSessionHighlight(root);
  const sel = escapeForCssSelector(sessionId);
  root.querySelectorAll(`circle.progress-chart__dot[data-session-id="${sel}"]`).forEach((el) => el.classList.add("progress-chart__dot--selected"));
  const li = root.querySelector(`li.uploads-item[data-session-id="${sel}"]`);
  if (!li) return;
  li.classList.add("uploads-item--chart-selected");
  const uploadsRoot = li.closest<HTMLElement>("[data-uploads-list]");
  const d = uploadsRoot?.dataset.uploadsList;
  if (d === "velo" || d === "course") expandUploadsAccordion(root, d);
  li.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

export function revokeFitBlobUrls(container: HTMLElement): void {
  container.querySelectorAll<HTMLAnchorElement>("a.fit-status__link").forEach((a) => {
    if (a.href.startsWith("blob:")) URL.revokeObjectURL(a.href);
  });
}

/**
 * Déduit la catégorie vélo depuis le nom du fichier FIT.
 * Règles (insensible à la casse) :
 *   - contient "The Machine" → montagne
 *   - contient "2h"          → sortie-longue
 *   - contient "90m"         → endurance
 *   - contient "Strength"    → strength
 */
function inferVeloCategoryFromFileName(fileName: string): VeloCategory | undefined {
  // Les noms issus de Garmin/Playwright sont souvent "sanitisés" avec des tirets.
  // On normalise pour que "The-Machine" matche comme "The Machine".
  const n = fileName
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (n.includes("strength")) return "strength";
  if (n.includes("the machine")) return "montagne";
  if (n.includes("2h")) return "sortie-longue";
  if (n.includes("90m")) return "endurance";
  return undefined;
}

/**
 * Déduit la catégorie CAP depuis le nom du fichier (insensible à la casse).
 * — Fractionnée si le nom contient « VMA ».
 * — Sortie longue si le nom contient « sortie longue » (espaces, tirets ou underscores entre les mots).
 * — Sinon : sortie tranquille.
 */
function inferCourseCategoryFromFileName(fileName: string): CourseCategory {
  const n = fileName.toLowerCase();
  if (/\bvma\b/i.test(fileName)) return "fractionnee";
  if (/sortie[\s_-]*longue/i.test(n)) return "sortie-longue";
  return "sortie-tranquille";
}

export async function mountEntrainementPanel(container: HTMLElement): Promise<void> {
  const root = container.querySelector<HTMLElement>(".panel--entrainement");
  if (!root) return;

  // Masqué sur la vue entraînement : affiché uniquement sur Simulation.
  const finalEl = document.getElementById("sim-final-time");
  if (finalEl) finalEl.hidden = true;
  const shirtEl = document.getElementById("sim-shirt");
  if (shirtEl) shirtEl.hidden = true;

  ensureAthleteSettingsListener();
  await refreshAllUploadLists();

  root.addEventListener("click", (e) => {
    const fromEl = e.target instanceof Element ? e.target : null;
    const chartDot = fromEl?.closest("circle.progress-chart__dot[data-session-id]");
    if (chartDot && root.contains(chartDot)) {
      const sid = chartDot.getAttribute("data-session-id");
      if (sid) highlightSessionFromChartClick(root, sid);
      return;
    }

    const t = e.target as HTMLElement;

    const delBtn = t.closest<HTMLButtonElement>("button[data-delete-session]");
    if (delBtn) {
      const sessionId = delBtn.dataset.deleteSession;
      if (!sessionId) return;
      if (!confirm("Supprimer ce fichier importé et toutes les statistiques associées ? Cette action est définitive.")) return;
      void deleteSessionAndLinks(sessionId)
        .then(() => refreshAllUploadLists())
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error("Suppression impossible", err);
          alert("Impossible de supprimer cette entrée.");
        });
    }
  });

  root.addEventListener("change", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLSelectElement) || !t.hasAttribute("data-set-activity-category")) return;
    const sessionId = t.dataset.sessionId;
    const discipline = t.dataset.discipline as Discipline | undefined;
    const value = t.value;
    if (!sessionId || (discipline !== "velo" && discipline !== "course")) return;

    void (async () => {
      try {
        if (discipline === "velo") {
          if (value === "") {
            await updateLinkVeloCategory(sessionId, null);
          } else if (isVeloCategory(value)) {
            await updateLinkVeloCategory(sessionId, value);
          } else {
            return;
          }
        } else if (isCourseCategory(value)) {
          await updateLinkCourseCategory(sessionId, value);
        } else {
          return;
        }
        await refreshAllUploadLists();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Mise à jour catégorie impossible", err);
        alert("Impossible de mettre à jour la catégorie.");
      }
    })();
  });

}

function garminServerBase(): string {
  const raw = import.meta.env.VITE_GARMIN_SERVER_URL?.trim();
  if (raw) return raw.replace(/\/$/, "");
  return "http://127.0.0.1:8787";
}

let garminBikeFolderBootstrapStarted = false;

type GarminBootstrapStats = {
  listed: number;
  fetched: number;
  decoded: number;
  skippedExisting: number;
  skippedNonFit: number;
  fetchErrors: number;
  decodeErrors: number;
  lastMessage: string;
};

let lastGarminBootstrapStats: GarminBootstrapStats | null = null;

function publishGarminBootstrapStats(stats: GarminBootstrapStats): void {
  lastGarminBootstrapStats = stats;
  document.dispatchEvent(new CustomEvent("GARMIN_FIT_BOOTSTRAP_STATUS", { detail: stats }));
}

export function getLastGarminBootstrapStats(): GarminBootstrapStats | null {
  return lastGarminBootstrapStats;
}

/**
 * Au démarrage : lit les `.fit` déjà présents dans `public/fit/bike/` via l’API locale du serveur Garmin,
 * les décode, puis les persiste dans IndexedDB comme l’ancien flux d’upload.
 */
export async function bootstrapFitSessionsFromGarminBikeFolder(): Promise<void> {
  if (garminBikeFolderBootstrapStarted) return;
  garminBikeFolderBootstrapStarted = true;

  publishGarminBootstrapStats({
    listed: 0,
    fetched: 0,
    decoded: 0,
    skippedExisting: 0,
    skippedNonFit: 0,
    fetchErrors: 0,
    decodeErrors: 0,
    lastMessage: "Bootstrap Garmin: initialisation…",
  });

  const base = garminServerBase();
  type ListResp = { files?: { name: string; size?: number; mtimeMs?: number }[] };
  let list: ListResp;
  try {
    const r = await fetch(`${base}/api/garmin/fit/bike/list`, { method: "GET" });
    if (!r.ok) {
      publishGarminBootstrapStats({
        listed: 0,
        fetched: 0,
        decoded: 0,
        skippedExisting: 0,
        skippedNonFit: 0,
        fetchErrors: 1,
        decodeErrors: 0,
        lastMessage: `Bootstrap Garmin: échec liste (HTTP ${r.status}).`,
      });
      return;
    }
    list = (await r.json()) as ListResp;
  } catch {
    publishGarminBootstrapStats({
      listed: 0,
      fetched: 0,
      decoded: 0,
      skippedExisting: 0,
      skippedNonFit: 0,
      fetchErrors: 1,
      decodeErrors: 0,
      lastMessage: "Bootstrap Garmin: échec liste (exception fetch).",
    });
    return;
  }

  const files = Array.isArray(list.files) ? list.files : [];
  if (files.length === 0) {
    publishGarminBootstrapStats({
      listed: 0,
      fetched: 0,
      decoded: 0,
      skippedExisting: 0,
      skippedNonFit: 0,
      fetchErrors: 0,
      decodeErrors: 0,
      lastMessage: "Aucun .fit listé par le serveur Node.",
    });
    return;
  }

  const stats: GarminBootstrapStats = {
    listed: files.length,
    fetched: 0,
    decoded: 0,
    skippedExisting: 0,
    skippedNonFit: 0,
    fetchErrors: 0,
    decodeErrors: 0,
    lastMessage: `Bootstrap Garmin: ${files.length} fichier(s) listé(s).`,
  };
  publishGarminBootstrapStats(stats);

  const disciplinesTouched = new Set<Discipline>();
  try {
    for (const f of files) {
      const name = f?.name;
      if (!name || !name.toLowerCase().endsWith(".fit")) continue;

      let data: ArrayBuffer;
      let ct = "";
      try {
        // Le binaire est servi par Vite (public/fit/bike/*) : pas besoin d’un endpoint Node.
        const url = `/fit/bike/${encodeURIComponent(name)}`;
        const r = await fetch(url, { headers: { Accept: "application/octet-stream" } });
        ct = r.headers.get("content-type") || "";
        if (!r.ok) {
          // eslint-disable-next-line no-console
          console.warn(`FIT HTTP ${r.status}: ${url} (content-type=${ct || "?"})`);
          stats.fetchErrors += 1;
          stats.lastMessage = `Erreur HTTP ${r.status} sur ${name}`;
          publishGarminBootstrapStats(stats);
          continue;
        }
        data = await r.arrayBuffer();
        stats.fetched += 1;
      } catch {
        stats.fetchErrors += 1;
        stats.lastMessage = `Fetch impossible: ${name}`;
        publishGarminBootstrapStats(stats);
        continue;
      }

      const header = new Uint8Array(data.slice(0, 16));
      const isFit =
        header.length >= 12 &&
        header[8] === 0x2e && // .
        header[9] === 0x46 && // F
        header[10] === 0x49 && // I
        header[11] === 0x54; // T
      if (!isFit) {
        // eslint-disable-next-line no-console
        console.warn(
          `Fichier ignoré (signature non FIT): ${name} — HTTP content-type=${ct || "?"} — taille=${data.byteLength} — premiersOctets=${Array.from(header)}`
        );
        stats.skippedNonFit += 1;
        const oct = Array.from(header)
          .slice(0, 12)
          .map((x) => x.toString(16).padStart(2, "0"))
          .join(" ");
        stats.lastMessage = `Ignoré (non FIT): ${name} (content-type=${ct || "?"}, octets=${oct})`;
        publishGarminBootstrapStats(stats);
        continue;
      }

      const id = await sha256Hex(data);
      if (await hasSession(id)) {
        stats.skippedExisting += 1;
        continue;
      }

      const upload: FitUpload = {
        id,
        fileName: name,
        size: typeof f.size === "number" ? f.size : data.byteLength,
        data,
        updatedAt: typeof f.mtimeMs === "number" ? f.mtimeMs : Date.now(),
      };
      const result = await decodeAndPersist(upload, { silent: true });
      if (!result) {
        stats.decodeErrors += 1;
        stats.lastMessage = `Échec décodage: ${name}`;
        publishGarminBootstrapStats(stats);
        continue;
      }
      stats.decoded += 1;
      stats.lastMessage = `Décodé: ${name} (${stats.decoded}/${stats.listed})`;
      publishGarminBootstrapStats(stats);

      const { discipline, sessionId } = result;
      disciplinesTouched.add(discipline);

      if (discipline === "velo") {
        const category = inferVeloCategoryFromFileName(name);
        if (category) await updateLinkVeloCategory(sessionId, category);
      }
      if (discipline === "course") {
        await updateLinkCourseCategory(sessionId, inferCourseCategoryFromFileName(name));
      }
    }
  } finally {
    await refreshFtpFromVeloSessionsBadge();
    const panel = resolveEntrainementPanel();
    if (panel?.isConnected) {
      await refreshAllUploadLists();
      for (const d of disciplinesTouched) expandUploadsAccordion(panel, d);
    }
    stats.lastMessage = `Bootstrap terminé: ${stats.decoded} décodé(s), ${stats.skippedExisting} déjà présent(s), ${stats.skippedNonFit} ignoré(s), ${stats.fetchErrors} erreur(s) fetch, ${stats.decodeErrors} erreur(s) décodage.`;
    publishGarminBootstrapStats(stats);
    // eslint-disable-next-line no-console
    console.info(stats.lastMessage);
  }
}

// Import dynamique du SDK Garmin — évite les problèmes de résolution de types
// car @garmin/fitsdk est un module JS pur sans déclarations TypeScript incluses.
let _garminSdk: { Decoder: any; Stream: any } | undefined;
async function getGarminSdk(): Promise<{ Decoder: any; Stream: any }> {
  if (!_garminSdk) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    _garminSdk = await import("@garmin/fitsdk");
  }
  return _garminSdk!;
}

/**
 * Décode un fichier FIT binaire via le SDK officiel Garmin (@garmin/fitsdk).
 * Retourne le dictionnaire de messages indexés par type (camelCase + suffixe Mesgs).
 * Les champs sont en camelCase, les dates sont des Date JS, les valeurs sont mise à l'échelle.
 */
async function parseFitFile(data: ArrayBuffer): Promise<Record<string, any[]>> {
  const { Decoder, Stream } = await getGarminSdk();
  const stream = Stream.fromArrayBuffer(data);
  if (!Decoder.isFIT(stream)) {
    throw new Error("Ce fichier n'est pas un fichier FIT valide.");
  }
  const decoder = new Decoder(stream);
  const { messages, errors } = decoder.read({
    convertTypesToStrings: true,
    convertDateTimesToDates: true,
    mergeHeartRates: true,
    applyScaleAndOffset: true,
    expandSubFields: true,
    expandComponents: true,
  });
  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.warn("FIT decode warnings:", errors);
  }
  return messages as Record<string, any[]>;
}

function pickFirst<T>(arr: T[] | undefined | null): T | undefined {
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : undefined;
}

/**
 * Première session utile (activité principale).
 * Avec @garmin/fitsdk, les sessions sont dans messages.sessionMesgs.
 */
function pickSessionFromFit(messages: Record<string, any[]>): any {
  return pickFirst(messages?.sessionMesgs);
}

function formatSportLabel(sport: unknown, subSport: unknown): string {
  const parts: string[] = [];
  if (sport !== undefined && sport !== null && sport !== "") parts.push(String(sport));
  if (subSport !== undefined && subSport !== null && subSport !== "" && String(subSport) !== String(sport)) {
    parts.push(String(subSport));
  }
  return parts.join(" — ") || "inconnu";
}

function mapSportToDiscipline(
  sport: unknown,
  subSport: unknown
): { discipline: Discipline; label: string } | null {
  if (sport === undefined || sport === null || sport === "") return null;

  const label = formatSportLabel(sport, subSport);

  // Le SDK Garmin avec convertTypesToStrings:true retourne des chaînes camelCase
  // ex. "cycling", "swimming", "running", subSport "openWater", "indoorCycling"…
  const s = String(sport).toLowerCase().replace(/[_-]/g, "");
  const ss = subSport != null ? String(subSport).toLowerCase().replace(/[_-]/g, "") : "";

  const swim =
    /swim|openwater|lapswimming|pool|natation|aquabike|aqua/i.test(s) ||
    /swim|openwater|lapswimming|pool/i.test(ss);
  const bike =
    /cycl|bike|biking|velo|vélo|bmx|ebike|indoorcycling|spin|trainer|virtualcycl|gravel/i.test(s) ||
    /cycl|bike|indoor|trainer|spin|gravel/i.test(ss);
  const run =
    /run|footing|trail|treadmill|virtualrun|track|jog|ultrarun/i.test(s) ||
    /run|trail|treadmill|track/i.test(ss);

  if (swim && !bike && !run) return { discipline: "natation", label };
  if (bike && !swim) return { discipline: "velo", label };
  if (run && !swim) return { discipline: "course", label };
  if (swim) return { discipline: "natation", label };
  if (bike) return { discipline: "velo", label };
  if (run) return { discipline: "course", label };
  return null;
}

/**
 * Déduit natation / vélo / course à pied depuis les messages FIT.
 * @garmin/fitsdk : sessions dans messages.sessionMesgs, sports dans messages.sportMesgs.
 * Champs camelCase : session.sport, session.subSport (vs snake_case de l'ancien parser).
 */
function inferDisciplineFromFit(
  messages: Record<string, any[]>
): { discipline: Discipline; label: string } | null {
  const sessions: any[] = Array.isArray(messages?.sessionMesgs) ? messages.sessionMesgs : [];
  const sportMsg = pickFirst(messages?.sportMesgs);

  const toScan = sessions.length > 0 ? sessions : [sportMsg].filter(Boolean);

  for (const s of toScan) {
    const sport = s?.sport ?? sportMsg?.sport;
    const subSport = s?.subSport ?? sportMsg?.subSport;
    const mapped = mapSportToDiscipline(sport, subSport);
    if (mapped) return mapped;
  }

  if (sportMsg) {
    return mapSportToDiscipline(sportMsg.sport, sportMsg.subSport);
  }

  return null;
}

function normalizeDateMs(v: unknown): number | undefined {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v as any);
    const ms = d.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

/**
 * Construit le résumé décodé depuis les messages @garmin/fitsdk.
 *
 * Différences clés vs l'ancien fit-file-parser :
 *  - Champs camelCase  (totalTimerTime, avgHeartRate, avgSpeed, avgPower…)
 *  - Dates → Date JS   (avec convertDateTimesToDates:true)
 *  - Distances en m    (avec applyScaleAndOffset:true) → diviser par 1000 pour km
 *  - Vitesses en m/s   → multiplier par 3.6 pour km/h
 *  - Records dans      messages.recordMesgs
 *  - Workouts dans     messages.workoutMesgs  (wktName au lieu de wkt_name)
 */
function buildDecodedFromFit(messages: Record<string, any[]>, activityTypeLabel?: string): FitDecoded {
  const session = pickSessionFromFit(messages);
  const records: any[] = Array.isArray(messages?.recordMesgs) ? messages.recordMesgs : [];

  const startMs =
    normalizeDateMs(session?.startTime) ??
    normalizeDateMs(pickFirst(records)?.timestamp) ??
    undefined;

  // Durée en secondes (scale 1000 déjà appliquée → valeur en s)
  const totalTimer =
    typeof session?.totalTimerTime === "number" ? session.totalTimerTime : undefined;

  // Distance en mètres (scale 100 déjà appliquée → valeur en m) → km
  const totalDistM =
    typeof session?.totalDistance === "number" ? session.totalDistance : undefined;
  const totalDist = totalDistM !== undefined ? totalDistM / 1000 : undefined;

  const avgHr = session?.avgHeartRate;
  const maxHr = session?.maxHeartRate;

  // Vitesse en m/s (scale 1000 déjà appliquée) → km/h
  const avgSpeedMs = session?.avgSpeed ?? session?.enhancedAvgSpeed;
  const avgSpeed = typeof avgSpeedMs === "number" ? avgSpeedMs * 3.6 : undefined;

  const avgPower = session?.avgPower;
  const maxPower = session?.maxPower;

  const summary: FitSummaryRow[] = [];
  if (activityTypeLabel) summary.push({ label: "Type d'activité", value: activityTypeLabel });
  if (startMs) summary.push({ label: "Début", value: formatDate(startMs) });
  if (typeof totalTimer === "number") summary.push({ label: "Durée", value: formatDurationSeconds(totalTimer) });
  if (typeof totalDist === "number") summary.push({ label: "Distance", value: `${formatNumber(totalDist, 2)} km` });
  if (typeof avgHr === "number") summary.push({ label: "FC moyenne", value: `${formatNumber(avgHr, 0)} bpm` });
  if (typeof maxHr === "number") summary.push({ label: "FC max", value: `${formatNumber(maxHr, 0)} bpm` });
  if (typeof avgSpeed === "number") summary.push({ label: "Vitesse moyenne", value: `${formatNumber(avgSpeed, 1)} km/h` });
  if (typeof avgPower === "number") summary.push({ label: "Puissance moyenne", value: `${formatNumber(avgPower, 0)} W` });
  if (typeof maxPower === "number") summary.push({ label: "Puissance max", value: `${formatNumber(maxPower, 0)} W` });

  // Série temporelle pour un graphique de séance individuelle (FC en priorité, sinon vitesse)
  const hrPoints: { t: number; y: number }[] = [];
  const speedPoints: { t: number; y: number }[] = [];
  for (const r of records) {
    const t = normalizeDateMs(r?.timestamp);
    if (!t) continue;
    if (typeof r?.heartRate === "number") hrPoints.push({ t, y: r.heartRate });
    // Vitesse record : m/s → km/h
    const sp = r?.enhancedSpeed ?? r?.speed;
    if (typeof sp === "number") speedPoints.push({ t, y: sp * 3.6 });
  }

  const downsample = (pts: { t: number; y: number }[], max = 500) => {
    if (pts.length <= max) return pts;
    const step = Math.ceil(pts.length / max);
    const out: { t: number; y: number }[] = [];
    for (let i = 0; i < pts.length; i += step) out.push(pts[i]);
    return out;
  };

  let series: FitSeries | undefined;
  if (hrPoints.length >= 2) {
    series = { label: "Fréquence cardiaque", unit: "bpm", points: downsample(hrPoints) };
  } else if (speedPoints.length >= 2) {
    series = { label: "Vitesse", unit: "km/h", points: downsample(speedPoints) };
  }

  if (summary.length === 0) {
    summary.push({ label: "Info", value: "Fichier FIT décodé (données limitées)." });
  }

  // Métriques numériques brutes (pour graphiques)
  const metrics: FitMetrics = {};
  if (typeof totalTimer === "number") metrics.totalTimerS = totalTimer;
  if (typeof totalDist === "number") metrics.totalDistKm = totalDist;
  if (typeof avgHr === "number") metrics.avgHr = avgHr;
  if (typeof avgSpeed === "number") metrics.avgSpeedKmh = avgSpeed;
  if (typeof avgPower === "number") metrics.avgPowerW = avgPower;
  if (typeof maxPower === "number") metrics.maxPowerW = maxPower;

  // Fallback : avgPowerW calculé depuis les records si le champ session est absent
  if (!metrics.avgPowerW) {
    const powerPts = records
      .map((r) => r?.power)
      .filter((p): p is number => typeof p === "number" && p > 0);
    if (powerPts.length > 0) {
      metrics.avgPowerW = powerPts.reduce((a, b) => a + b, 0) / powerPts.length;
    }
  }

  // Puissance normalisée (Pn) — calculée depuis les records bruts
  const pn = computeNormalizedPower(records);
  if (pn !== undefined) metrics.pnW = pn;

  const best20 = computeBestAvgPowerInTimeWindowW(records, 20 * 60);
  if (best20 !== undefined) metrics.best20MinAvgPowerW = best20;

  return { summary, series, metrics };
}

// ─── Calculs de performance cyclisme ───────────────────────────────────────────

/**
 * Puissance normalisée (NP / Pn) à partir d'une liste de records FIT.
 * Algorithme standard : moyenne glissante 30 s → puissance 4 → racine 4.
 * Suppose ≈ 1 enregistrement par seconde (Garmin 1 Hz).
 */
function computeNormalizedPower(records: any[]): number | undefined {
  const powers: number[] = [];
  for (const r of records) {
    const p = r?.power;
    if (typeof p === "number" && p >= 0) powers.push(p);
  }
  if (powers.length === 0) return undefined;

  const WINDOW = 30;
  const rollingAvgs: number[] = [];
  let windowSum = 0;

  for (let i = 0; i < powers.length; i++) {
    windowSum += powers[i];
    if (i >= WINDOW) windowSum -= powers[i - WINDOW];
    rollingAvgs.push(windowSum / Math.min(i + 1, WINDOW));
  }

  const avg4 = rollingAvgs.reduce((s, v) => s + Math.pow(v, 4), 0) / rollingAvgs.length;
  return Math.pow(avg4, 0.25);
}

/**
 * Meilleure puissance moyenne sur une fenêtre glissante de `windowSec` (temps réel entre timestamps).
 * Utilisé pour une FTP indicative ≈ 95 % × max (règle classique « test 20 min »).
 */
function computeBestAvgPowerInTimeWindowW(records: any[], windowSec: number): number | undefined {
  const pts: { t: number; p: number }[] = [];
  for (const r of records) {
    const t = normalizeDateMs(r?.timestamp);
    const p = r?.power;
    if (t === undefined || typeof p !== "number" || p < 0) continue;
    pts.push({ t, p });
  }
  if (pts.length === 0) return undefined;
  pts.sort((a, b) => a.t - b.t);
  const spanSec = (pts[pts.length - 1].t - pts[0].t) / 1000;
  if (spanSec < windowSec * 0.98) return undefined;

  const winMs = windowSec * 1000;
  let j = 0;
  let sum = 0;
  let best = 0;

  for (let i = 0; i < pts.length; i++) {
    const tEnd = pts[i].t + winMs;
    while (j < pts.length && pts[j].t <= tEnd) {
      sum += pts[j].p;
      j++;
    }
    const cnt = j - i;
    if (cnt > 0) best = Math.max(best, sum / cnt);
    sum -= pts[i].p;
  }

  return best > 0 ? best : undefined;
}

const FTP_HINT_FROM_20MIN_FACTOR = 0.95;
const MIN_DURATION_SEC_FOR_AVG_POWER_FALLBACK = 20 * 60;

/**
 * FTP « calculée » (indicative) : 95 % de la meilleure moyenne sur 20 min parmi les séances vélo,
 * sinon 95 % de la meilleure puissance moyenne de séance d’au moins 20 min (sans détail seconde/seconde).
 */
export async function computeEstimatedFtpWFromVeloSessions(): Promise<number | undefined> {
  const links = await listLinks("velo");
  let bestHintW = 0;

  for (const l of links) {
    const session = await getSession(l.sessionId);
    if (!session) continue;
    const m = session.decoded.metrics;
    if (!m) continue;

    if (typeof m.best20MinAvgPowerW === "number" && m.best20MinAvgPowerW > 0) {
      bestHintW = Math.max(bestHintW, FTP_HINT_FROM_20MIN_FACTOR * m.best20MinAvgPowerW);
    } else if (
      (m.totalTimerS ?? 0) >= MIN_DURATION_SEC_FOR_AVG_POWER_FALLBACK &&
      typeof m.avgPowerW === "number" &&
      m.avgPowerW > 0
    ) {
      bestHintW = Math.max(bestHintW, FTP_HINT_FROM_20MIN_FACTOR * m.avgPowerW);
    }
  }

  return bestHintW > 0 ? Math.round(bestHintW) : undefined;
}

/** Met à jour le libellé rouge « FTP estimée » à côté du champ FTP (menu gauche). */
export async function refreshFtpFromVeloSessionsBadge(): Promise<void> {
  const el = document.getElementById("ftp-rail-estimate");
  if (!el) return;
  const est = await computeEstimatedFtpWFromVeloSessions();
  if (est === undefined) {
    el.textContent = "—";
    el.setAttribute(
      "title",
      "Aucune estimation : importez des séances vélo avec enregistrement de la puissance sur au moins 20 minutes (suivi d’entraînement). Les fichiers importés avant cette fonction doivent être réimportés pour calculer la moyenne 20 min."
    );
  } else {
    el.textContent = `≈ ${est} W`;
    el.setAttribute(
      "title",
      "Indicatif : 95 % de la meilleure moyenne de puissance sur 20 minutes trouvée dans vos FIT vélo. Si l’historique ne contient pas 20 min continues de puissance, on utilise 95 % de la puissance moyenne des séances d’au moins 20 min. Ce n’est pas un test de FTP en laboratoire."
    );
  }
}

/**
 * Training Stress Score avec durée.
 * TSS = (t × Pn × IF) / (FTP × 3600) × 100  — IF = Pn / FTP
 * Utilisé pour Endurance et Sortie Longue.
 */
function computeTSS(durationS: number, pn: number, ftp: number): number {
  if (ftp <= 0) return 0;
  const IF = pn / ftp;
  return (durationS * pn * IF) / (ftp * 3600) * 100;
}

/**
 * Score d'intensité pure (sans durée).
 * = IF² × 100 = (Pn / FTP)² × 100
 * Utilisé pour Montagne où la durée varie peu et l'intensité prime.
 */
function computeTSSIntensity(pn: number, ftp: number): number {
  if (ftp <= 0) return 0;
  const IF = pn / ftp;
  return IF * IF * 100;
}

/**
 * Charge d'entraînement CAP (même structure que le TSS vélo) : (durée h) × IF² × 100.
 * IF = vitesse_moyenne / VMA  (plus vite ⇒ IF > 1).
 */
function computeRunLoad(durationS: number, distanceKm: number, vmaKmh: number): number | undefined {
  if (distanceKm <= 0 || durationS <= 0 || vmaKmh <= 0) return undefined;
  const avgSpeedKmh = distanceKm / (durationS / 3600);
  const IF = avgSpeedKmh / vmaKmh;
  return (durationS / 3600) * IF * IF * 100;
}

function formatPaceFromDurationDistance(durationS: number, distanceKm: number): string {
  if (distanceKm <= 0) return "—";
  const minPerKm = durationS / 60 / distanceKm;
  const totalSec = Math.round(minPerKm * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

// ─── Graphique Vélo ────────────────────────────────────────────────────────────

type VeloChartPoint = {
  sessionId: string;
  dateMs: number;
  tssScore: number;
  pnW: number;
  durationS: number;
  fileName: string;
  veloCategory?: VeloCategory;
};

type VeloChartGroup = {
  label: string;
  category: VeloCategory;
  /** Si false, le TSS est calculé sans la durée (intensité pure : IF² × 100). */
  withDuration: boolean;
  /** Durée minimale pour l'échelle couleur (secondes). */
  minDurS: number;
  /** Durée maximale pour l'échelle couleur (secondes). */
  maxDurS: number;
};

/** Les 3 graphiques vélo, un par catégorie. */
const VELO_CHART_GROUPS: readonly VeloChartGroup[] = [
  { label: "Montagne",      category: "montagne",      withDuration: false, minDurS: 2700,  maxDurS: 5700  }, // 45 min → 1 h 35
  { label: "Endurance",     category: "endurance",     withDuration: true,  minDurS: 2700,  maxDurS: 6000  }, // 45 min → 1 h 40
  { label: "Sortie Longue", category: "sortie-longue", withDuration: true,  minDurS: 3000,  maxDurS: 8400  }, // 50 min → 2 h 20
  { label: "Strength",      category: "strength",      withDuration: false, minDurS: 900,   maxDurS: 5400  }, // 15 min → 1 h 30
];

type CourseChartGroup = {
  label: string;
  category: CourseCategory;
  minDurS: number;
  maxDurS: number;
};

/** Trois graphiques CAP : fractionnées (VMA), sorties longues, sorties tranquilles. */
const COURSE_CHART_GROUPS: readonly CourseChartGroup[] = [
  { label: "Fractionnées", category: "fractionnee", minDurS: 1200, maxDurS: 5400 }, // 20 min → 1 h 30
  { label: "Sorties longues", category: "sortie-longue", minDurS: 3600, maxDurS: 10800 }, // 1 h → 3 h
  { label: "Sorties tranquilles", category: "sortie-tranquille", minDurS: 1200, maxDurS: 7200 }, // 20 min → 2 h
];

/** Point générique pour les graphiques de progression (vélo ou CAP). */
type ScatterProgressPoint = {
  dateMs: number;
  y: number;
  durationS: number;
  tooltip: string;
  /** Identifiant séance FIT (lien avec la liste « Fichiers importés »). */
  sessionId: string;
};

/**
 * Encode la durée en couleur : court = orange → moyen = violet → long = bleu.
 * t ∈ [0, 1]  (0 = ≤ 30 min, 1 = ≥ 3 h)
 */
function durationToColor(t: number): string {
  let r: number, g: number, b: number;
  if (t <= 0.5) {
    const u = t * 2;
    r = Math.round(0xf9 + u * (0xa8 - 0xf9));
    g = Math.round(0x73 + u * (0x55 - 0x73));
    b = Math.round(0x16 + u * (0xf7 - 0x16));
  } else {
    const u = (t - 0.5) * 2;
    r = Math.round(0xa8 + u * (0x3b - 0xa8));
    g = Math.round(0x55 + u * (0x82 - 0x55));
    b = Math.round(0xf7 + u * (0xf6 - 0xf7));
  }
  return `rgb(${r},${g},${b})`;
}

/** Régression linéaire y = ax + b (moindres carrés) et coefficient de détermination R². */
type LinearRegression = { a: number; b: number; r2: number };

function computeLinearRegression(xs: number[], ys: number[]): LinearRegression | null {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;

  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  if (sxx < 1e-12) return null;

  const a = sxy / sxx;
  const b = meanY - a * meanX;

  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const e = ys[i] - (a * xs[i] + b);
    ssRes += e * e;
  }

  const r2 = syy < 1e-12 ? 1 : 1 - ssRes / syy;
  return { a, b, r2: Math.max(0, Math.min(1, r2)) };
}

/** Libellé de la tendance (pente de la droite : score vs temps), pas le nom de la méthode statistique. */
function slopeTrendLabel(a: number, tRange: number, yRange: number): string {
  const deltaY = a * tRange;
  if (Math.abs(deltaY) < yRange * 0.03) return "Stagnation";
  if (a > 0) return "Progression";
  return "Régression";
}

/**
 * Construit le SVG du nuage de points (progression + régression linéaire).
 * @param pts     Points à afficher (déjà triés chronologiquement).
 * @param gradId  Identifiant unique du gradient SVG (évite les conflits d'id entre graphiques).
 * @param minDurS Durée min de l'échelle couleur (secondes).
 * @param maxDurS Durée max de l'échelle couleur (secondes).
 */
function buildScatterProgressSvg(
  pts: ScatterProgressPoint[],
  gradId: string,
  minDurS: number,
  maxDurS: number,
  opts: { yAxisLabel: string; ariaLabel: string }
): string {
  const W = 580, H = 280;
  const PAD = { t: 24, r: 24, b: 76, l: 62 };
  const pw = W - PAD.l - PAD.r;
  const ph = H - PAD.t - PAD.b;

  // Y : borné sur min/max réels des données + 10 % de marge
  const rawMin = Math.min(...pts.map((p) => p.y));
  const rawMax = Math.max(...pts.map((p) => p.y));
  const wRange = rawMax - rawMin || 10;
  const margin = Math.max(5, wRange * 0.12);
  const yMin = Math.max(0, Math.floor((rawMin - margin) / 5) * 5);
  const yMax = Math.ceil((rawMax + margin) / 5) * 5;
  const yRange = yMax - yMin;

  const minT = Math.min(...pts.map((p) => p.dateMs));
  const maxT = Math.max(...pts.map((p) => p.dateMs));
  const tRange = maxT - minT || 1;

  const toX = (ms: number) =>
    pts.length === 1 ? PAD.l + pw / 2 : PAD.l + ((ms - minT) / tRange) * pw;
  const toY = (w: number) => PAD.t + ph - ((w - yMin) / yRange) * ph;

  const DOT_R = 7;
  const durRange = maxDurS - minDurS || 1;

  // Grille horizontale (≈ 6 lignes, valeurs entières arrondies)
  const nGrid = 5;
  const yStep = yRange / nGrid;
  const gridLines = Array.from({ length: nGrid + 1 }, (_, i) => {
    const w = yMin + i * yStep;
    const y = toY(w).toFixed(1);
    return `<line x1="${PAD.l}" y1="${y}" x2="${W - PAD.r}" y2="${y}" stroke="${i === 0 ? "#d4d4d8" : "#f0f0f1"}" stroke-width="1"/>
<text x="${PAD.l - 6}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="11" fill="#71717a">${Math.round(w)}</text>`;
  }).join("\n");

  // Axes
  const axes = `<line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${PAD.t + ph}" stroke="#c4c4c8" stroke-width="1.5"/>
<line x1="${PAD.l}" y1="${PAD.t + ph}" x2="${W - PAD.r}" y2="${PAD.t + ph}" stroke="#c4c4c8" stroke-width="1.5"/>`;

  // Label axe Y
  const midY = (PAD.t + ph / 2).toFixed(0);
  const yAxisLabel = `<text x="13" y="${midY}" text-anchor="middle" dominant-baseline="middle" font-size="11" fill="#52525b" transform="rotate(-90 13 ${midY})">${escapeHtml(opts.yAxisLabel)}</text>`;

  // Labels axe X (max 8 labels)
  const labelStep = Math.max(1, Math.ceil(pts.length / 8));
  const xLabels = pts
    .filter((_, i) => i % labelStep === 0 || i === pts.length - 1)
    .map((p) => {
      const x = toX(p.dateMs).toFixed(1);
      const lbl = new Date(p.dateMs).toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
      return `<text x="${x}" y="${PAD.t + ph + 16}" text-anchor="middle" font-size="10" fill="#71717a">${lbl}</text>`;
    })
    .join("\n");

  // Droite de régression linéaire (moindres carrés) : Y en fonction de la date
  const xs = pts.map((p) => p.dateMs);
  const ys = pts.map((p) => p.y);
  const reg = computeLinearRegression(xs, ys);
  let regressionLayer = "";
  if (reg) {
    const y1 = reg.a * minT + reg.b;
    const y2 = reg.a * maxT + reg.b;
    const x1s = toX(minT).toFixed(1);
    const y1s = toY(y1).toFixed(1);
    const x2s = toX(maxT).toFixed(1);
    const y2s = toY(y2).toFixed(1);
    const trend = slopeTrendLabel(reg.a, tRange, yRange);
    const r2Str = reg.r2.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const statsY = (PAD.t + 14).toFixed(0);
    regressionLayer = `<line x1="${x1s}" y1="${y1s}" x2="${x2s}" y2="${y2s}" stroke="#1c70e2" stroke-width="2" stroke-linecap="round"/>
<text x="${(W - PAD.r).toFixed(0)}" y="${statsY}" text-anchor="end" font-size="10" fill="#3f3f46">Régularité (R²) = ${r2Str} · Tendance : ${trend}</text>`;
  }

  // Points colorés par durée
  const circles = pts
    .map((p) => {
      const x = toX(p.dateMs).toFixed(1);
      const y = toY(p.y).toFixed(1);
      const t = Math.max(0, Math.min(1, (p.durationS - minDurS) / durRange));
      const color = durationToColor(t);
      const tip = escapeHtml(p.tooltip);
      const sid = escapeHtml(p.sessionId);
      return `<circle class="progress-chart__dot" cx="${x}" cy="${y}" r="${DOT_R}" fill="${color}" stroke="#fff" stroke-width="2" data-session-id="${sid}" role="graphics-symbol" aria-label="Séance — cliquer pour sélectionner le fichier dans la liste"><title>${tip}</title></circle>`;
    })
    .join("\n");

  // Légende dégradé en bas
  const lgX = PAD.l, lgY = H - 30, lgW = pw, lgH = 8;
  const gradStops = Array.from({ length: 10 }, (_, i) => {
    const t = i / 9;
    return `<stop offset="${(t * 100).toFixed(0)}%" stop-color="${durationToColor(t)}"/>`;
  }).join("");
  const legend = `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="0">${gradStops}</linearGradient></defs>
<rect x="${lgX}" y="${lgY}" width="${lgW}" height="${lgH}" rx="4" fill="url(#${gradId})"/>
<text x="${lgX}" y="${lgY + lgH + 12}" text-anchor="start" font-size="10" fill="#71717a">${escapeHtml(formatDurationSeconds(minDurS))}</text>
<text x="${lgX + lgW / 2}" y="${lgY + lgH + 12}" text-anchor="middle" font-size="10" fill="#71717a">${escapeHtml(formatDurationSeconds(Math.round((minDurS + maxDurS) / 2)))}</text>
<text x="${lgX + lgW}" y="${lgY + lgH + 12}" text-anchor="end" font-size="10" fill="#71717a">${escapeHtml(formatDurationSeconds(maxDurS))}</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" class="progress-chart__svg" role="img" aria-label="${escapeHtml(opts.ariaLabel)}">
${legend}
${yAxisLabel}
${gridLines}
${axes}
${xLabels}
${regressionLayer}
${circles}
</svg>`;
}

async function renderVeloChart(root: HTMLElement): Promise<void> {
  const mount = root.querySelector<HTMLElement>('[data-training-block="velo"] .training-block__content');
  if (!mount) return;

  const ftp = getFtp();

  // Charger liens ET sessions ensemble pour avoir la catégorie (stockée dans le lien)
  const links = await listLinks("velo");
  const linked = (
    await Promise.all(
      links.map(async (l) => {
        const session = await getSession(l.sessionId);
        return session ? { link: l, session } : null;
      })
    )
  ).filter((x): x is { link: StoredFitLink; session: FitSession } => x !== null);

  if (linked.length === 0) {
    mount.innerHTML = `<p class="progress-chart__empty">Aucune séance vélo détectée. Utilisez le connecteur Garmin local pour récupérer des fichiers FIT.</p>`;
    return;
  }

  // Filtrer les séances ayant une puissance normalisée calculable
  const withPn = linked.filter(({ session: s }) => typeof s.decoded.metrics?.pnW === "number");

  if (withPn.length === 0) {
    mount.innerHTML = `<p class="progress-chart__empty">Puissance normalisée (Pn) introuvable dans les ${linked.length} séance(s) importée(s). Assurez-vous que votre compteur enregistre la puissance, puis réimportez vos fichiers.</p>`;
    return;
  }

  // Points bruts triés chronologiquement (TSS calculé par catégorie dans la boucle)
  type RawVeloPoint = Omit<VeloChartPoint, "tssScore">;
  const rawPoints: RawVeloPoint[] = withPn
    .slice()
    .sort((a, b) => (a.session.startMs ?? a.session.updatedAt) - (b.session.startMs ?? b.session.updatedAt))
    .map(({ link, session: s }) => ({
      sessionId: s.id,
      dateMs: s.startMs ?? s.updatedAt,
      pnW: s.decoded.metrics!.pnW!,
      durationS: s.decoded.metrics?.totalTimerS ?? 3600,
      fileName: s.fileName,
      veloCategory: link.veloCategory,
    }));

  // Un graphique par catégorie
  const sections = VELO_CHART_GROUPS.map(({ label, category, withDuration, minDurS, maxDurS }, idx) => {
    const ptsVelo: VeloChartPoint[] = rawPoints
      .filter((p) => p.veloCategory === category)
      .map((p) => ({
        ...p,
        tssScore: withDuration
          ? computeTSS(p.durationS, p.pnW, ftp)
          : computeTSSIntensity(p.pnW, ftp),
      }));

    if (ptsVelo.length === 0) {
      return `<div class="progress-chart">
  <h4 class="progress-chart__title">${escapeHtml(label)}</h4>
  <p class="progress-chart__empty">Aucune séance dans cette catégorie pour l'instant.</p>
</div>`;
    }

    const tssLabel = withDuration ? "TSS" : "Score intensité (IF² × 100)";
    const scatterPts: ScatterProgressPoint[] = ptsVelo.map((p) => {
      const dateStr = new Date(p.dateMs).toLocaleDateString("fr-FR", { dateStyle: "medium" });
      const dur = formatDurationSeconds(p.durationS);
      return {
        dateMs: p.dateMs,
        y: p.tssScore,
        durationS: p.durationS,
        sessionId: p.sessionId,
        tooltip: `${dateStr} — TSS: ${Math.round(p.tssScore)} — Pn: ${Math.round(p.pnW)} W — ${dur}`,
      };
    });
    const svg = buildScatterProgressSvg(scatterPts, `veloGrad-${idx}`, minDurS, maxDurS, {
      yAxisLabel: "TSS",
      ariaLabel: "Évolution du TSS vélo",
    });
    return `<div class="progress-chart">
  <h4 class="progress-chart__title">${escapeHtml(label)}</h4>
  ${svg}
  <p class="progress-chart__legend">Chaque point = 1 séance · ordonnée : <strong>${tssLabel}</strong> · couleur : durée. La droite indigo est un <strong>ajustement linéaire</strong> du score dans le temps : son <strong>inclinaison</strong> indique une tendance à la <strong>progression</strong>, à la <strong>stagnation</strong> ou à la <strong>régression</strong>. Le <strong>R²</strong> reflète la <strong>régularité</strong> du nuage autour de cette droite (proche de 1 = points très alignés sur la tendance). Survolez un point pour le détail · <strong>cliquez</strong> un point pour le surligner dans la liste des fichiers détectés (vélo).</p>
</div>`;
  });

  mount.innerHTML = `<div class="progress-charts">${sections.join("\n")}</div>`;
}

type CourseChartPoint = {
  sessionId: string;
  dateMs: number;
  load: number;
  durationS: number;
  distKm: number;
  fileName: string;
  courseCategory: CourseCategory;
};

async function renderCourseChart(root: HTMLElement): Promise<void> {
  const mount = root.querySelector<HTMLElement>('[data-training-block="course"] .training-block__content');
  if (!mount) return;

  const vmaKmh = getVmaCapKmh();

  const links = await listLinks("course");
  const linked = (
    await Promise.all(
      links.map(async (l) => {
        const session = await getSession(l.sessionId);
        return session ? { link: l, session } : null;
      })
    )
  ).filter((x): x is { link: StoredFitLink; session: FitSession } => x !== null);

  if (linked.length === 0) {
    mount.innerHTML = `<p class="progress-chart__empty">Aucune séance course détectée. Utilisez le connecteur Garmin local pour récupérer des fichiers FIT.</p>`;
    return;
  }

  const withDist = linked.filter(({ session: s }) => {
    const d = s.decoded.metrics?.totalDistKm;
    const t = s.decoded.metrics?.totalTimerS;
    return typeof d === "number" && d > 0 && typeof t === "number" && t > 0;
  });

  if (withDist.length === 0) {
    mount.innerHTML = `<p class="progress-chart__empty">Distance ou durée absente dans les ${linked.length} séance(s) course : impossible de calculer l’allure et la charge. Vérifiez vos enregistrements Garmin.</p>`;
    return;
  }

  const rawPoints: CourseChartPoint[] = withDist
    .slice()
    .sort((a, b) => (a.session.startMs ?? a.session.updatedAt) - (b.session.startMs ?? b.session.updatedAt))
    .map(({ link, session: s }) => {
      const durationS = s.decoded.metrics!.totalTimerS!;
      const distKm = s.decoded.metrics!.totalDistKm!;
      const load = computeRunLoad(durationS, distKm, vmaKmh) ?? 0;
      return {
        sessionId: s.id,
        dateMs: s.startMs ?? s.updatedAt,
        load,
        durationS,
        distKm,
        fileName: s.fileName,
        courseCategory: link.courseCategory ?? inferCourseCategoryFromFileName(s.fileName),
      };
    });

  const sections = COURSE_CHART_GROUPS.map(({ label, category, minDurS, maxDurS }, idx) => {
    const pts = rawPoints.filter((p) => p.courseCategory === category);

    if (pts.length === 0) {
      return `<div class="progress-chart">
  <h4 class="progress-chart__title">${escapeHtml(label)}</h4>
  <p class="progress-chart__empty">Aucune séance dans cette catégorie. Indiquez <strong>VMA</strong> dans le nom pour une fractionnée, <strong>sortie longue</strong> (éventuellement séparés par espace, tiret ou underscore) pour une sortie longue ; sinon la séance est considérée comme <strong>sortie tranquille</strong>.</p>
</div>`;
    }

    const scatterPts: ScatterProgressPoint[] = pts.map((p) => {
      const dateStr = new Date(p.dateMs).toLocaleDateString("fr-FR", { dateStyle: "medium" });
      const dur = formatDurationSeconds(p.durationS);
      const pace = formatPaceFromDurationDistance(p.durationS, p.distKm);
      return {
        dateMs: p.dateMs,
        y: p.load,
        durationS: p.durationS,
        sessionId: p.sessionId,
        tooltip: `${dateStr} — Charge: ${Math.round(p.load)} — ${pace} — ${formatNumber(p.distKm, 2)} km — ${dur}`,
      };
    });

    const svg = buildScatterProgressSvg(scatterPts, `courseGrad-${idx}`, minDurS, maxDurS, {
      yAxisLabel: "Charge",
      ariaLabel: "Évolution de la charge course à pied",
    });
    return `<div class="progress-chart">
  <h4 class="progress-chart__title">${escapeHtml(label)}</h4>
  ${svg}
  <p class="progress-chart__legend">Chaque point = 1 séance · ordonnée : <strong>charge</strong> (estimation type TSS à partir de l’allure et de votre <strong>allure seuil</strong>) · couleur : durée. Droite de tendance, <strong>R²</strong> (régularité) et libellé « Tendance » comme pour le vélo. Survolez un point pour le détail · <strong>cliquez</strong> un point pour le surligner dans la liste des fichiers détectés (course).</p>
</div>`;
  });

  mount.innerHTML = `<div class="progress-charts">${sections.join("\n")}</div>`;
}

// ───────────────────────────────────────────────────────────────────────────────

async function decodeAndPersist(
  upload: FitUpload,
  options: { silent?: boolean } = {}
): Promise<{ discipline: Discipline; sessionId: string } | null> {
  try {
    // Décodage via @garmin/fitsdk (import dynamique)
    const messages = await parseFitFile(upload.data);

    const inferred = inferDisciplineFromFit(messages);
    if (!inferred) {
      if (!options.silent) {
        alert(
          `Impossible de classer automatiquement « ${upload.fileName} » (natation / vélo / course). Vérifiez que le FIT contient un type d'activité reconnu.`
        );
      }
      return null;
    }
    const { discipline, label: activityTypeLabel } = inferred;
    const decoded = buildDecodedFromFit(messages, activityTypeLabel);

    const session: FitSession = {
      id: upload.id,
      fileName: upload.fileName,
      size: upload.size,
      updatedAt: upload.updatedAt,
      decoded,
    };

    // Date de début : champ startTime (Date JS) en priorité, sinon premier record
    const fitSession = pickSessionFromFit(messages);
    const recs: any[] = Array.isArray(messages?.recordMesgs) ? messages.recordMesgs : [];
    session.startMs =
      normalizeDateMs(fitSession?.startTime) ??
      normalizeDateMs(pickFirst(recs)?.timestamp) ??
      undefined;

    const link: StoredFitLink = {
      id: `${discipline}:${upload.id}`,
      discipline,
      sessionId: upload.id,
      linkedAt: upload.updatedAt,
    };
    await putSession(session);
    await putLink(link);
    return { discipline, sessionId: upload.id };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("FIT decode error", err);
    if (!options.silent) {
      alert(`Impossible de décoder ce fichier FIT : ${upload.fileName}`);
    }
    return null;
  }
}

async function refreshAllUploadLists(): Promise<void> {
  const root = resolveEntrainementPanel();
  if (!root?.isConnected) return;
  await Promise.all(DISCIPLINES.map((d) => renderUploadsList(root, d.id)));
  await renderVeloChart(root);
  await renderCourseChart(root);
  await refreshFtpFromVeloSessionsBadge();
}

function formatActivityDate(ms: number): string {
  return new Date(ms).toLocaleDateString("fr-FR", { dateStyle: "medium" });
}

function renderVeloCategorySelect(sessionId: string, stored: VeloCategory | undefined): string {
  const modClass = stored ? `uploads-item__cat-select--${escapeHtml(stored)}` : "uploads-item__cat-select--none";
  const veloOpts = [
    `<option value=""${stored ? "" : " selected"}>${escapeHtml("Non catégorisé")}</option>`,
    ...ALL_VELO_CATEGORIES.map(
      (c) =>
        `<option value="${escapeHtml(c)}"${stored === c ? " selected" : ""}>${escapeHtml(VELO_CATEGORY_LABELS[c])}</option>`
    ),
  ].join("");
  return `<label class="uploads-item__cat-label"><span class="uploads-item__cat-label-text">Catégorie</span><select class="uploads-item__cat-select ${modClass}" data-set-activity-category data-session-id="${escapeHtml(sessionId)}" data-discipline="velo" aria-label="Catégorie de la sortie vélo">${veloOpts}</select></label>`;
}

function renderCourseCategorySelect(sessionId: string, effective: CourseCategory): string {
  const modClass = `uploads-item__cat-select--${escapeHtml(effective)}`;
  const opts = ALL_COURSE_CATEGORIES.map(
    (c) =>
      `<option value="${escapeHtml(c)}"${effective === c ? " selected" : ""}>${escapeHtml(COURSE_CATEGORY_LABELS[c])}</option>`
  ).join("");
  return `<label class="uploads-item__cat-label"><span class="uploads-item__cat-label-text">Catégorie</span><select class="uploads-item__cat-select ${modClass}" data-set-activity-category data-session-id="${escapeHtml(sessionId)}" data-discipline="course" aria-label="Catégorie de la sortie course">${opts}</select></label>`;
}

async function renderUploadsList(root: HTMLElement, discipline: Discipline): Promise<void> {
  if (!root.isConnected) return;
  const ul = root.querySelector<HTMLUListElement>(`[data-uploads-list="${discipline}"]`);
  if (!ul) return;

  const links = await listLinks(discipline);
  // Garder le lien pour afficher la catégorie (vélo uniquement)
  const linked = (
    await Promise.all(
      links.map(async (l) => {
        const session = await getSession(l.sessionId);
        return session ? { link: l, session } : null;
      })
    )
  ).filter((x): x is { link: StoredFitLink; session: FitSession } => x !== null);

  linked.sort(
    (a, b) => (b.session.startMs ?? b.session.updatedAt) - (a.session.startMs ?? a.session.updatedAt)
  );

  if (linked.length === 0) {
    ul.innerHTML = `<li class="uploads-list__empty">Aucun fichier détecté.</li>`;
    return;
  }

  ul.innerHTML = linked
    .map(({ link, session: s }) => {
      const when = s.startMs ?? s.updatedAt;
      const delLabel = `Supprimer ${s.fileName}`;
      const catControl =
        discipline === "velo"
          ? renderVeloCategorySelect(s.id, link.veloCategory)
          : discipline === "course"
            ? renderCourseCategorySelect(s.id, link.courseCategory ?? inferCourseCategoryFromFileName(s.fileName))
            : "";
      return `<li class="uploads-item" data-session-id="${escapeHtml(s.id)}">
        <div class="uploads-item__info">
          <span class="uploads-item__name">${escapeHtml(s.fileName)}</span>
          <div class="uploads-item__meta">
            <span class="uploads-item__date">${escapeHtml(formatActivityDate(when))}</span>
            ${catControl}
          </div>
        </div>
        <button type="button" class="uploads-item__delete" data-delete-session="${escapeHtml(s.id)}" aria-label="${escapeHtml(delLabel)}">
          Supprimer
        </button>
      </li>`;
    })
    .join("");
}
