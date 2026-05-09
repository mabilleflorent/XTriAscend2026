/**
 * Utilitaires de calcul sportif : vitesse, allure, temps, durée, distance, heure.
 * Toutes les fonctions sont pures (pas de DOM, pas de localStorage, pas de réseau).
 */

// ─── Entiers / bornes ────────────────────────────────────────────────────────

export function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

// ─── Parse / format MM:SS et HH:MM ───────────────────────────────────────────

/** Parse `"MM:SS"` (ou `"M:SS"`) → secondes entières. Renvoie `null` si invalide. */
export function parseMMSS(raw: string): number | null {
  const s = raw.trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const mm = parseInt(m[1], 10);
  const ss = parseInt(m[2], 10);
  if (!Number.isFinite(mm) || !Number.isFinite(ss) || mm < 0 || ss < 0 || ss > 59) return null;
  return mm * 60 + ss;
}

/** Secondes → `"MM:SS"` (borné à 99:59). */
export function formatMMSS(totalSec: number): string {
  const s = clampInt(totalSec, 0, 99 * 60 + 59);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/**
 * Valide / normalise une chaîne `"HH:MM"` (format 24 h).
 * Renvoie la chaîne normalisée (`"03:00"`) ou `null` si invalide.
 */
export function normalizeHHMM(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// ─── Format durées ────────────────────────────────────────────────────────────

/**
 * Durée segment course/vélo (affichage tableau ETA).
 * Format : `"3 min 42 s"` ou `"1 h 03 min 12 s"`.
 */
export function formatEtaSplitTime(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const totalSec = Math.round(s);
  const m = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const m2 = m % 60;
    return `${h} h ${String(m2).padStart(2, "0")} min ${String(sec).padStart(2, "0")} s`;
  }
  return `${m} min ${String(sec).padStart(2, "0")} s`;
}

/**
 * Durée générique (liste d'activités, graphiques).
 * Format : `"1 h 03 min"` / `"42 min 05 s"` / `"8 s"`.
 */
export function formatDurationSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m > 0) return `${m} min ${String(sec).padStart(2, "0")} s`;
  return `${sec} s`;
}

// ─── Format heure ─────────────────────────────────────────────────────────────

/**
 * Heure absolue après `offsetSec` depuis le départ (`startH:startM:00`).
 * Format `"HH:MM:SS"`, avec `" (+N j)"` si lendemain ou plus.
 */
export function formatClockFromRaceStart(offsetSec: number, startH: number, startM: number): string {
  if (!Number.isFinite(offsetSec) || offsetSec < 0) return "—";
  const startSec = startH * 3600 + startM * 60;
  let x = startSec + offsetSec;
  const day = Math.floor(x / 86400);
  x = ((x % 86400) + 86400) % 86400;
  const hh = Math.floor(x / 3600);
  const mm = Math.floor((x % 3600) / 60);
  const ss = Math.floor(x % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  return day > 0 ? `${clock} (+${day} j)` : clock;
}

/**
 * Date-heure locale (activité FIT, liste entraînements).
 * Format `fr-FR` court : `"08/05/2026 21:30"`.
 */
export function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

/** Date medium `fr-FR` : `"8 mai 2026"` (liste d'uploads). */
export function formatActivityDate(ms: number): string {
  return new Date(ms).toLocaleDateString("fr-FR", { dateStyle: "medium" });
}

/** Convertit `Date` / string / number → timestamp ms. Renvoie `undefined` si invalide. */
export function normalizeDateMs(v: unknown): number | undefined {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v as string | number);
    const ms = d.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

// ─── Format allure (pace) ─────────────────────────────────────────────────────

/** `minPerKm` (float) → `"4:32 / km"`. Renvoie `"—"` si invalide. */
export function formatPaceMinPerKm(minPerKm: number): string {
  if (!Number.isFinite(minPerKm) || minPerKm <= 0) return "—";
  const totalSec = Math.round(minPerKm * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")} / km`;
}

/** Allure `"m:ss/km"` calculée depuis une durée (s) et une distance (km). */
export function formatPaceFromDurationDistance(durationS: number, distanceKm: number): string {
  if (distanceKm <= 0) return "—";
  const minPerKm = durationS / 60 / distanceKm;
  const totalSec = Math.round(minPerKm * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

// ─── Format distance / axe ────────────────────────────────────────────────────

/**
 * Pas d'axe « lisible » (1, 2, 5 × 10ⁿ) pour environ `targetSteps` intervalles.
 * Fonctionne sur tout domaine linéaire (mètres, secondes, watts…).
 */
export function niceAxisStepM(rangeM: number, targetSteps: number): number {
  if (rangeM <= 0 || targetSteps < 1) return 1;
  const rough = rangeM / targetSteps;
  const exp = Math.floor(Math.log10(rough));
  const base = 10 ** exp;
  const m = rough / base;
  const mult = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return mult * base;
}

/** Libellé axe X distance (mètres → km, sans décimales). */
export function formatDistanceKmLabel(dM: number, _stepM: number): string {
  return (dM / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 0 });
}

/**
 * Libellé axe X par discipline (km relatifs : nage depuis 0, vélo depuis fin nage, course depuis fin vélo).
 */
export function formatLegDistanceKmLabel(
  absDistanceM: number,
  _stepM: number,
  bikeEndAbsM: number,
  swimEndAbsM: number
): string {
  const d = Math.max(0, absDistanceM);
  let km: number;
  if (bikeEndAbsM > 1e-6 && d >= bikeEndAbsM - 1e-6) {
    km = (d - bikeEndAbsM) / 1000;
  } else if (swimEndAbsM > 1e-6 && d >= swimEndAbsM - 1e-6) {
    km = (d - swimEndAbsM) / 1000;
  } else {
    km = d / 1000;
  }
  return km.toLocaleString("fr-FR", { maximumFractionDigits: 0 });
}

/**
 * Texte overlay profil altimétrique : distance par discipline
 * (nage : absolue ; vélo : depuis fin nage ; course : depuis fin vélo).
 */
export function formatAltitudeHoverKm(
  distanceM: number,
  swimEndM: number,
  bikeEndM: number
): { line1: string; line2: string; leg: "swim" | "bike" | "run" } {
  const d = Math.max(0, distanceM);
  const fmt = (km: number) =>
    `${km.toLocaleString("fr-FR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} km`;

  if (swimEndM > 1e-6 && d < swimEndM - 1e-6) {
    return { line1: fmt(d / 1000), line2: "Natation", leg: "swim" };
  }
  if (bikeEndM > 1e-6 && d >= bikeEndM - 1e-6) {
    return { line1: fmt((d - bikeEndM) / 1000), line2: "Course à pied", leg: "run" };
  }
  const bikeKm = swimEndM > 1e-6 ? (d - swimEndM) / 1000 : d / 1000;
  return { line1: fmt(bikeKm), line2: bikeEndM > 1e-6 ? "Vélo" : "", leg: "bike" };
}

// ─── Géométrie GPS ────────────────────────────────────────────────────────────

/** Point GPS issu d'un tracé GPX (coordonnées + altitude en mètres). */
export type GpxTrackPoint = { lat: number; lng: number; eleM: number };

/** Distance orthodromique (m) entre deux points GPS. */
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR;
  const dLng = (b.lng - a.lng) * toR;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

/** Distances cumulées le long du tracé (m), même longueur que `points`. */
export function cumulativeDistancesM(points: GpxTrackPoint[]): number[] {
  const cumul: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cumul.push(cumul[i - 1] + haversineM(points[i - 1], points[i]));
  }
  return cumul;
}

/** Position interpolée sur le parcours à l'abscisse curviligne `distanceM` (m). */
export function positionAtDistanceM(
  distanceM: number,
  points: GpxTrackPoint[],
  distM: number[]
): { lat: number; lng: number } {
  if (points.length === 0) return { lat: 0, lng: 0 };
  if (points.length === 1 || distM.length < 2) return { lat: points[0].lat, lng: points[0].lng };
  const maxD = distM[distM.length - 1];
  if (distanceM <= 0) return { lat: points[0].lat, lng: points[0].lng };
  if (distanceM >= maxD) return { lat: points[points.length - 1].lat, lng: points[points.length - 1].lng };
  let i = 0;
  while (i < distM.length - 1 && distM[i + 1] < distanceM) i++;
  const d0 = distM[i];
  const d1 = distM[i + 1];
  const span = d1 - d0 || 1;
  const t = (distanceM - d0) / span;
  return {
    lat: points[i].lat + t * (points[i + 1].lat - points[i].lat),
    lng: points[i].lng + t * (points[i + 1].lng - points[i].lng),
  };
}

// ─── Profil altimétrique ──────────────────────────────────────────────────────

/**
 * Lissage glissant du profil brut (réduit le bruit baro / GPX et les faux D+/D−).
 * `halfWindow` : demi-fenêtre en nombre de points.
 */
export function smoothElevationProfileM(eleM: number[], halfWindow: number): number[] {
  const n = eleM.length;
  if (n === 0) return [];
  const w = Math.max(0, Math.min(halfWindow, Math.floor((n - 1) / 2)));
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const j0 = Math.max(0, i - w);
    const j1 = Math.min(n - 1, i + w);
    let s = 0;
    for (let j = j0; j <= j1; j++) s += eleM[j];
    out[i] = s / (j1 - j0 + 1);
  }
  return out;
}

/** Sous-échantillonne un profil (`distancesM`, `elevationsM`) à `max` points. */
export function downsampleProfile(
  distancesM: number[],
  elevationsM: number[],
  max: number
): { d: number[]; e: number[] } {
  if (distancesM.length <= max) return { d: distancesM, e: elevationsM };
  const idxs: number[] = [];
  const step = (distancesM.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) idxs.push(Math.min(distancesM.length - 1, Math.round(i * step)));
  return {
    d: idxs.map((i) => distancesM[i]),
    e: idxs.map((i) => elevationsM[i]),
  };
}

/**
 * Enchaîne les profils vélo et course en une abscisse continue.
 * Renvoie `splitIndex` = dernier index du segment vélo dans le tableau fusionné.
 */
export function mergeBikeRunProfile(
  distVelo: number[],
  eleVelo: number[],
  distRun: number[],
  eleRun: number[],
  maxTotal: number
): { d: number[]; e: number[]; splitIndex: number } {
  const nV = distVelo.length;
  const nR = distRun.length;
  const pV = downsampleProfile(distVelo, eleVelo, Math.max(2, Math.round((maxTotal * nV) / Math.max(nV + nR, 1))));
  const pR = downsampleProfile(distRun, eleRun, Math.max(2, maxTotal - pV.d.length + 1));
  const offset = distVelo[nV - 1];
  const dRunOff = pR.d.map((d) => d + offset);
  const dComb = [...pV.d, ...dRunOff.slice(1)];
  const eComb = [...pV.e, ...pR.e.slice(1)];
  return { d: dComb, e: eComb, splitIndex: Math.max(0, pV.d.length - 1) };
}

/** D+ cumulé (m) à l'abscisse curviligne `distanceM` (recherche dichotomique). */
export function cumDplusAtDistanceM(
  distanceM: number,
  distancesM: number[],
  cumDplusM: number[]
): number {
  const n = Math.min(distancesM.length, cumDplusM.length);
  if (n === 0) return 0;
  const d = Math.max(0, Math.min(distancesM[n - 1] ?? 0, distanceM));
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (distancesM[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  return cumDplusM[lo] ?? 0;
}

// ─── Physique vélo ────────────────────────────────────────────────────────────

/** Constantes du modèle de résistance vélo. */
const BIKE_ETA = 0.97;
const BIKE_G = 9.81;
const BIKE_CRR = 0.006;
const BIKE_RHO = 1.15;
const BIKE_CDA = 0.42;

/**
 * Vitesse régime permanent vélo (m/s) : solution de
 * `P·η = Mg(sinα + Crr·cosα)·V + ½·ρ·CdA·V³`.
 * Résolution par dichotomie (robuste sur descente où k peut être négatif).
 */
export function solveSteadyBikeSpeedMps(powerW: number, alphaRad: number, massKg: number): number {
  const Peff = powerW * BIKE_ETA;
  const c = 0.5 * BIKE_RHO * BIKE_CDA;
  const k = massKg * BIKE_G * (Math.sin(alphaRad) + BIKE_CRR * Math.cos(alphaRad));
  const f = (V: number) => c * V * V * V + k * V - Peff;

  let lo = 0.2;
  let hi = 30;
  if (f(lo) >= 0) return lo;
  while (hi < 200 && f(hi) < 0) hi += 10;
  if (f(hi) < 0) return hi;

  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  return Math.max(0.3, (lo + hi) / 2);
}
