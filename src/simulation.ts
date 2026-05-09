/** Page Simulation : parcours vélo depuis GPX, carte OpenStreetMap (Leaflet), profil altimétrique. */

import {
  getBikeFatiguePctPerHour,
  getFtp,
  getRaceStartHourMinute,
  getSwimPaceSecPer100m,
  getSwimPaceMMSSPer100m,
  getT1Sec,
  getT2Sec,
  getTotalMassKg,
  getVmaCapKmh,
} from "./athlete-settings";
import { ATHLETE_SETTINGS_CHANGED } from "./athlete-settings-rail";
import {
  type GpxTrackPoint,
  haversineM,
  cumulativeDistancesM,
  positionAtDistanceM,
  smoothElevationProfileM,
  mergeBikeRunProfile,
  cumDplusAtDistanceM,
  solveSteadyBikeSpeedMps,
  formatEtaSplitTime,
  formatPaceMinPerKm,
  formatClockFromRaceStart,
  niceAxisStepM,
  formatDistanceKmLabel,
  formatLegDistanceKmLabel,
  formatAltitudeHoverKm,
} from "./calc-utils";
import { GARMIN_SPLITS_STORAGE_KEY, GARMIN_SPLITS_UPDATED_EVENT } from "./garmin-local";
import { isStrictLocalhost } from "./local-only";
export type { GpxTrackPoint } from "./calc-utils";
export { cumulativeDistancesM } from "./calc-utils";

const GPX_VELO_URL = "/gpx/velo/parcours.gpx";
const GPX_RUN_URL = "/gpx/run/parcours.gpx";

/** Distance fixe de la natation en triathlon longue distance (Ascend XTRI). */
const SWIM_DIST_M = 3800;

/** Durée de la natation en secondes d'après l'allure saisie. */
function getSwimDurationS(): number {
  const paceSecPer100m = getSwimPaceSecPer100m();
  return paceSecPer100m * (SWIM_DIST_M / 100);
}

function getT1DurationS(): number {
  return getT1Sec();
}

function getT2DurationS(): number {
  return getT2Sec();
}

const MAP_COLOR_BIKE = "#1c70e2";
const MAP_COLOR_RUN = "#1d5c3f";
// Couleurs du profil altimétrique (demande UI) : nage bleu, vélo vert, CAP rouge doux.
const CHART_COLOR_SWIM = "#1c70e2";
const CHART_COLOR_BIKE = "#16a34a";
const CHART_COLOR_RUN = "#f87171";

/**
 * Repères de cols (distances fixées).
 * - `absKm` : km depuis le départ vélo (distance absolue sur le parcours combiné)
 * - `runKm` : km depuis le départ CAP (relatif CAP), converti via `bikeEndAbsM`
 */
const COURSE_COL_MARKERS: { name: string; absKm?: number; runKm?: number }[] = [
  { name: "Port de Balès", absKm: 100.558 },
  { name: "Col de Peyresourde", absKm: 125.679 },
  { name: "Col de Val Louron-Azet", absKm: 143.253 },
  { name: "Col d'Aspin", absKm: 178.943 },
  { name: "Col de la Courade", runKm: 18.036 },
  { name: "Col d'Arizes", runKm: 26.474 },
  { name: "Col de Sencours", runKm: 31.917 },
  { name: "Pic du Midi", runKm: 35.139 },
];

/** Dimensions du SVG profil (utilisées pour le mapping souris ↔ distance). */
const CHART_LAYOUT = {
  W: 640,
  // PAD.t large pour que les labels de cols en vertical (≈ 90px de haut) restent au-dessus du tracé.
  H: 270,
  PAD: { t: 100, r: 18, b: 46, l: 58 },
} as const;

/** Leaflet chargé depuis le CDN (évite d’avoir à installer le paquet npm `leaflet`). */
const LEAFLET_CDN_BASE = "https://unpkg.com/leaflet@1.9.4/dist";

let leafletLoadPromise: Promise<any> | null = null;

function ensureLeaflet(): Promise<any> {
  const w = window as unknown as { L?: any };
  if (w.L) return Promise.resolve(w.L);
  if (leafletLoadPromise) return leafletLoadPromise;

  leafletLoadPromise = new Promise((resolve, reject) => {
    const cssId = "leaflet-css-xtriascend";
    if (!document.getElementById(cssId)) {
      const link = document.createElement("link");
      link.id = cssId;
      link.rel = "stylesheet";
      link.href = `${LEAFLET_CDN_BASE}/leaflet.css`;
      document.head.appendChild(link);
    }

    const s = document.createElement("script");
    s.async = true;
    s.src = `${LEAFLET_CDN_BASE}/leaflet.js`;
    s.onload = () => {
      const L = (window as unknown as { L?: any }).L;
      if (L) resolve(L);
      else {
        leafletLoadPromise = null;
        reject(new Error("Leaflet indisponible"));
      }
    };
    s.onerror = () => {
      leafletLoadPromise = null;
      reject(new Error("Leaflet"));
    };
    document.head.appendChild(s);
  });
  return leafletLoadPromise;
}


function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildCourseColMarkersLayer(args: {
  toX: (dRelM: number) => number;
  yTop: number;
  yBot: number;
  distMaxRelM: number;
  offsetAbsM: number;
  swimEndAbsM: number;
  bikeEndAbsM: number;
  showLabels: boolean;
}): string {
  const { toX, yTop, yBot, distMaxRelM, offsetAbsM, swimEndAbsM, bikeEndAbsM, showLabels } = args;
  // Zoom : labels horizontaux centrés dans la marge supérieure (yTop - 14 ≈ 86 avec PAD.t=100).
  const yTextZoom = yTop - 14;
  // Normal : labels verticaux ancrés en bas à (yTop - 4). text-anchor="end" + rotate(-90)
  // → le texte s'étend vers le haut, entièrement dans la marge supérieure, hors du graphique.
  const yTextNormal = yTop - 4;
  const labelBgPadX = 3;
  const labelBgPadY = 2;
  const labelFs = 6.2;
  const items = COURSE_COL_MARKERS.map((m) => {
    const absM =
      typeof m.absKm === "number"
        ? m.absKm * 1000 + swimEndAbsM  // cols vélo : coordonnées GPX + décalage natation
        : typeof m.runKm === "number" && bikeEndAbsM > 1e-6
          ? bikeEndAbsM + m.runKm * 1000  // cols course : bikeEndAbsM inclut déjà la natation
          : null;
    if (absM === null) return null;
    const relM = absM - offsetAbsM;
    if (relM < -1e-6 || relM > distMaxRelM + 1e-6) return null;
    const x = toX(relM);
    const name = escapeHtml(m.name);
    const xS = x.toFixed(1);
    const yTopS = yTop.toFixed(1);
    const yBotS = yBot.toFixed(1);
    const base = `<g class="sim-col-marker" pointer-events="none">
<line x1="${xS}" y1="${yTopS}" x2="${xS}" y2="${yBotS}" stroke="rgba(0,0,0,0.22)" stroke-width="1" stroke-dasharray="3 5"/>
${(() => {
      // Fond du label : largeur approx pour éviter les mesures JS.
      const approxW = Math.max(58, Math.min(180, name.length * 6 + 2 * labelBgPadX));
      const bgW = approxW.toFixed(0);
      const bgH = (labelFs + 2 * labelBgPadY + 2).toFixed(0);
      if (showLabels) {
        // Zoom : horizontal, centré.
        const yTextS = yTextZoom.toFixed(1);
        const bgX = (-approxW / 2).toFixed(0);
        const bgY = (-(labelFs + labelBgPadY + 2)).toFixed(0);
        return `<g transform="translate(${xS} ${yTextS})">
  <rect x="${bgX}" y="${bgY}" width="${bgW}" height="${bgH}" rx="6" fill="rgba(255,255,255,0.86)"/>
  <text x="0" y="0" text-anchor="middle" dominant-baseline="alphabetic"
    font-size="${labelFs}" font-weight="650"
    fill="rgba(15,18,24,0.88)"
    stroke="rgba(255,255,255,0.92)" stroke-width="3" paint-order="stroke"
  >${name}</text>
</g>`;
      }

      // Normal : vertical — translate(xS, yTextNormal) rotate(-90).
      // Dans ce repère SVG : local +x → vers le HAUT de l'écran.
      // text-anchor="start" (x: 0 → +approxW) → le texte monte de yTextNormal vers y≈0.
      const yTextS = yTextNormal.toFixed(1);
      const bgX = "0"; // rect commence à x=0 (bas du label en screen), monte vers le haut
      const bgY = (-(labelFs + labelBgPadY)).toFixed(0);
      return `<g transform="translate(${xS} ${yTextS}) rotate(-90)">
  <rect x="${bgX}" y="${bgY}" width="${bgW}" height="${bgH}" rx="6" fill="rgba(255,255,255,0.82)"/>
  <text x="0" y="0" text-anchor="start" dominant-baseline="alphabetic"
    font-size="${labelFs}" font-weight="650"
    fill="rgba(15,18,24,0.82)"
    stroke="rgba(255,255,255,0.92)" stroke-width="3" paint-order="stroke"
  >${name}</text>
</g>`;
    })()}
</g>`;
    return base;
  }).filter(Boolean);
  return items.join("\n");
}

/**
 * Moyenne glissante sur le profil brut (m) : réduit le bruit altimétrique GPX / baro.
 * Sans lissage, la somme des petites montées/descentes artificielles entre points gonfle
 * fortement D+ et D− par rapport aux totaux type Garmin (ascension / descente « lissée »).
 */
const GPX_ELEV_SMOOTH_HALF_WINDOW = 4;

/** Modèle statique vélo : P·η = Mg(sinα+Crr·cosα)·V + ½·ρ·CdA·V³ — constantes demandées. */

/**
 * Vitesse max en descente (km/h), convertie en m/s pour le plafonnement segment par segment.
 * Routes de montagne ouvertes : évite des vitesses « physiquement possibles en roue libre » peu réalistes / dangereuses dans le tableau.
 */
const BIKE_DESCENT_MAX_SPEED_KMH = 50;
const BIKE_DESCENT_MAX_SPEED_MPS = BIKE_DESCENT_MAX_SPEED_KMH / 3.6;

// Vitesse (m/s) steady-state vélo (solveSteadyBikeSpeedMps) et formatEtaSplitTime → voir calc-utils.ts.

/**
 * Vitesse (m/s) solution de P·η = Mg(sinα+Crr cosα)·V + ½ ρ CdA V³.
 * Dichotomie sur [Vlo, Vhi] (robuste si la pente rend k négatif).
 */

  /** Arrondir d’abord le total en secondes (évite « 3 min 60 s » quand s % 60 arrondit à 60). */
type KmBucket = { timeS: number; horizM: number };

/** Fatigue : multiplicateur de temps linéaire avec le temps déjà couru (ex. +5 % par heure écoulée au début du km). */
const RUN_FATIGUE_PER_HOUR = 0.05;

/** Malus post-vélo sur toute la CAP simulée : +8 % de temps sur chaque km (effort résiduel après le parcours vélo). */
const RUN_POST_BIKE_TIME_MULT = 1.08;

/**
 * Descente très raide : pénalité freinage si la pente moyenne du km dépasse ce seuil
 * et que la distance horizontale sur le km est assez longue (évite les pics GPS).
 */
const RUN_STEEP_DESCENT_GRADE = -0.28;
const RUN_STEEP_DESCENT_MIN_HORIZ_M = 18;
const RUN_STEEP_DESCENT_TIME_MULT = 1.35;

/** Seuil |Δalt net| (m) en dessous duquel le km est traité comme « plat » (comme la jauge Dénivelé). */
const RUN_NET_ELEV_FLAT_M = 0.5;

/** VAM cible sur un km « rouge » (Δalt net &gt; 0) : 1000 m D+ / h pour borner le temps de montée. */
const RUN_VAM_M_PER_H = 1000;

/** Allure plancher (min/km sol) : on ne modélise pas plus vite (ex. 5 → au mieux 5:00 / km sur l’horizontale). */
const RUN_PACE_MIN_MIN_PER_KM = 5;

// Cutoff « BLACK SHIRT » : checkpoint à 31,188 km CAP, à atteindre avant 18:15.
const RUN_BLACK_SHIRT_CHECKPOINT_M = 31_188;
const RUN_BLACK_SHIRT_CUTOFF_CLOCK_H = 18;
const RUN_BLACK_SHIRT_CUTOFF_CLOCK_M = 15;

type BlackShirtResult = {
  absOffsetSecAtCheckpoint: number;
  clockAtCheckpoint: string;
  cutoffClock: string;
  shirt: "black" | "white";
  passed: boolean;
};

function computeBlackShirtResult(runRows: RunKmEtaRow[], raceStartH: number, raceStartM: number): BlackShirtResult | null {
  // On cherche le temps absolu (offset depuis l'heure de départ) au 31,188 km du tracé CAP.
  let cumRunDistM = 0;
  let prevCumTimeAbsS = 0;
  for (const r of runRows) {
    if (r.isTotal) continue;
    const nextDist = cumRunDistM + r.horizM;
    if (nextDist + 1e-9 >= RUN_BLACK_SHIRT_CHECKPOINT_M) {
      const remain = RUN_BLACK_SHIRT_CHECKPOINT_M - cumRunDistM;
      const frac = r.horizM > 1e-9 ? Math.max(0, Math.min(1, remain / r.horizM)) : 0;
      const tAbsAt = prevCumTimeAbsS + r.timeS * frac;
      const startSec = raceStartH * 3600 + raceStartM * 60;
      const cutoffAbsSec = (() => {
        const c = RUN_BLACK_SHIRT_CUTOFF_CLOCK_H * 3600 + RUN_BLACK_SHIRT_CUTOFF_CLOCK_M * 60;
        // cutoff le même jour que le départ si possible, sinon jour+1
        return c >= startSec ? c - startSec : c + 86400 - startSec;
      })();
      const passed = tAbsAt <= cutoffAbsSec + 1e-9;
      const shirt: "black" | "white" = passed ? "black" : "white";
      return {
        absOffsetSecAtCheckpoint: tAbsAt,
        clockAtCheckpoint: formatClockFromRaceStart(tAbsAt, raceStartH, raceStartM),
        cutoffClock: `${String(RUN_BLACK_SHIRT_CUTOFF_CLOCK_H).padStart(2, "0")}:${String(RUN_BLACK_SHIRT_CUTOFF_CLOCK_M).padStart(2, "0")}:00`,
        shirt,
        passed,
      };
    }
    cumRunDistM = nextDist;
    prevCumTimeAbsS = r.cumTimeEndAbsS;
  }
  return null;
}

type RunKmBucket = { horizM: number; dPlusM: number; dMinusM: number };

type EleKmBuckets = { dPlusM: number; dMinusM: number }[];

function addHorizDplusDminusToBuckets(
  buckets: EleKmBuckets,
  d0Run: number,
  d1Run: number,
  horizSegM: number,
  dPlusSegM: number,
  dMinusSegM: number
): void {
  if (horizSegM <= 1e-9) return;
  let a = d0Run;
  const end = d1Run;
  while (a < end - 1e-12) {
    const kmIdx = Math.floor(a / 1000);
    if (kmIdx < 0 || kmIdx >= buckets.length) break;
    const nextBoundary = (kmIdx + 1) * 1000;
    const segEnd = Math.min(end, nextBoundary);
    const overlap = segEnd - a;
    const frac = overlap / horizSegM;
    buckets[kmIdx].dPlusM += dPlusSegM * frac;
    buckets[kmIdx].dMinusM += dMinusSegM * frac;
    a = segEnd;
  }
}

function addHorizDplusToRunBuckets(
  buckets: RunKmBucket[],
  d0Run: number,
  d1Run: number,
  horizSegM: number,
  dPlusSegM: number,
  dMinusSegM: number
): void {
  if (horizSegM <= 1e-9) return;
  let a = d0Run;
  const end = d1Run;
  while (a < end - 1e-12) {
    const kmIdx = Math.floor(a / 1000);
    if (kmIdx < 0 || kmIdx >= buckets.length) break;
    const nextBoundary = (kmIdx + 1) * 1000;
    const segEnd = Math.min(end, nextBoundary);
    const overlap = segEnd - a;
    const frac = overlap / horizSegM;
    buckets[kmIdx].horizM += overlap;
    buckets[kmIdx].dPlusM += dPlusSegM * frac;
    buckets[kmIdx].dMinusM += dMinusSegM * frac;
    a = segEnd;
  }
}

function addSegmentTimeToKmBuckets(
  buckets: KmBucket[],
  d0Horiz: number,
  d1Horiz: number,
  horizSegM: number,
  timeSegS: number
): void {
  if (horizSegM <= 1e-9 || timeSegS <= 0) return;
  let a = d0Horiz;
  const end = d1Horiz;
  while (a < end - 1e-12) {
    const kmIdx = Math.floor(a / 1000);
    if (kmIdx < 0 || kmIdx >= buckets.length) break;
    const nextBoundary = (kmIdx + 1) * 1000;
    const segEnd = Math.min(end, nextBoundary);
    const overlap = segEnd - a;
    const frac = overlap / horizSegM;
    buckets[kmIdx].timeS += timeSegS * frac;
    buckets[kmIdx].horizM += overlap;
    a = segEnd;
  }
}

export type BikeKmEtaRow = {
  kmLabel: string;
  distanceM: number;
  /** D+ sur ce kilomètre (m). */
  dPlusM: number;
  /** D− sur ce kilomètre (m). */
  dMinusM: number;
  timeS: number;
  /** Temps cumulé depuis le départ vélo jusqu’à la fin de ce km (s). */
  cumTimeEndS: number;
  avgKmh: number;
  isTotal: boolean;
};

/** Temps au km vélo : modèle puissance constante ; vitesses sur segments en perte d’altitude plafonnées (`BIKE_DESCENT_MAX_SPEED_KMH`). */
export function computeBikeKmEtaRows(
  pointsVelo: GpxTrackPoint[],
  distVelo: number[],
  powerW: number,
  massKg: number,
  fatiguePctPerHour = 0
): BikeKmEtaRow[] {
  const bikeEndM = distVelo[distVelo.length - 1] ?? 0;
  if (pointsVelo.length < 2 || bikeEndM <= 0) return [];

  const nBuckets = Math.max(1, Math.ceil(bikeEndM / 1000 - 1e-12));
  const buckets: KmBucket[] = Array.from({ length: nBuckets }, () => ({ timeS: 0, horizM: 0 }));
  const eleBuckets: EleKmBuckets = Array.from({ length: nBuckets }, () => ({ dPlusM: 0, dMinusM: 0 }));
  const eleSmooth = smoothElevationProfileM(
    pointsVelo.map((p) => p.eleM),
    GPX_ELEV_SMOOTH_HALF_WINDOW
  );

  const fatiguePerSec = fatiguePctPerHour / 100 / 3600;
  let cumBikeTimeS = 0;

  for (let i = 0; i < pointsVelo.length - 1; i++) {
    const p0 = pointsVelo[i];
    const p1 = pointsVelo[i + 1];
    const horiz = haversineM(p0, p1);
    if (horiz < 1e-6) continue;
    const dele = eleSmooth[i + 1] - eleSmooth[i];
    const dPlusSeg = Math.max(0, dele);
    const dMinusSeg = Math.max(0, -dele);
    const d0 = distVelo[i];
    const d1 = distVelo[i + 1];
    addHorizDplusDminusToBuckets(eleBuckets, d0, d1, horiz, dPlusSeg, dMinusSeg);
    const alpha = Math.atan2(dele, horiz);
    const slant = Math.sqrt(horiz * horiz + dele * dele);
    // Puissance effective : réduite par la fatigue cumulée (plancher à 50 % du FTP)
    const fatigueFactor = Math.max(0.5, 1 - fatiguePerSec * cumBikeTimeS);
    let V = solveSteadyBikeSpeedMps(powerW * fatigueFactor, alpha, massKg);
    if (dele < -1e-9) {
      V = Math.min(V, BIKE_DESCENT_MAX_SPEED_MPS);
    }
    const tSeg = slant / V;
    cumBikeTimeS += tSeg;
    addSegmentTimeToKmBuckets(buckets, d0, d1, horiz, tSeg);
  }

  const rows: BikeKmEtaRow[] = [];
  let sumT = 0;
  let sumDp = 0;
  let sumDm = 0;
  for (let i = 0; i < nBuckets; i++) {
    const h = buckets[i].horizM;
    const t = buckets[i].timeS;
    sumT += t;
    const dist = Math.min(1000, Math.max(0, bikeEndM - i * 1000));
    const avgKmh = h > 1e-6 && t > 1e-9 ? (h / t) * 3.6 : 0;
    const dp = eleBuckets[i].dPlusM;
    const dm = eleBuckets[i].dMinusM;
    sumDp += dp;
    sumDm += dm;
    rows.push({
      kmLabel: String(i + 1),
      distanceM: h > 1 ? h : dist,
      dPlusM: dp,
      dMinusM: dm,
      timeS: t,
      cumTimeEndS: sumT,
      avgKmh,
      isTotal: false,
    });
  }

  const totalKmh = bikeEndM > 1e-6 && sumT > 1e-9 ? (bikeEndM / sumT) * 3.6 : 0;
  rows.push({
    kmLabel: "Total",
    distanceM: bikeEndM,
    dPlusM: sumDp,
    dMinusM: sumDm,
    timeS: sumT,
    cumTimeEndS: sumT,
    avgKmh: totalKmh,
    isTotal: true,
  });

  return rows;
}

export type RunKmEtaRow = {
  kmLabel: string;
  /** Distance horizontale GPX sur ce kilomètre (m). */
  horizM: number;
  /** D+ positif sur ce kilomètre (m). */
  dPlusM: number;
  /** D− (descente) sur ce kilomètre (m). */
  dMinusM: number;
  timeS: number;
  /** Temps cumulé depuis le début du tracé course (s). */
  cumTimeEndRunS: number;
  /** Temps cumulé depuis le départ course (vélo + course jusqu’à fin de ce km) (s). */
  cumTimeEndAbsS: number;
  /** Allure sur le km horizontal (min/km sol). */
  paceMinPerKmHoriz: number;
  isTotal: boolean;
};

/**
 * Simulation course au km : km « rouge » (Δalt net D+−D− &gt; 0) → temps borné par **1000 m D+ / h**
 * et par l’allure **VMA** au sol ; km « vert » (net &lt; 0) → **VMA** sur la distance horizontale,
 * avec **pénalité descente très raide** (pente moyenne &lt; ≈ −28 % et horiz ≥ ~18 m).
 * **Fatigue** : +5 % de temps par heure de course déjà écoulée au **début** du km.
 * **Post-vélo** : multiplicateur de temps sur chaque km (voir `RUN_POST_BIKE_TIME_MULT`).
 * **Allure plancher** : temps ≥ `RUN_PACE_MIN_MIN_PER_KM` min/km × distance horizontale (km).
 */
export function computeRunKmEtaRows(
  pointsRun: GpxTrackPoint[],
  distRun: number[],
  vmaKmh: number,
  bikeTotalTimeS: number
): RunKmEtaRow[] {
  const runEndM = distRun[distRun.length - 1] ?? 0;
  if (pointsRun.length < 2 || runEndM <= 0) return [];

  const nBuckets = Math.max(1, Math.ceil(runEndM / 1000 - 1e-12));
  const bucketsDp: RunKmBucket[] = Array.from({ length: nBuckets }, () => ({
    horizM: 0,
    dPlusM: 0,
    dMinusM: 0,
  }));

  const vma = Math.max(vmaKmh, 1e-6);
  const vPlatMps = vma / 3.6;
  const eleSmooth = smoothElevationProfileM(
    pointsRun.map((p) => p.eleM),
    GPX_ELEV_SMOOTH_HALF_WINDOW
  );

  for (let i = 0; i < pointsRun.length - 1; i++) {
    const p0 = pointsRun[i];
    const p1 = pointsRun[i + 1];
    const horiz = haversineM(p0, p1);
    if (horiz < 1e-6) continue;
    const dele = eleSmooth[i + 1] - eleSmooth[i];
    const dPlus = Math.max(0, dele);
    const dMinus = Math.max(0, -dele);
    const d0 = distRun[i];
    const d1 = distRun[i + 1];
    addHorizDplusToRunBuckets(bucketsDp, d0, d1, horiz, dPlus, dMinus);
  }

  const rows: RunKmEtaRow[] = [];
  let sumT = 0;
  let sumHoriz = 0;
  let sumDp = 0;
  let sumDm = 0;

  for (let i = 0; i < nBuckets; i++) {
    const h = bucketsDp[i].horizM;
    const dp = bucketsDp[i].dPlusM;
    const dm = bucketsDp[i].dMinusM;
    const dist = Math.min(1000, Math.max(0, runEndM - i * 1000));
    const horizDisp = h > 1e-6 ? h : dist;
    const net = dp - dm;
    const fatigueMult = 1 + RUN_FATIGUE_PER_HOUR * (sumT / 3600);

    let tBase: number;
    if (net > RUN_NET_ELEV_FLAT_M) {
      const tVam = dp > 1e-6 ? (3600 * dp) / RUN_VAM_M_PER_H : 0;
      const tVma = horizDisp / vPlatMps;
      tBase = Math.max(tVam, tVma);
    } else if (net < -RUN_NET_ELEV_FLAT_M) {
      tBase = horizDisp / vPlatMps;
      const kmGrade = horizDisp > 1e-6 ? net / horizDisp : 0;
      if (kmGrade < RUN_STEEP_DESCENT_GRADE && horizDisp >= RUN_STEEP_DESCENT_MIN_HORIZ_M) {
        tBase *= RUN_STEEP_DESCENT_TIME_MULT;
      }
    } else {
      tBase = horizDisp / vPlatMps;
    }

    const tRaw = tBase * fatigueMult * RUN_POST_BIKE_TIME_MULT;
    const horizKmDisp = horizDisp / 1000;
    const tMinPaceSec = RUN_PACE_MIN_MIN_PER_KM * 60 * horizKmDisp;
    const t = Math.max(tRaw, tMinPaceSec);
    const paceMin = horizKmDisp > 1e-9 ? t / 60 / horizKmDisp : 0;
    sumT += t;
    sumHoriz += horizDisp;
    sumDp += dp;
    sumDm += dm;
    rows.push({
      kmLabel: String(i + 1),
      horizM: horizDisp,
      dPlusM: dp,
      dMinusM: dm,
      timeS: t,
      cumTimeEndRunS: sumT,
      cumTimeEndAbsS: bikeTotalTimeS + sumT,
      paceMinPerKmHoriz: paceMin,
      isTotal: false,
    });
  }

  const totalPace = sumHoriz > 1e-6 ? sumT / 60 / (sumHoriz / 1000) : 0;
  rows.push({
    kmLabel: "Total",
    horizM: sumHoriz,
    dPlusM: sumDp,
    dMinusM: sumDm,
    timeS: sumT,
    cumTimeEndRunS: sumT,
    cumTimeEndAbsS: bikeTotalTimeS + sumT,
    paceMinPerKmHoriz: totalPace,
    isTotal: true,
  });

  return rows;
}


/** ~14 m de D+ ou D− par « palier » de barre (jusqu’à 8 barres). */
const ELEV_METER_M_PER_BAR = 14;
const ELEV_METER_MAX_BARS = 8;

/** Jauge selon Δalt net (D+ − D−) par km : rouge si gain, vert si perte ; une seule famille de barres. */
function buildElevationMeterHtml(dPlusM: number, dMinusM: number, isTotal: boolean): string {
  if (isTotal) {
    const dp = Math.round(dPlusM);
    const dm = Math.round(dMinusM);
    const label = `Total parcours : D+ ${dp} m, D− ${dm} m`;
    const dpStr = dp.toLocaleString("fr-FR");
    return `<span class="sim-elev-meter sim-elev-meter--total" title="${escapeHtml(label)}">D+ ${escapeHtml(dpStr)} m</span>`;
  }
  const net = dPlusM - dMinusM;
  const label =
    `Δalt ${net >= 0 ? "+" : ""}${Math.round(net)} m (D+ ${Math.round(dPlusM)} m, D− ${Math.round(dMinusM)} m)`;
  const flat = Math.abs(net) < 0.5;
  if (flat) {
    return `<span class="sim-elev-meter sim-elev-meter--flat" title="${escapeHtml(label)}">—</span>`;
  }
  const mag = Math.abs(net);
  const nBars = Math.min(ELEV_METER_MAX_BARS, Math.max(1, Math.ceil(mag / ELEV_METER_M_PER_BAR)));
  const minPx = 4;
  const maxPx = 20;
  const isGain = net > 0;
  const intensity = 0.42 + 0.58 * (nBars / ELEV_METER_MAX_BARS);
  if (isGain) {
    const redBars: string[] = [];
    for (let i = 0; i < nBars; i++) {
      const frac = (i + 1) / nBars;
      const h = minPx + frac * (maxPx - minPx);
      redBars.push(
        `<span class="sim-elev-bar sim-elev-bar--red" style="height:${h.toFixed(1)}px;opacity:${intensity.toFixed(
          2
        )}"></span>`
      );
    }
    return `<div class="sim-elev-meter sim-elev-meter--asc-only" title="${escapeHtml(
      label
    )}" role="img" aria-label="${escapeHtml(label)}"><div class="sim-elev-meter__group sim-elev-meter__group--asc" aria-hidden="true">${redBars.join(
      ""
    )}</div></div>`;
  }
  const greenBars: string[] = [];
  for (let i = 0; i < nBars; i++) {
    const frac = (nBars - i) / nBars;
    const h = minPx + frac * (maxPx - minPx);
    greenBars.push(
      `<span class="sim-elev-bar sim-elev-bar--green" style="height:${h.toFixed(1)}px;opacity:${intensity.toFixed(
        2
      )}"></span>`
    );
  }
  return `<div class="sim-elev-meter sim-elev-meter--desc-only" title="${escapeHtml(
    label
  )}" role="img" aria-label="${escapeHtml(label)}"><div class="sim-elev-meter__group sim-elev-meter__group--desc" aria-hidden="true">${greenBars.join(
    ""
  )}</div></div>`;
}

function buildSwimSummaryHtml(): string {
  const swimS = getSwimDurationS();
  const { h: sh, m: sm } = getRaceStartHourMinute();
  const paceStr = `${getSwimPaceMMSSPer100m()} / 100m`;
  const durationStr = formatEtaSplitTime(swimS);
  const endClock = formatClockFromRaceStart(swimS, sh, sm);
  const startClock = formatClockFromRaceStart(0, sh, sm);
  return `<table class="sim-velo__km-eta-table sim-velo__km-eta-table--swim">
<thead><tr>
<th scope="col">Segment</th>
<th scope="col">Distance</th>
<th scope="col">Durée</th>
<th scope="col">Allure</th>
<th scope="col">Heure départ → arrivée</th>
</tr></thead>
<tbody><tr class="sim-velo__km-eta-tr--swim">
<td><span class="sim-leg-badge sim-leg-badge--swim">Nage</span></td>
<td class="sim-velo__km-eta-cell--num">3,8 km</td>
<td class="sim-velo__km-eta-cell--num">${escapeHtml(durationStr)}</td>
<td class="sim-velo__km-eta-cell--num">${escapeHtml(paceStr)}</td>
<td class="sim-velo__km-eta-cell--num">${escapeHtml(startClock)} → ${escapeHtml(endClock)}</td>
</tr></tbody>
</table>`;
}

function buildT1SummaryHtml(): string {
  const t1S = getT1DurationS();
  const { h: sh, m: sm } = getRaceStartHourMinute();
  const start = getSwimDurationS();
  const end = start + t1S;
  return `<table class="sim-velo__km-eta-table sim-velo__km-eta-table--t1">
<thead><tr>
<th scope="col">Transition</th>
<th scope="col">Durée</th>
<th scope="col">Heure départ → arrivée</th>
</tr></thead>
<tbody><tr class="sim-velo__km-eta-tr--transition">
<td><span class="sim-leg-badge sim-leg-badge--t1">T1</span></td>
<td class="sim-velo__km-eta-cell--num">${escapeHtml(formatEtaSplitTime(t1S))}</td>
<td class="sim-velo__km-eta-cell--num">${escapeHtml(formatClockFromRaceStart(start, sh, sm))} → ${escapeHtml(
    formatClockFromRaceStart(end, sh, sm)
  )}</td>
</tr></tbody>
</table>`;
}

function buildT2SummaryHtml(bikeTotalS: number): string {
  const t2S = getT2DurationS();
  const { h: sh, m: sm } = getRaceStartHourMinute();
  const start = getSwimDurationS() + getT1DurationS() + Math.max(0, bikeTotalS);
  const end = start + t2S;
  return `<table class="sim-velo__km-eta-table sim-velo__km-eta-table--t2">
<thead><tr>
<th scope="col">Transition</th>
<th scope="col">Durée</th>
<th scope="col">Heure départ → arrivée</th>
</tr></thead>
<tbody><tr class="sim-velo__km-eta-tr--transition">
<td><span class="sim-leg-badge sim-leg-badge--t2">T2</span></td>
<td class="sim-velo__km-eta-cell--num">${escapeHtml(formatEtaSplitTime(t2S))}</td>
<td class="sim-velo__km-eta-cell--num">${escapeHtml(formatClockFromRaceStart(start, sh, sm))} → ${escapeHtml(
    formatClockFromRaceStart(end, sh, sm)
  )}</td>
</tr></tbody>
</table>`;
}

/**
 * Construit une fonction d'interpolation linéaire du temps Garmin en fonction du km cumulé.
 * Retourne null si les colonnes distance/temps ne sont pas détectables.
 */
function buildGarminInterpolation(data: GarminSplitsData): ((km: number) => number) | null {
  const colCount = Math.max(data.headers.length, ...data.rows.map((r) => r.length));
  const timeColIdx = detectTimeColumnIndex(data.rows, colCount);
  const distColIdx = detectDistanceColumnIndex(data.headers, data.rows, colCount, timeColIdx);
  if (timeColIdx < 0 || distColIdx < 0) return null;

  const cumKm: number[] = [0];
  const cumSec: number[] = [0];
  for (const row of data.rows) {
    const km = parseDecimal((row[distColIdx] ?? "").trim());
    const secs = parseTimeToSeconds((row[timeColIdx] ?? "").trim());
    if (isNaN(km) || secs === null) continue;
    cumKm.push(cumKm[cumKm.length - 1] + km);
    cumSec.push(cumSec[cumSec.length - 1] + secs);
  }
  if (cumKm.length < 2) return null;

  return (targetKm: number): number => {
    if (targetKm <= 0) return 0;
    const n = cumKm.length;
    if (targetKm >= cumKm[n - 1]) {
      // Extrapolation linéaire au-delà du dernier split
      const dk = cumKm[n - 1] - cumKm[n - 2];
      const ds = cumSec[n - 1] - cumSec[n - 2];
      return cumSec[n - 1] + (dk > 1e-9 ? (targetKm - cumKm[n - 1]) * (ds / dk) : 0);
    }
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cumKm[mid] <= targetKm) lo = mid; else hi = mid; }
    const frac = (cumKm[lo + 1] - cumKm[lo]) > 1e-9 ? (targetKm - cumKm[lo]) / (cumKm[lo + 1] - cumKm[lo]) : 0;
    return cumSec[lo] + frac * (cumSec[lo + 1] - cumSec[lo]);
  };
}

function loadGarminSplitsFromStorage(): GarminSplitsData | null {
  try {
    const raw = localStorage.getItem(GARMIN_SPLITS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as GarminSplitsData) : null;
  } catch { return null; }
}

/** Formate une différence de secondes en ±M:SS ou ±H:MM:SS. */
function formatDiffSeconds(diffS: number): string {
  const abs = Math.round(Math.abs(diffS));
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const sign = diffS >= 0 ? "+" : "−";
  return h > 0 ? `${sign}${h}:${pad(m)}:${pad(s)}` : `${sign}${m}:${pad(s)}`;
}

function buildBikeKmEtaTableHtml(
  rows: BikeKmEtaRow[],
  swimOffsetS = 0,
  garminInterp: ((km: number) => number) | null = null
): string {
  if (rows.length === 0) {
    return `<p class="sim-velo__km-eta-empty">Pas assez de données vélo pour estimer les temps au km.</p>`;
  }
  const { h: sh, m: sm } = getRaceStartHourMinute();
  const bikeEndKm = (rows.find((r) => r.isTotal)?.distanceM ?? 0) / 1000;
  const diffHead = garminInterp ? `\n<th scope="col">Δ Garmin</th>` : "";
  const head = `<thead><tr>
<th scope="col">Km</th>
<th scope="col">Dénivelé</th>
<th scope="col">Temps estimé</th>
<th scope="col">Vmoy</th>
<th scope="col">Heure (fin km)</th>${diffHead}
</tr></thead>`;
  const body = rows
    .map((r) => {
      const vStr = r.avgKmh > 0 ? `${r.avgKmh.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km/h` : "—";
      const timeCol = formatClockFromRaceStart(r.cumTimeEndS + swimOffsetS, sh, sm);
      const elevHtml = buildElevationMeterHtml(r.dPlusM, r.dMinusM, r.isTotal);
      const trCls = r.isTotal ? ' class="sim-velo__km-eta-tr--total"' : "";
      let diffCell = "";
      if (garminInterp) {
        const targetKm = r.isTotal ? bikeEndKm : Math.min(parseInt(r.kmLabel, 10), bikeEndKm);
        const garminSec = garminInterp(targetKm);
        const diffS = r.cumTimeEndS - garminSec;
        const sign = diffS >= 0 ? "pos" : "neg";
        diffCell = `\n<td class="sim-velo__km-eta-cell--num sim-bike-diff sim-bike-diff--${sign}">${escapeHtml(formatDiffSeconds(diffS))}</td>`;
      }
      return `<tr${trCls}>
<td>${escapeHtml(r.kmLabel)}</td>
<td class="sim-velo__km-eta-cell--elev">${elevHtml}</td>
<td class="sim-velo__km-eta-cell--num">${escapeHtml(formatEtaSplitTime(r.timeS))}</td>
<td class="sim-velo__km-eta-cell--num">${escapeHtml(vStr)}</td>
<td class="sim-velo__km-eta-cell--num">${escapeHtml(timeCol)}</td>${diffCell}
</tr>`;
    })
    .join("");
  return `<table class="sim-velo__km-eta-table sim-velo__km-eta-table--bike">${head}<tbody>${body}</tbody></table>`;
}

function buildRunKmEtaTableHtml(rows: RunKmEtaRow[], blackShirt: BlackShirtResult | null): string {
  if (rows.length === 0) {
    return `<p class="sim-velo__km-eta-empty">Pas assez de données course pour estimer les temps au km.</p>`;
  }
  const { h: sh, m: sm } = getRaceStartHourMinute();
  const head = `<thead><tr>
<th scope="col">Km</th>
<th scope="col">Dénivelé</th>
<th scope="col">Temps</th>
<th scope="col">Allure</th>
<th scope="col">Heure (fin km)</th>
</tr></thead>`;
  const bodyParts: string[] = [];
  /** Distance horizontale cumulée au début du segment du km courant (avant d’ajouter `r.horizM`). */
  let cumRunDistM = 0;
  const cp = RUN_BLACK_SHIRT_CHECKPOINT_M;
  for (const r of rows) {
    // Ligne cutoff à la distance 31,188 km : l’insérer dès qu’on franchit ce point (ordre kilométrique),
    // donc après le dernier km entièrement avant 31,188 et avant le km dont le segment contient le cutoff.
    if (
      !r.isTotal &&
      blackShirt &&
      cumRunDistM + 1e-9 < cp &&
      cumRunDistM + r.horizM + 1e-9 >= cp
    ) {
      const badge =
        blackShirt.passed
          ? `<span class="sim-shirt-badge sim-shirt-badge--black">BLACK SHIRT</span>`
          : `<span class="sim-shirt-badge sim-shirt-badge--white">WHITE SHIRT</span>`;
      bodyParts.push(`<tr class="sim-velo__km-eta-tr--checkpoint">
<td>31,188</td>
<td class="sim-velo__km-eta-cell--elev">${badge}</td>
<td class="sim-velo__km-eta-cell--num">Cutoff</td>
<td class="sim-velo__km-eta-cell--num">—</td>
<td class="sim-velo__km-eta-cell--num">${escapeHtml(blackShirt.clockAtCheckpoint)} (≤ ${escapeHtml(
        blackShirt.cutoffClock
      )})</td>
</tr>`);
      blackShirt = null;
    }

    const elevHtml = buildElevationMeterHtml(r.dPlusM, r.dMinusM, r.isTotal);
    const paceStr = formatPaceMinPerKm(r.paceMinPerKmHoriz);
    const timeCol = formatClockFromRaceStart(r.cumTimeEndAbsS, sh, sm);
    const trCls = r.isTotal ? ' class="sim-velo__km-eta-tr--total"' : "";
    bodyParts.push(`<tr${trCls}>
<td>${escapeHtml(r.kmLabel)}</td>
<td class="sim-velo__km-eta-cell--elev">${elevHtml}</td>
<td class="sim-velo__km-eta-cell--num">${escapeHtml(formatEtaSplitTime(r.timeS))}</td>
<td class="sim-velo__km-eta-cell--num">${escapeHtml(paceStr)}</td>
<td class="sim-velo__km-eta-cell--num">${escapeHtml(timeCol)}</td>
</tr>`);

    if (!r.isTotal) cumRunDistM += r.horizM;
  }
  return `<table class="sim-velo__km-eta-table sim-velo__km-eta-table--run">${head}<tbody>${bodyParts.join(
    ""
  )}</tbody></table>`;
}

let simBikeEtaCache: { pointsVelo: GpxTrackPoint[]; distVelo: number[] } | null = null;
let simRunEtaCache: { pointsRun: GpxTrackPoint[]; distRun: number[]; bikeOffsetS: number } | null = null;
let simBikeEtaAthleteListenerAttached = false;

function renderSimRunKmEtaTable(root: HTMLElement): void {
  const t2SummaryEl = root.querySelector<HTMLElement>("#sim-t2-summary");
  const tableEl = root.querySelector<HTMLElement>("#sim-run-km-eta-table");
  if (!tableEl || !simRunEtaCache) return;
  let bikeTotalS = simRunEtaCache.bikeOffsetS;
  if (simBikeEtaCache) {
    const bikeRows = computeBikeKmEtaRows(
      simBikeEtaCache.pointsVelo,
      simBikeEtaCache.distVelo,
      getFtp(),
      getTotalMassKg(),
      getBikeFatiguePctPerHour()
    );
    bikeTotalS = bikeRows.length > 0 ? bikeRows[bikeRows.length - 1].cumTimeEndS : simRunEtaCache.bikeOffsetS;
  }
  if (t2SummaryEl) t2SummaryEl.innerHTML = buildT2SummaryHtml(bikeTotalS);
  const swimOffsetS = getSwimDurationS() + getT1DurationS() + getT2DurationS();
  const runRows = computeRunKmEtaRows(
    simRunEtaCache.pointsRun,
    simRunEtaCache.distRun,
    getVmaCapKmh(),
    bikeTotalS + swimOffsetS
  );
  const { h: sh, m: sm } = getRaceStartHourMinute();
  let blackShirt = computeBlackShirtResult(runRows, sh, sm);
  tableEl.innerHTML = buildRunKmEtaTableHtml(runRows, blackShirt);

  // Affichage dans la barre « Paramètres » (bloc heure finale — simulation)
  const finalEl = document.getElementById("sim-final-time");
  const finalValEl = document.getElementById("sim-final-time-value");
  if (finalEl && finalValEl) {
    const last = runRows.length > 0 ? runRows[runRows.length - 1] : null;
    if (last && last.isTotal) {
      finalValEl.textContent = formatClockFromRaceStart(last.cumTimeEndAbsS, sh, sm);
      finalEl.hidden = false;
    } else {
      finalValEl.textContent = "—";
      finalEl.hidden = true;
    }
  }

  const shirtEl = document.getElementById("sim-shirt");
  const shirtIconEl = document.getElementById("sim-shirt-icon");
  const shirtLabelEl = document.getElementById("sim-shirt-label");
  if (shirtEl && shirtIconEl && shirtLabelEl) {
    if (!blackShirt) {
      shirtEl.hidden = true;
    } else {
      const svgBlack = `<svg viewBox="0 0 64 64" role="img" aria-label="T-shirt noir"><path d="M18 10l6 6h16l6-6 12 6-8 14-6-3v27H20V27l-6 3-8-14 12-6z" fill="#111827" stroke="#0b1220" stroke-width="2"/><path d="M24 16c2 4 6 6 8 6s6-2 8-6" fill="none" stroke="#374151" stroke-width="2"/></svg>`;
      const svgWhite = `<svg viewBox="0 0 64 64" role="img" aria-label="T-shirt blanc"><path d="M18 10l6 6h16l6-6 12 6-8 14-6-3v27H20V27l-6 3-8-14 12-6z" fill="#ffffff" stroke="#9ca3af" stroke-width="2"/><path d="M24 16c2 4 6 6 8 6s6-2 8-6" fill="none" stroke="#9ca3af" stroke-width="2"/></svg>`;
      shirtIconEl.innerHTML = blackShirt.shirt === "black" ? svgBlack : svgWhite;
      shirtLabelEl.textContent = blackShirt.passed
        ? `BLACK SHIRT (checkpoint 31,188 km avant 18:15)`
        : `WHITE SHIRT (checkpoint 31,188 km après 18:15)`;
      shirtEl.hidden = false;
    }
  }
}

function renderSimBikeKmEtaTable(root: HTMLElement): void {
  const swimSummaryEl = root.querySelector<HTMLElement>("#sim-swim-summary");
  const t1SummaryEl = root.querySelector<HTMLElement>("#sim-t1-summary");
  const tableEl = root.querySelector<HTMLElement>("#sim-velo-km-eta-table");
  if (!tableEl || !simBikeEtaCache) return;
  if (swimSummaryEl) swimSummaryEl.innerHTML = buildSwimSummaryHtml();
  if (t1SummaryEl) t1SummaryEl.innerHTML = buildT1SummaryHtml();
  const P = getFtp();
  const M = getTotalMassKg();
  const fatigue = getBikeFatiguePctPerHour();
  const rows = computeBikeKmEtaRows(simBikeEtaCache.pointsVelo, simBikeEtaCache.distVelo, P, M, fatigue);
  const garminData = loadGarminSplitsFromStorage();
  const garminInterp = garminData ? buildGarminInterpolation(garminData) : null;
  tableEl.innerHTML = buildBikeKmEtaTableHtml(rows, getSwimDurationS() + getT1DurationS(), garminInterp);
  renderSimRunKmEtaTable(root);
}

/** À appeler au démarrage (avant chargement GPX) pour que masse / FTP / VMA / heure de départ mettent à jour les tableaux km. */
export function ensureSimBikeKmEtaAthleteListener(): void {
  if (simBikeEtaAthleteListenerAttached) return;
  simBikeEtaAthleteListenerAttached = true;
  document.addEventListener(ATHLETE_SETTINGS_CHANGED, ((ev: Event) => {
    const e = ev as CustomEvent<{ key: string }>;
    const k = e.detail?.key;
    if (k !== "ftp" && k !== "mass" && k !== "raceStart" && k !== "vma" && k !== "swim" && k !== "t1" && k !== "t2" && k !== "bikeFatigue") return;
    const panel = document.querySelector<HTMLElement>(".panel--simulation");
    if (!panel) return;
    renderSimBikeKmEtaTable(panel);
    renderSimRunKmEtaTable(panel);
    // Re-render les splits Garmin si raceStart / swim / t1 changent (colonne Heure de fin).
    if (isStrictLocalhost() && (k === "raceStart" || k === "swim" || k === "t1")) {
      try {
        const stored = localStorage.getItem(GARMIN_SPLITS_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as GarminSplitsData;
          const splitsBlock = panel.querySelector<HTMLElement>("#sim-garmin-splits-block");
          const splitsTableEl = panel.querySelector<HTMLElement>("#sim-garmin-splits-table");
          applyGarminSplits(splitsBlock, splitsTableEl, parsed);
        }
      } catch {
        /* ignore */
      }
    }
  }) as EventListener);
}

/** Parse un GPX : tous les <trkpt> dans l’ordre du document. */
export function parseGpxTrack(xmlText: string): GpxTrackPoint[] {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) return [];

  const nodes = doc.getElementsByTagName("trkpt");
  const out: GpxTrackPoint[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const lat = parseFloat(el.getAttribute("lat") ?? "");
    const lng = parseFloat(el.getAttribute("lon") ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const eleNode = el.getElementsByTagName("ele")[0];
    const raw = eleNode?.textContent?.trim() ?? "";
    const eleM = parseFloat(raw);
    out.push({ lat, lng, eleM: Number.isFinite(eleM) ? eleM : 0 });
  }
  return out;
}


function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}


/** Profil concaténé vélo → course : distances continues, indice du dernier point « vélo » pour deux couleurs. */

/** Position interpolée sur le parcours à la distance curviligne `distanceM` (m). */

/** Pas d’axe « lisible » (1, 2, 5 × 10ⁿ) pour environ `targetSteps` intervalles (mètres ou tout domaine linéaire). */

function buildAltitudeProfileSvg(
  distancesM: number[],
  elevationsM: number[],
  dualLeg?: { splitIndex: number },
  triLeg?: { swimSplitIndex: number; bikeSplitIndex: number },
  xLabelRef?: { offsetAbsM: number; swimEndAbsM: number; bikeEndAbsM: number; zoomed?: boolean }
): string {
  const n = distancesM.length;
  if (n < 2) {
    return `<p class="sim-velo__chart-empty">Pas assez de points pour tracer le profil.</p>`;
  }

  const { W, H, PAD } = CHART_LAYOUT;
  const pw = W - PAD.l - PAD.r;
  const ph = H - PAD.t - PAD.b;

  const distMax = distancesM[n - 1] || 1;
  const eleMin = Math.min(...elevationsM);
  const eleMax = Math.max(...elevationsM);
  const eleSpan = Math.max(eleMax - eleMin, 1);
  const margin = eleSpan * 0.06;
  const yMin = eleMin - margin;
  const yMax = eleMax + margin;
  const yRange = yMax - yMin;

  const toX = (dM: number) => PAD.l + (dM / distMax) * pw;
  const toY = (ele: number) => PAD.t + ph - ((ele - yMin) / yRange) * ph;

  function elevationAtDistanceM(dM: number): number {
    const n2 = distancesM.length;
    if (n2 === 0) return 0;
    const d = Math.max(0, Math.min(distancesM[n2 - 1] ?? 0, dM));
    let lo = 0;
    let hi = n2 - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((distancesM[mid] ?? 0) < d) lo = mid + 1;
      else hi = mid;
    }
    const i1 = Math.min(Math.max(1, lo), n2 - 1);
    const i0 = i1 - 1;
    const d0 = distancesM[i0] ?? 0;
    const d1 = distancesM[i1] ?? d0;
    const e0 = elevationsM[i0] ?? 0;
    const e1 = elevationsM[i1] ?? e0;
    const t = d1 > d0 + 1e-9 ? (d - d0) / (d1 - d0) : 0;
    return e0 + (e1 - e0) * t;
  }

  function gradeColor(gradePct: number): string {
    // Palette demandée : vert > bleu > orange > rouge > noir
    // Seuils : vert < 6,5% ; bleu < 8% ; orange < 9% ; rouge < 10% ; noir >= 10%
    // Couleurs plus vives (style schéma col).
    if (gradePct < 6.5) return "#00c853"; // vert vif
    if (gradePct < 8) return "#00b0ff"; // bleu vif
    if (gradePct < 9) return "#ff9100"; // orange vif
    if (gradePct < 10) return "#ff1744"; // rouge vif (pas trop sombre)
    return "#111827"; // noir (anthracite)
  }

  function buildBikeClimbGradeBandsLayer(): string {
    // Option B : bandes verticales colorées uniquement sur les 4 grosses montées vélo.
    // Elles doivent rester visibles même en zoom (graphe ou carte).
    if (!xLabelRef) return "";
    const swimEndAbsM = xLabelRef.swimEndAbsM ?? 0;
    if (swimEndAbsM <= 0) return "";

    const climbs = [
      { name: "Port de Balès", startKm: 84.5, endKm: 100.558 },
      { name: "Col de Peyresourde", startKm: 116.11, endKm: 125.679 },
      { name: "Val Louron-Azet", startKm: 138.17, endKm: 143.253 },
      { name: "Col d'Aspin", startKm: 169.6, endKm: 178.943 },
    ];

    const offsetAbsM = xLabelRef.offsetAbsM ?? 0;
    const yBot = PAD.t + ph;
    const rects: string[] = [];

    for (const c of climbs) {
      // Les km fournis sont relatifs au départ vélo → convertir en distance absolue (course) via + natation.
      // Découpage en tranches de 500 m (moyenne par tranche) : alignées sur les bornes 0,5 km vélo.
      const stepKm = 0.5;
      const k0 = Math.floor(c.startKm / stepKm);
      const k1 = Math.ceil(c.endKm / stepKm);
      for (let ki = k0; ki < k1; ki++) {
        const segA = ki * stepKm;
        const segB = segA + stepKm;
        const segStartKm = Math.max(c.startKm, segA);
        const segEndKm = Math.min(c.endKm, segB);
        if (segEndKm - segStartKm < 1e-6) continue;

        const absStart = swimEndAbsM + segStartKm * 1000;
        const absEnd = swimEndAbsM + segEndKm * 1000;
        const startRel = absStart - offsetAbsM;
        const endRel = absEnd - offsetAbsM;
        const a = Math.max(0, Math.min(distMax, Math.min(startRel, endRel)));
        const b = Math.max(0, Math.min(distMax, Math.max(startRel, endRel)));
        if (b - a < 1) continue;

        const e0 = elevationAtDistanceM(a);
        const e1 = elevationAtDistanceM(b);
        const dHoriz = Math.max(1e-6, b - a);
        const grade = Math.max(0, ((e1 - e0) / dHoriz) * 100);
        const fill = gradeColor(grade);
        const x0 = toX(a);
        const x1 = toX(b);
        const yTopBand = Math.min(yBot, toY((e0 + e1) / 2));
        const w = Math.max(0.8, x1 - x0);
        const h = Math.max(0, yBot - yTopBand);
        const title = `${c.name} · ${segStartKm.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}-${segEndKm.toLocaleString(
          "fr-FR",
          { maximumFractionDigits: 2 }
        )} km · ${grade.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}%`;
        rects.push(
          `<rect x="${x0.toFixed(2)}" y="${yTopBand.toFixed(2)}" width="${w.toFixed(
            2
          )}" height="${h.toFixed(2)}" fill="${fill}" opacity="0.88" stroke="rgba(255,255,255,0.75)" stroke-width="1"><title>${escapeHtml(
            title
          )}</title></rect>`
        );

        // Afficher la pente moyenne dans la bande (si suffisamment large).
        if (w >= 18 && h >= 16) {
          const xMid = x0 + w / 2;
          const yTxt = Math.min(yBot - 10, Math.max(PAD.t + 14, yTopBand + 14));
          const gLabel = `${Math.round(grade)}%`;
          rects.push(
            `<text class="sim-alt-grade-label" x="${xMid.toFixed(2)}" y="${yTxt.toFixed(
              2
            )}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(gLabel)}</text>`
          );
        }
      }
    }
    return rects.length ? `<g class="sim-alt-grade-bands" aria-hidden="true">${rects.join("")}</g>` : "";
  }

  const polylinePair = (() => {
    const poly = (pts: string, color: string) =>
      `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const pts = (from: number, to: number) =>
      distancesM.slice(from, to + 1).map((d, j) => `${toX(d).toFixed(1)},${toY(elevationsM[from + j]).toFixed(1)}`).join(" ");
    const idxGte = (arr: number[], v: number): number => {
      let lo = 0;
      let hi = Math.max(0, arr.length - 1);
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if ((arr[mid] ?? 0) >= v) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
    if (triLeg) {
      const si = Math.min(Math.max(0, triLeg.swimSplitIndex), n - 1);
      const bi = Math.min(Math.max(si, triLeg.bikeSplitIndex), n - 1);
      return [poly(pts(0, si), CHART_COLOR_SWIM), poly(pts(si, bi), CHART_COLOR_BIKE), poly(pts(bi, n - 1), CHART_COLOR_RUN)].join("\n");
    }
    if (dualLeg) {
      const si = Math.min(Math.max(0, dualLeg.splitIndex), n - 1);
      return [poly(pts(0, si), CHART_COLOR_BIKE), poly(pts(si, n - 1), CHART_COLOR_RUN)].join("\n");
    }

    // Cas zoom / sous-sélection : si on est entièrement dans une discipline, garder la bonne couleur.
    // Si on coupe des frontières (natation→vélo ou vélo→course), segmenter dynamiquement.
    if (xLabelRef) {
      const swimRel = (xLabelRef.swimEndAbsM ?? 0) - (xLabelRef.offsetAbsM ?? 0);
      const bikeRel = (xLabelRef.bikeEndAbsM ?? 0) - (xLabelRef.offsetAbsM ?? 0);
      const distMaxRel = distancesM[n - 1] ?? 0;
      const crossesSwim = swimRel > 1e-6 && swimRel < distMaxRel - 1e-6;
      const crossesBike = bikeRel > 1e-6 && bikeRel < distMaxRel - 1e-6;

      // Pas de coupure : déduire la discipline à partir de la position absolue.
      if (!crossesSwim && !crossesBike) {
        const absStart = (xLabelRef.offsetAbsM ?? 0) + (distancesM[0] ?? 0);
        const absEnd = (xLabelRef.offsetAbsM ?? 0) + distMaxRel;
        if ((xLabelRef.swimEndAbsM ?? 0) > 1e-6 && absEnd <= (xLabelRef.swimEndAbsM ?? 0) + 1e-6) {
          return poly(pts(0, n - 1), CHART_COLOR_SWIM);
        }
        if ((xLabelRef.bikeEndAbsM ?? 0) > 1e-6 && absStart >= (xLabelRef.bikeEndAbsM ?? 0) - 1e-6) {
          return poly(pts(0, n - 1), CHART_COLOR_RUN);
        }
        return poly(pts(0, n - 1), CHART_COLOR_BIKE);
      }

      // Coupure(s) : construire les segments dans l'ordre.
      const parts: string[] = [];
      let a = 0;
      if (crossesSwim) {
        const si = Math.min(Math.max(1, idxGte(distancesM, swimRel)), n - 1);
        parts.push(poly(pts(0, si), CHART_COLOR_SWIM));
        a = si;
      }
      if (crossesBike) {
        const bi = Math.min(Math.max(a + 1, idxGte(distancesM, bikeRel)), n - 1);
        parts.push(poly(pts(a, bi), CHART_COLOR_BIKE));
        a = bi;
      }
      if (a < n - 1) {
        // Si on a déjà passé bikeRel → course, sinon vélo.
        const afterBike = bikeRel > 1e-6 && (distancesM[a] ?? 0) >= bikeRel - 1e-6;
        parts.push(poly(pts(a, n - 1), afterBike ? CHART_COLOR_RUN : CHART_COLOR_BIKE));
      }
      return parts.join("\n");
    }

    return poly(pts(0, n - 1), CHART_COLOR_BIKE);
  })();

  // Axe Y : pas fixe (m) pour une lecture "profil course" (ex. 200 m).
  const yStepM = 200;
  const yTickStart = Math.ceil(yMin / yStepM) * yStepM;
  const yTicks: number[] = [];
  for (let v = yTickStart; v <= yMax + yStepM * 1e-6; v += yStepM) {
    if (v >= yMin - yStepM * 1e-6) yTicks.push(v);
  }

  const gridLines = yTicks
    .map((v) => {
      const y = toY(v).toFixed(1);
      const atBottom = Math.abs(v - yMin) < yStepM * 0.15;
      const stroke = atBottom ? "#d4d4d8" : "#f0f0f1";
      return `<line x1="${PAD.l}" y1="${y}" x2="${W - PAD.r}" y2="${y}" stroke="${stroke}" stroke-width="1"/>
<text x="${PAD.l - 6}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="#71717a">${Math.round(v)}</text>`;
    })
    .join("\n");

  const targetXSteps = Math.max(18, Math.min(36, Math.floor(pw / 7)));
  const xStepM = niceAxisStepM(distMax, targetXSteps);
  const xDistTicks: number[] = [];
  for (let dM = 0; dM <= distMax + xStepM * 1e-6; dM += xStepM) {
    xDistTicks.push(Math.min(dM, distMax));
  }
  const lastXT = xDistTicks[xDistTicks.length - 1];
  if (lastXT !== undefined && distMax - lastXT > xStepM * 0.08) {
    xDistTicks.push(distMax);
  }

  const yTop = PAD.t;
  const yBot = PAD.t + ph;
  const xLabelY = H - 14;
  const xTitleY = H - 2;
  const xTickFs = xDistTicks.length > 28 ? 8 : 9;

  const courseColMarkersLayer = buildCourseColMarkersLayer({
    toX,
    yTop,
    yBot,
    distMaxRelM: distMax,
    offsetAbsM: xLabelRef?.offsetAbsM ?? 0,
    swimEndAbsM: xLabelRef?.swimEndAbsM ?? 0,
    bikeEndAbsM: xLabelRef?.bikeEndAbsM ?? 0,
    showLabels: xLabelRef?.zoomed === true,
  });

  const xGridAndLabels = xDistTicks
    .map((dM) => {
      const x = toX(dM).toFixed(1);
      const onLeft = dM <= xStepM * 0.02;
      const stroke = onLeft ? "#e8e8ea" : "#f0f0f1";
      const label = xLabelRef
        ? formatLegDistanceKmLabel(xLabelRef.offsetAbsM + dM, xStepM, xLabelRef.bikeEndAbsM, xLabelRef.swimEndAbsM ?? 0)
        : formatDistanceKmLabel(dM, xStepM);
      return `<line x1="${x}" y1="${yTop}" x2="${x}" y2="${yBot}" stroke="${stroke}" stroke-width="1"/>
<text x="${x}" y="${xLabelY}" text-anchor="middle" font-size="${xTickFs}" fill="#71717a">${label}</text>`;
    })
    .join("\n");

  const xStart = toX(0).toFixed(1);
  const ox = PAD.l + 6;
  const oy = PAD.t + 4;
  const gradeBandsLayer = buildBikeClimbGradeBandsLayer();

  return `<svg viewBox="0 0 ${W} ${H}" class="sim-velo__chart-svg" role="img" aria-label="Profil altimétrique — survolez pour prévisualiser, cliquez pour fixer le marqueur sur la carte ; un second curseur suit le survol si un point est déjà fixé">
${gridLines}
${xGridAndLabels}
<line x1="${PAD.l}" y1="${yBot}" x2="${W - PAD.r}" y2="${yBot}" stroke="#c4c4c8" stroke-width="1.5"/>
<line x1="${PAD.l}" y1="${yTop}" x2="${PAD.l}" y2="${yBot}" stroke="#c4c4c8" stroke-width="1.5"/>
<text x="12" y="${(PAD.t + ph / 2).toFixed(0)}" text-anchor="middle" font-size="10" fill="#52525b" transform="rotate(-90 12 ${(PAD.t + ph / 2).toFixed(0)})">Altitude (m)</text>
<text x="${((PAD.l + W - PAD.r) / 2).toFixed(0)}" y="${xTitleY}" text-anchor="middle" font-size="10" fill="#52525b">Distance (km)</text>
${courseColMarkersLayer}
${gradeBandsLayer}
${polylinePair}
<rect id="sim-alt-select-rect" x="${PAD.l}" y="${yTop}" width="0" height="${ph}" fill="rgba(234,88,12,0.10)" stroke="rgba(234,88,12,0.45)" stroke-width="1" visibility="hidden" pointer-events="none"/>
<line id="sim-alt-cursor-locked" class="sim-alt-cursor sim-alt-cursor--locked" x1="${xStart}" y1="${yTop}" x2="${xStart}" y2="${yBot}" stroke="#1c70e2" stroke-width="2" stroke-dasharray="4 4" visibility="hidden" pointer-events="none"/>
<g id="sim-alt-locked-overlay" class="sim-alt-hover-overlay sim-alt-locked-overlay sim-alt-hover-overlay--bike" visibility="hidden" pointer-events="none">
<rect id="sim-alt-locked-bg" x="${ox}" y="${oy}" width="168" height="38" rx="6" fill="#e8f4ff" stroke="#1c70e2" stroke-width="1" opacity="0.98"/>
<text id="sim-alt-locked-line1" x="${ox + 10}" y="${oy + 16}" font-size="12" font-weight="650" fill="#0f3566" font-family="system-ui, Segoe UI, sans-serif">—</text>
<text id="sim-alt-locked-line2" x="${ox + 10}" y="${oy + 30}" font-size="10" fill="#1557b8" font-family="system-ui, Segoe UI, sans-serif"></text>
</g>
<line id="sim-alt-cursor" class="sim-alt-cursor sim-alt-cursor--hover" x1="${xStart}" y1="${yTop}" x2="${xStart}" y2="${yBot}" stroke="#c2410c" stroke-width="2" stroke-dasharray="5 4" visibility="hidden" pointer-events="none"/>
<g id="sim-alt-hover-overlay" class="sim-alt-hover-overlay sim-alt-hover-overlay--bike" visibility="hidden" pointer-events="none">
<rect id="sim-alt-hover-bg" x="${ox}" y="${oy}" width="168" height="38" rx="6" fill="#e8f4ff" stroke="#1c70e2" stroke-width="1" opacity="0.98"/>
<text id="sim-alt-hover-line1" x="${ox + 10}" y="${oy + 16}" font-size="12" font-weight="650" fill="#0f3566" font-family="system-ui, Segoe UI, sans-serif">—</text>
<text id="sim-alt-hover-line2" x="${ox + 10}" y="${oy + 30}" font-size="10" fill="#1557b8" font-family="system-ui, Segoe UI, sans-serif"></text>
</g>
<rect class="sim-alt-chart-hit" x="0" y="0" width="${W}" height="${H}" fill="transparent" style="cursor: crosshair" aria-hidden="true"/>
</svg>`;
}

function computeCumulativeDplusM(elevationsM: number[]): number[] {
  const n = elevationsM.length;
  const out = new Array<number>(n);
  let sum = 0;
  out[0] = 0;
  for (let i = 1; i < n; i++) {
    const d = elevationsM[i] - elevationsM[i - 1];
    if (d > 0) sum += d;
    out[i] = sum;
  }
  return out;
}


function bindAltitudeChartInteraction(
  svg: SVGSVGElement,
  distMaxM: number,
  offsetAbsM: number,
  swimEndAbsM: number,
  bikeEndAbsM: number,
  fullDistancesM: number[],
  fullElevationsM: number[],
  onSelectRangeAbsM: (aAbsM: number, bAbsM: number) => void,
  setRoutePositionM: (distanceAbsM: number) => void,
  resetRoutePosition: () => void
): () => void {
  const { W, H, PAD } = CHART_LAYOUT;
  const pw = W - PAD.l - PAD.r;
  const ph = H - PAD.t - PAD.b;
  const yTop = PAD.t;
  const yBot = PAD.t + ph;
  const cumDplusM = computeCumulativeDplusM(fullElevationsM);
  const dpAtBikeEnd = bikeEndAbsM > 1e-6 ? cumDplusAtDistanceM(bikeEndAbsM, fullDistancesM, cumDplusM) : 0;
  const selectRect = svg.querySelector<SVGRectElement>("#sim-alt-select-rect");
  const cursorHover = svg.querySelector<SVGLineElement>("#sim-alt-cursor");
  const cursorLocked = svg.querySelector<SVGLineElement>("#sim-alt-cursor-locked");
  const overlayHover = svg.querySelector<SVGGElement>("#sim-alt-hover-overlay");
  const overlayLocked = svg.querySelector<SVGGElement>("#sim-alt-locked-overlay");
  const hoverBg = svg.querySelector<SVGRectElement>("#sim-alt-hover-bg");
  const hoverL1 = svg.querySelector<SVGTextElement>("#sim-alt-hover-line1");
  const hoverL2 = svg.querySelector<SVGTextElement>("#sim-alt-hover-line2");
  const lockedBg = svg.querySelector<SVGRectElement>("#sim-alt-locked-bg");
  const lockedL1 = svg.querySelector<SVGTextElement>("#sim-alt-locked-line1");
  const lockedL2 = svg.querySelector<SVGTextElement>("#sim-alt-locked-line2");
  let lockedDistanceM: number | null = null;
  let lastTouchDistanceM: number | null = null;
  let dragStartClientX: number | null = null;
  let dragStartDistanceM: number | null = null;
  let didDragSelect = false;

  function clientXToSvgX(clientX: number): number {
    const rect = svg.getBoundingClientRect();
    const scaleX = W / Math.max(rect.width, 1);
    return (clientX - rect.left) * scaleX;
  }

  function clientXToDistanceM(clientX: number): number {
    const svgX = clientXToSvgX(clientX);
    const clamped = Math.max(PAD.l, Math.min(W - PAD.r, svgX));
    return ((clamped - PAD.l) / pw) * distMaxM;
  }

  function distanceMToSvgX(distanceM: number): number {
    const dClamped = Math.max(0, Math.min(distMaxM, distanceM));
    return PAD.l + (dClamped / distMaxM) * pw;
  }

  function paintOverlayLeg(
    bg: SVGRectElement | null,
    l1: SVGTextElement | null,
    l2: SVGTextElement | null,
    leg: "swim" | "bike" | "run"
  ): void {
    if (!bg || !l1 || !l2) return;
    if (leg === "swim") {
      bg.setAttribute("fill", "#e8f4ff");
      bg.setAttribute("stroke", CHART_COLOR_SWIM);
      l1.setAttribute("fill", "#0f3566");
      l2.setAttribute("fill", "#1557b8");
      return;
    }
    if (leg === "run") {
      bg.setAttribute("fill", "#fff1f2");
      bg.setAttribute("stroke", CHART_COLOR_RUN);
      l1.setAttribute("fill", "#7f1d1d");
      l2.setAttribute("fill", "#b91c1c");
      return;
    }
    bg.setAttribute("fill", "#ecfdf5");
    bg.setAttribute("stroke", CHART_COLOR_BIKE);
    l1.setAttribute("fill", "#064e3b");
    l2.setAttribute("fill", "#047857");
  }

  function paintLockedLeg(leg: "swim" | "bike" | "run"): void {
    if (!lockedBg || !lockedL1 || !lockedL2) return;
    // même palette que le survol, juste un poil plus contrastée
    paintOverlayLeg(lockedBg, lockedL1, lockedL2, leg);
  }

  function updateHoverStackTransform(): void {
    /** Empile l’encart survol sous l’encart fixe pour éviter la superposition exacte. */
    overlayHover?.setAttribute("transform", lockedDistanceM !== null ? "translate(0, 48)" : "");
  }

  function setOneOverlay(
    group: SVGGElement | null,
    bg: SVGRectElement | null,
    l1: SVGTextElement | null,
    l2: SVGTextElement | null,
    distanceM: number,
    visible: boolean,
    lockedStyle: boolean
  ): void {
    if (!group || !l1 || !l2) return;
    if (!visible) {
      group.setAttribute("visibility", "hidden");
      return;
    }
    const dClamped = Math.max(0, Math.min(distMaxM, distanceM));
    const absD = offsetAbsM + dClamped;
    const { line1, line2, leg } = formatAltitudeHoverKm(absD, swimEndAbsM, bikeEndAbsM);
    const dpAbs = cumDplusAtDistanceM(absD, fullDistancesM, cumDplusM);
    const dp = leg === "run" ? Math.max(0, dpAbs - dpAtBikeEnd) : dpAbs;
    const dpStr = Math.round(dp).toLocaleString("fr-FR");
    l1.textContent = line1;
    l2.textContent = line2 ? `${line2} · D+ cumulé ${dpStr} m` : `D+ cumulé ${dpStr} m`;
    group.setAttribute("class", `sim-alt-hover-overlay sim-alt-hover-overlay--${leg}${lockedStyle ? " sim-alt-locked-overlay" : ""}`);
    if (lockedStyle) paintLockedLeg(leg);
    else paintOverlayLeg(bg, l1, l2, leg);
    group.setAttribute("visibility", "visible");
  }

  function setHoverPreview(clientX: number, visible: boolean): void {
    if (!cursorHover) return;
    if (!visible) {
      cursorHover.setAttribute("visibility", "hidden");
      setOneOverlay(overlayHover, hoverBg, hoverL1, hoverL2, 0, false, false);
      return;
    }
    const svgX = Math.max(PAD.l, Math.min(W - PAD.r, clientXToSvgX(clientX)));
    cursorHover.setAttribute("x1", String(svgX));
    cursorHover.setAttribute("x2", String(svgX));
    cursorHover.setAttribute("y1", String(yTop));
    cursorHover.setAttribute("y2", String(yBot));
    cursorHover.setAttribute("visibility", "visible");
    setOneOverlay(overlayHover, hoverBg, hoverL1, hoverL2, clientXToDistanceM(clientX), true, false);
  }

  function showLockedVisuals(distanceM: number): void {
    if (!cursorLocked) return;
    const x = distanceMToSvgX(distanceM);
    cursorLocked.setAttribute("x1", String(x));
    cursorLocked.setAttribute("x2", String(x));
    cursorLocked.setAttribute("y1", String(yTop));
    cursorLocked.setAttribute("y2", String(yBot));
    cursorLocked.setAttribute("visibility", "visible");
    setOneOverlay(overlayLocked, lockedBg, lockedL1, lockedL2, distanceM, true, true);
    updateHoverStackTransform();
  }

  function hideLockedVisuals(): void {
    cursorLocked?.setAttribute("visibility", "hidden");
    setOneOverlay(overlayLocked, lockedBg, lockedL1, lockedL2, 0, false, true);
    updateHoverStackTransform();
  }

  function hideHoverPreview(): void {
    setHoverPreview(0, false);
  }

  function applyPointerLeave(): void {
    hideHoverPreview();
    if (lockedDistanceM !== null) {
      setRoutePositionM(offsetAbsM + lockedDistanceM);
    } else {
      resetRoutePosition();
    }
  }

  const onMoveMouse = (e: MouseEvent) => {
    if (dragStartClientX !== null && dragStartDistanceM !== null) {
      const dNow = clientXToDistanceM(e.clientX);
      const dx = Math.abs(e.clientX - dragStartClientX);
      if (dx >= 3) didDragSelect = true;
      if (selectRect) {
        const x0 = distanceMToSvgX(dragStartDistanceM);
        const x1 = distanceMToSvgX(dNow);
        const x = Math.min(x0, x1);
        const w = Math.max(0, Math.abs(x1 - x0));
        selectRect.setAttribute("x", String(x));
        selectRect.setAttribute("width", String(w));
        selectRect.setAttribute("visibility", w >= 1 ? "visible" : "hidden");
      }
      setHoverPreview(e.clientX, true);
      return;
    }
    setRoutePositionM(offsetAbsM + clientXToDistanceM(e.clientX));
    setHoverPreview(e.clientX, true);
  };

  const onLeaveMouse = () => {
    applyPointerLeave();
  };

  const onDownMouse = (e: MouseEvent) => {
    if (e.button !== 0) return;
    dragStartClientX = e.clientX;
    dragStartDistanceM = clientXToDistanceM(e.clientX);
    didDragSelect = false;
    if (selectRect) {
      selectRect.setAttribute("visibility", "hidden");
      selectRect.setAttribute("width", "0");
    }
  };

  const onUpMouse = (e: MouseEvent) => {
    if (dragStartClientX === null || dragStartDistanceM === null) return;
    const a = dragStartDistanceM;
    const b = clientXToDistanceM(e.clientX);
    const minSelM = 20; // évite les micro-sélections involontaires
    const selLen = Math.abs(b - a);
    if (didDragSelect && selLen >= minSelM) {
      onSelectRangeAbsM(offsetAbsM + Math.min(a, b), offsetAbsM + Math.max(a, b));
    }
    dragStartClientX = null;
    dragStartDistanceM = null;
    didDragSelect = false;
    if (selectRect) {
      selectRect.setAttribute("visibility", "hidden");
      selectRect.setAttribute("width", "0");
    }
  };

  const onClickMouse = (e: MouseEvent) => {
    if (e.altKey) {
      lockedDistanceM = null;
      hideLockedVisuals();
      resetRoutePosition();
      hideHoverPreview();
      return;
    }
    if (didDragSelect) return;
    lockedDistanceM = clientXToDistanceM(e.clientX);
    setRoutePositionM(offsetAbsM + lockedDistanceM);
    showLockedVisuals(lockedDistanceM);
    setHoverPreview(e.clientX, true);
  };

  const onStartTouch = (e: TouchEvent) => {
    if (e.touches.length === 0) return;
    const x = e.touches[0].clientX;
    lastTouchDistanceM = clientXToDistanceM(x);
    setRoutePositionM(offsetAbsM + lastTouchDistanceM);
    setHoverPreview(x, true);
  };

  const onMoveTouch = (e: TouchEvent) => {
    if (e.touches.length === 0) return;
    const x = e.touches[0].clientX;
    lastTouchDistanceM = clientXToDistanceM(x);
    setRoutePositionM(offsetAbsM + lastTouchDistanceM);
    setHoverPreview(x, true);
    e.preventDefault();
  };

  const onEndTouch = () => {
    hideHoverPreview();
    if (lastTouchDistanceM !== null) {
      lockedDistanceM = lastTouchDistanceM;
      setRoutePositionM(offsetAbsM + lockedDistanceM);
      showLockedVisuals(lockedDistanceM);
    }
    lastTouchDistanceM = null;
  };

  svg.addEventListener("mousedown", onDownMouse);
  svg.addEventListener("mousemove", onMoveMouse);
  svg.addEventListener("mouseup", onUpMouse);
  svg.addEventListener("mouseleave", onLeaveMouse);
  svg.addEventListener("click", onClickMouse);
  svg.addEventListener("touchstart", onStartTouch, { passive: true });
  svg.addEventListener("touchmove", onMoveTouch, { passive: false });
  svg.addEventListener("touchend", onEndTouch);
  svg.addEventListener("touchcancel", onEndTouch);

  return () => {
    svg.removeEventListener("mousedown", onDownMouse);
    svg.removeEventListener("mousemove", onMoveMouse);
    svg.removeEventListener("mouseup", onUpMouse);
    svg.removeEventListener("mouseleave", onLeaveMouse);
    svg.removeEventListener("click", onClickMouse);
    svg.removeEventListener("touchstart", onStartTouch);
    svg.removeEventListener("touchmove", onMoveTouch);
    svg.removeEventListener("touchend", onEndTouch);
    svg.removeEventListener("touchcancel", onEndTouch);
  };
}

type MapNavApi = {
  setRoutePositionM: (distanceM: number) => void;
  resetRoutePosition: () => void;
  setSelectionRangeM: (aM: number, bM: number) => void;
  resetZoom: () => void;
};

async function mountLeafletMap(
  mapEl: HTMLElement,
  points: GpxTrackPoint[],
  distM: number[],
  legs: { points: GpxTrackPoint[]; color: string }[]
): Promise<MapNavApi> {
  const L = await ensureLeaflet();
  mapEl.innerHTML = "";

  const map = L.map(mapEl, { scrollWheelZoom: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributeurs',
    maxZoom: 19,
  }).addTo(map);

  const layers = legs.map((leg) => {
    const path = downsample(leg.points, 4000).map((p) => L.latLng(p.lat, p.lng));
    return L.polyline(path, { color: leg.color, weight: 4, opacity: 0.92 }).addTo(map);
  });
  const bounds = L.featureGroup(layers).getBounds();
  map.fitBounds(bounds, { padding: [28, 28] });
  const baseBounds = bounds;

  const selectionLayer = L.polyline([], { color: "#f59e0b", weight: 7, opacity: 0.95 }).addTo(map);

  const start = positionAtDistanceM(0, points, distM);
  const positionMarker = L.circleMarker([start.lat, start.lng], {
    radius: 8,
    weight: 3,
    color: "#ffffff",
    fillColor: "#ea580c",
    fillOpacity: 1,
  }).addTo(map);

  function setRoutePositionM(distanceM: number): void {
    const p = positionAtDistanceM(distanceM, points, distM);
    positionMarker.setLatLng([p.lat, p.lng]);
  }

  function resetRoutePosition(): void {
    setRoutePositionM(0);
  }

  function indexAtDistanceM(distanceM: number): number {
    const n = distM.length;
    if (n === 0) return 0;
    const d = Math.max(0, Math.min(distM[n - 1] ?? 0, distanceM));
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (distM[mid] <= d) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function setSelectionRangeM(aM: number, bM: number): void {
    const a = Math.max(0, Math.min(distM[distM.length - 1] ?? 0, aM));
    const b = Math.max(0, Math.min(distM[distM.length - 1] ?? 0, bM));
    const loD = Math.min(a, b);
    const hiD = Math.max(a, b);
    const i0 = indexAtDistanceM(loD);
    const i1 = indexAtDistanceM(hiD);
    const segPts = points.slice(i0, Math.min(points.length, i1 + 1));
    const path = downsample(segPts, 2500).map((p) => L.latLng(p.lat, p.lng));
    selectionLayer.setLatLngs(path);
    if (path.length >= 2) {
      map.fitBounds(selectionLayer.getBounds(), { padding: [34, 34] });
    }
  }

  function resetZoom(): void {
    selectionLayer.setLatLngs([]);
    map.fitBounds(baseBounds, { padding: [28, 28] });
    resetRoutePosition();
  }

  requestAnimationFrame(() => {
    map.invalidateSize();
  });

  return { setRoutePositionM, resetRoutePosition, setSelectionRangeM, resetZoom };
}

export function getSimulationPanelHtml(): string {
  return `
    <section class="panel panel--simulation" aria-labelledby="t-simulation">
      <h2 id="t-simulation">Simulation</h2>
      <section class="sim-velo" aria-labelledby="t-sim-velo">
        <h3 id="t-sim-velo">Parcours combiné — vélo puis course à pied</h3>
        <p class="sim-velo__hint">
          Les fichiers <code>public/gpx/velo/parcours.gpx</code> (vélo, tracé <strong>bleu</strong>) puis <code>public/gpx/run/parcours.gpx</code> (course, tracé <strong>vert</strong>) sont enchaînés dans l’ordre pour la carte et le profil.
          Carte : fond <strong>OpenStreetMap</strong> (gratuit, via Leaflet depuis unpkg) — respectez les <a href="https://operations.osmfoundation.org/policies/tiles/" rel="noopener noreferrer">conditions d’usage des tuiles OSM</a>.
        </p>
        <p class="sim-velo__stats" id="sim-velo-stats" aria-live="polite"></p>
        <div class="sim-velo__map" id="sim-velo-map" role="region" aria-label="Carte du parcours vélo et course à pied"></div>
        <p class="sim-velo__map-msg" id="sim-velo-map-msg" hidden></p>
        <div class="sim-velo__chart-block">
          <h4 class="sim-velo__chart-title">Profil altimétrique (altitude GPX)</h4>
          <p class="sim-velo__chart-hint">
            <strong>Fonctionnalités (implémentées)</strong>
            <ul class="sim-velo__km-eta-rules">
              <li><strong>Survol / glissé</strong> : un curseur <strong>orange</strong> suit la position et met à jour l’encart.</li>
              <li><strong>Repère fixe</strong> : <strong>clic</strong> pour fixer un repère (<strong>indigo</strong>) tout en gardant le survol actif.</li>
              <li><strong>Effacer</strong> : <strong>Alt+clic</strong> pour supprimer le repère fixe.</li>
              <li><strong>Carte synchronisée</strong> : le marqueur suit le graphique (retour au départ vélo si la souris sort et qu’aucun repère n’est fixé).</li>
              <li><strong>Distances triathlon</strong> : l’encart affiche des km <strong>relatifs</strong> à la discipline (nage, vélo, course).</li>
              <li><strong>Cols</strong> : traits verticaux + noms (et bascule verticale ↔ horizontale selon le zoom).</li>
              <li><strong>Pente (4 cols)</strong> : bandes de couleur + % moyen par tranche de <strong>500 m</strong> sur Balès, Peyresourde, Val Louron-Azet et Aspin.</li>
            </ul>
          </p>
          <div class="sim-velo__chart-actions">
            <button class="sim-velo__chart-btn" id="sim-alt-reset-zoom" type="button" hidden>Réinitialiser le zoom</button>
          </div>
          <div class="sim-velo__chart" id="sim-velo-chart"></div>
        </div>
        <div class="sim-velo__km-eta sim-swim-km-eta" id="sim-swim-km-eta-block" aria-label="Résumé natation">
          <h4 class="sim-velo__chart-title">Natation</h4>
          <div class="sim-velo__km-eta-table-wrap" id="sim-swim-summary" aria-live="polite"></div>
        </div>
        <div class="sim-velo__km-eta sim-transition-km-eta" id="sim-t1-km-eta-block" aria-label="Transition T1">
          <h4 class="sim-velo__chart-title">T1</h4>
          <div class="sim-velo__km-eta-table-wrap" id="sim-t1-summary" aria-live="polite"></div>
        </div>
        <div class="sim-velo__km-eta" id="sim-velo-km-eta-block" aria-labelledby="t-sim-km-eta">
          <h4 class="sim-velo__chart-title" id="t-sim-km-eta">Temps estimé au kilomètre (vélo)</h4>
          <p class="sim-velo__km-eta-hint">
            <strong>Règles de calcul (implémentées)</strong>
            <ul class="sim-velo__km-eta-rules">
              <li>
                <strong>Entrées</strong> : <strong>FTP</strong> = <span class="sim-velo__km-eta-formula"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>P</mi></math></span> (en W) et <strong>masse totale</strong> = <span class="sim-velo__km-eta-formula"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>M</mi></math></span> (en kg).
                Le tracé vient du <strong>GPX</strong> (latitude/longitude/altitude).
              </li>
              <li>
                <strong>Lissage des altitudes</strong> : on applique une <strong>moyenne glissante</strong> sur l’altitude GPX.
                Cela sert à éviter que le bruit ne fasse exploser les petits D+ / D−.
              </li>
              <li>
                <strong>Calcul segment par segment</strong> (entre 2 points GPX) :
                on calcule la distance horizontale <span class="sim-velo__km-eta-formula"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>horiz</mi></math></span>,
                la variation d’altitude <span class="sim-velo__km-eta-formula"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>Δalt</mi></math></span>,
                puis la pente <span class="sim-velo__km-eta-formula"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>α</mi></math></span>
                (angle, basé sur <span class="sim-velo__km-eta-formula"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>Δalt</mi><mo>/</mo><mi>horiz</mi></math></span>).
              </li>
              <li>
                <strong>Vitesse du segment</strong> : on cherche la vitesse <span class="sim-velo__km-eta-formula"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>V</mi></math></span>
                qui “consomme” exactement la puissance fournie, via :
                <span class="sim-velo__km-eta-formula"><math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mi>P</mi><mo>·</mo><mi>η</mi><mo>=</mo><mi>M</mi><mi>g</mi><mo>⁢</mo><mrow><mo>(</mo><mi>sin</mi><mo>⁡</mo><mi>α</mi><mo>+</mo><msub><mi>C</mi><mi>rr</mi></msub><mo>·</mo><mi>cos</mi><mo>⁡</mo><mi>α</mi><mo>)</mo></mrow><mo>·</mo><mi>V</mi><mo>+</mo><mfrac><mn>1</mn><mn>2</mn></mfrac><mi>ρ</mi><mo>·</mo><mi>CdA</mi><mo>·</mo><msup><mi>V</mi><mn>3</mn></msup></mrow></math></span>.
                <span class="sim-velo__km-eta-symbols">Constantes : η=0,97 ; g=9,81 ; Crr=0,006 ; ρ=1,15 ; CdA=0,42. Puissance effective = FTP × (1 − <em>fatigue</em> × h), plancher à 50 %.</span>
              </li>
              <li>
                <strong>Sécurité en descente</strong> : si le segment est en descente (<span class="sim-velo__km-eta-formula"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>Δalt</mi><mo>&lt;</mo><mn>0</mn></math></span>),
                alors la vitesse calculée est plafonnée à <strong>${BIKE_DESCENT_MAX_SPEED_KMH}&nbsp;km/h</strong>.
              </li>
              <li>
                <strong>Temps du segment</strong> :
                on calcule la distance “réelle” du segment (sur la pente) et le temps
                <span class="sim-velo__km-eta-formula"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>t</mi><mo>=</mo><mfrac><msqrt><mrow><msup><mi>horiz</mi><mn>2</mn></msup><mo>+</mo><msup><mi>Δalt</mi><mn>2</mn></msup></mrow></msqrt><mi>V</mi></mfrac></math></span>.
              </li>
              <li>
                <strong>Tableau km/km</strong> :
                chaque segment peut traverser 1 ou plusieurs km : on répartit son <strong>temps</strong> et ses <strong>D+ / D−</strong>
                au prorata dans les tranches de 1000&nbsp;m, puis on cumule pour obtenir la colonne “Temps estimé” et “Heure”.
              </li>
            </ul>
          </p>
          <div class="sim-velo__km-eta-tables-row">
            <div class="sim-velo__km-eta-table-wrap" id="sim-velo-km-eta-table" aria-live="polite"></div>
            ${isStrictLocalhost() ? `<div class="sim-garmin-splits" id="sim-garmin-splits-block" hidden>
              <h4 class="sim-velo__chart-title sim-garmin-splits__title">Splits Garmin Power Guidance</h4>
              <div class="sim-velo__km-eta-table-wrap" id="sim-garmin-splits-table" aria-live="polite"></div>
            </div>` : ""}
          </div>
        </div>
        <div class="sim-velo__km-eta sim-transition-km-eta" id="sim-t2-km-eta-block" aria-label="Transition T2">
          <h4 class="sim-velo__chart-title">T2</h4>
          <div class="sim-velo__km-eta-table-wrap" id="sim-t2-summary" aria-live="polite"></div>
        </div>
        <div class="sim-velo__km-eta sim-run-km-eta" id="sim-run-km-eta-block" aria-labelledby="t-sim-run-km-eta">
          <h4 class="sim-velo__chart-title" id="t-sim-run-km-eta">Temps estimé au kilomètre (course à pied)</h4>
          <p class="sim-velo__km-eta-hint">
            <strong>Règles de calcul (implémentées)</strong>
            <ul class="sim-velo__km-eta-rules">
              <li>
                <strong>Entrée</strong> : ta <strong>VMA CAP</strong> fixe la vitesse “de référence” sur le plat.
                On la convertit en m/s (ex: 14 km/h → 3,89 m/s).
              </li>
              <li>
                <strong>Découpage en km</strong> : pour chaque km, on mesure sur le GPX :
                <strong>distance horizontale</strong>, <strong>D+</strong>, <strong>D−</strong> (altitude <strong>lissée</strong> comme le vélo).
                Puis on calcule <span class="sim-velo__km-eta-formula"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>Δalt</mi><mo>=</mo><mi>D+</mi><mo>−</mo><mi>D−</mi></math></span>.
              </li>
              <li>
                <strong>Temps de base du km</strong> :
                <ul class="sim-velo__km-eta-rules">
                  <li>
                    <strong>Cas montée</strong> : si \(Δalt &gt; ${RUN_NET_ELEV_FLAT_M.toLocaleString("fr-FR")} m\),
                    on prend le plus lent entre :
                    <span class="sim-velo__km-eta-symbols">a) un temps imposé par la montée (VAM = ${RUN_VAM_M_PER_H.toLocaleString("fr-FR")} m D+/h)</span>
                    et <span class="sim-velo__km-eta-symbols">b) le temps à VMA sur l’horizontale</span>.
                  </li>
                  <li>
                    <strong>Cas descente</strong> : si \(Δalt &lt; -${RUN_NET_ELEV_FLAT_M.toLocaleString("fr-FR")} m\),
                    temps à VMA sur l’horizontale, puis si la descente est “très raide”
                    (pente moyenne &lt; ${Math.round(RUN_STEEP_DESCENT_GRADE * 100)}% et horiz ≥ ${RUN_STEEP_DESCENT_MIN_HORIZ_M} m),
                    on applique une pénalité <span class="sim-velo__km-eta-symbols">×${RUN_STEEP_DESCENT_TIME_MULT.toLocaleString("fr-FR")}</span>.
                  </li>
                  <li>
                    <strong>Cas plat</strong> : si \(|Δalt| \le ${RUN_NET_ELEV_FLAT_M.toLocaleString("fr-FR")} m\),
                    temps à VMA sur l’horizontale.
                  </li>
                </ul>
              </li>
              <li>
                <strong>Multiplicateurs</strong> :
                <span class="sim-velo__km-eta-symbols">post-vélo ×${RUN_POST_BIKE_TIME_MULT.toLocaleString("fr-FR")}</span>,
                puis <span class="sim-velo__km-eta-symbols">fatigue +${Math.round(RUN_FATIGUE_PER_HOUR * 100)}% par heure déjà courue</span> (calculée au début du km).
              </li>
              <li>
                <strong>Allure plancher</strong> :
                le km ne peut pas être plus rapide que <span class="sim-velo__km-eta-symbols">${RUN_PACE_MIN_MIN_PER_KM}:00 / km</span>
                (sur la distance horizontale du km).
              </li>
              <li>
                <strong>Heure (fin km)</strong> : inclut départ + <strong>Nage</strong> + <strong>T1</strong> + <strong>Vélo</strong> + <strong>T2</strong> + cumul course jusqu’à la fin du km.
              </li>
            </ul>
          </p>
          <div class="sim-velo__km-eta-table-wrap" id="sim-run-km-eta-table" aria-live="polite"></div>
        </div>
      </section>
    </section>`;
}

interface GarminSplitsData {
  headers: string[];
  rows: string[][];
}

const GARMIN_SPLITS_HIDDEN_COLS_KEY = "xtriascend.garmin.splits.hiddenCols";

/** Parse "H:MM:SS" ou "MM:SS" en secondes, ou null si non reconnu. */
function parseTimeToSeconds(s: string): number | null {
  const parts = s.trim().split(":").map((p) => parseInt(p, 10));
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

/** Formate des secondes en "H:MM:SS" ou "MM:SS". */
function formatSecondsToTime(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.round(total % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

/** Parse un nombre décimal (virgule ou point), renvoie NaN si non parsable. */
function parseDecimal(v: string): number {
  return parseFloat(v.replace(",", ".").replace(/[^\d.-]/g, ""));
}

/**
 * Pour chaque colonne, calcule la valeur TOTAL :
 * - colonne 0 : étiquette fixe "Total"
 * - colonnes durées (H:MM:SS / MM:SS) : somme
 * - colonnes numériques : somme
 * - sinon : "—"
 */
function computeSplitsTotals(rows: string[][], colCount: number): string[] {
  if (rows.length === 0) return [];
  const totals: string[] = [];
  for (let c = 0; c < colCount; c++) {
    if (c === 0) { totals.push("Total"); continue; }
    const cells = rows.map((r) => (r[c] ?? "").trim()).filter((v) => v !== "" && v !== "—");
    if (cells.length === 0) { totals.push("—"); continue; }
    const timeSecs = cells.map(parseTimeToSeconds);
    if (timeSecs.every((v) => v !== null)) {
      totals.push(formatSecondsToTime((timeSecs as number[]).reduce((a, b) => a + b, 0)));
      continue;
    }
    const nums = cells.map(parseDecimal);
    if (nums.every((n) => !isNaN(n))) {
      const sum = nums.reduce((a, b) => a + b, 0);
      const sample = cells[0].replace(",", ".").replace(/[^\d.-]/g, "");
      const dot = sample.indexOf(".");
      const decimals = dot >= 0 ? sample.length - dot - 1 : 0;
      totals.push(sum.toFixed(decimals).replace(".", ","));
      continue;
    }
    totals.push("—");
  }
  return totals;
}

/** Première colonne (hors 0) dont toutes les cellules sont parsables en durée. */
function detectTimeColumnIndex(rows: string[][], colCount: number): number {
  for (let c = 1; c < colCount; c++) {
    const cells = rows.map((r) => (r[c] ?? "").trim()).filter((v) => v !== "" && v !== "—");
    if (cells.length > 0 && cells.every((v) => parseTimeToSeconds(v) !== null)) return c;
  }
  return -1;
}

/**
 * Première colonne dont le header contient "km" ou "dist" (insensible à la casse),
 * ou à défaut première colonne purement numérique différente de la colonne temps.
 */
function detectDistanceColumnIndex(headers: string[], rows: string[][], colCount: number, timeColIdx: number): number {
  // 1. Cherche par header
  for (let c = 1; c < colCount; c++) {
    const h = (headers[c] ?? "").toLowerCase();
    if (h.includes("km") || h.includes("dist")) return c;
  }
  // 2. Fallback : première colonne numérique hors temps
  for (let c = 1; c < colCount; c++) {
    if (c === timeColIdx) continue;
    const cells = rows.map((r) => (r[c] ?? "").trim()).filter((v) => v !== "" && v !== "—");
    if (cells.length > 0 && cells.map(parseDecimal).every((n) => !isNaN(n))) return c;
  }
  return -1;
}

interface GarminSplitsRender {
  tableHtml: string;
  colNames: string[];
}

function buildGarminSplitsTable(data: GarminSplitsData): GarminSplitsRender {
  if (!data.headers.length && !data.rows.length) {
    return {
      tableHtml: `<p class="sim-velo__km-eta-empty">Aucune donnée splits.</p>`,
      colNames: [],
    };
  }
  const colCount = Math.max(data.headers.length, ...data.rows.map((r) => r.length));
  const { h: sh, m: sm } = getRaceStartHourMinute();
  const preOffsetS = getSwimDurationS() + getT1DurationS();
  const timeColIdx = detectTimeColumnIndex(data.rows, colCount);
  const distColIdx = detectDistanceColumnIndex(data.headers, data.rows, colCount, timeColIdx);

  // Km cumulés par ligne
  let cumulKm = 0;
  const kmCumulPerRow: string[] = data.rows.map((row) => {
    if (distColIdx < 0) return "—";
    const km = parseDecimal((row[distColIdx] ?? "").trim());
    if (isNaN(km)) return "—";
    cumulKm += km;
    return cumulKm.toFixed(1).replace(".", ",");
  });
  const totalKm = cumulKm;

  // Heure de fin par ligne
  let cumulS = preOffsetS;
  const clockPerRow: string[] = data.rows.map((row) => {
    if (timeColIdx < 0) return "—";
    const secs = parseTimeToSeconds((row[timeColIdx] ?? "").trim());
    if (secs === null) return "—";
    cumulS += secs;
    return formatClockFromRaceStart(cumulS, sh, sm);
  });
  const finalClockS = cumulS;

  const allHeaders = [...data.headers, "Km cumulés", "Heure de fin"];
  const headCells = allHeaders
    .map((h, i) => `<th class="sim-garmin-splits__th" data-col="${i}">${escapeHtml(h)}</th>`)
    .join("");

  const bodyRows = data.rows
    .map(
      (row, i) =>
        `<tr>${[...row, kmCumulPerRow[i], clockPerRow[i]]
          .map((cell, ci) => `<td class="sim-garmin-splits__td" data-col="${ci}">${escapeHtml(cell)}</td>`)
          .join("")}</tr>`
    )
    .join("");

  const totals = computeSplitsTotals(data.rows, colCount);
  const totalKmCell = distColIdx >= 0 ? totalKm.toFixed(1).replace(".", ",") : "—";
  const totalClockCell = timeColIdx >= 0 ? formatClockFromRaceStart(finalClockS, sh, sm) : "—";
  const totalRow = totals.length
    ? `<tr class="sim-garmin-splits__tr--total">${[...totals, totalKmCell, totalClockCell]
        .map((v, ci) => `<td class="sim-garmin-splits__td" data-col="${ci}">${escapeHtml(v)}</td>`)
        .join("")}</tr>`
    : "";

  return {
    tableHtml: `<table class="sim-garmin-splits__table">
${headCells ? `<thead><tr>${headCells}</tr></thead>` : ""}
<tbody>${bodyRows}${totalRow}</tbody>
</table>`,
    colNames: allHeaders,
  };
}

function applyGarminSplits(splitsBlock: HTMLElement | null, splitsTableEl: HTMLElement | null, data: GarminSplitsData): void {
  if (!splitsBlock || !splitsTableEl) return;

  const { tableHtml, colNames } = buildGarminSplitsTable(data);

  // Colonnes masquées persistées
  let hiddenCols: number[] = [];
  try {
    const raw = localStorage.getItem(GARMIN_SPLITS_HIDDEN_COLS_KEY);
    if (raw) hiddenCols = JSON.parse(raw) as number[];
  } catch { /* ignore */ }

  // Barre de toggles
  const togglesHtml = colNames.length
    ? `<div class="sim-garmin-splits__toggles" aria-label="Afficher / masquer les colonnes">${colNames
        .map(
          (name, i) =>
            `<button type="button" class="sim-garmin-splits__toggle${hiddenCols.includes(i) ? " sim-garmin-splits__toggle--off" : ""}" data-col="${i}" title="${escapeHtml(name)}">${escapeHtml(name)}</button>`
        )
        .join("")}</div>`
    : "";

  // Classes de masquage initiales
  const hideClasses = hiddenCols.map((c) => `sim-garmin-splits__table--hide-col-${c}`).join(" ");
  const htmlWithHide = tableHtml.replace(
    'class="sim-garmin-splits__table"',
    `class="sim-garmin-splits__table${hideClasses ? " " + hideClasses : ""}"`
  );

  splitsTableEl.innerHTML = togglesHtml + htmlWithHide;
  splitsBlock.hidden = false;

  // Événements des toggles
  const tableEl = splitsTableEl.querySelector<HTMLElement>(".sim-garmin-splits__table");
  splitsTableEl.querySelectorAll<HTMLButtonElement>(".sim-garmin-splits__toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const col = parseInt(btn.dataset.col ?? "0", 10);
      let stored: number[] = [];
      try {
        const raw = localStorage.getItem(GARMIN_SPLITS_HIDDEN_COLS_KEY);
        if (raw) stored = JSON.parse(raw) as number[];
      } catch { /* ignore */ }
      const idx = stored.indexOf(col);
      if (idx >= 0) {
        stored.splice(idx, 1);
        btn.classList.remove("sim-garmin-splits__toggle--off");
        tableEl?.classList.remove(`sim-garmin-splits__table--hide-col-${col}`);
      } else {
        stored.push(col);
        btn.classList.add("sim-garmin-splits__toggle--off");
        tableEl?.classList.add(`sim-garmin-splits__table--hide-col-${col}`);
      }
      try { localStorage.setItem(GARMIN_SPLITS_HIDDEN_COLS_KEY, JSON.stringify(stored)); } catch { /* ignore */ }
    });
  });
}

export async function mountSimulationPanel(container: HTMLElement): Promise<void> {
  const root = container.querySelector<HTMLElement>(".panel--simulation");
  if (!root) return;

  const mapEl = root.querySelector<HTMLElement>("#sim-velo-map");
  const mapMsg = root.querySelector<HTMLElement>("#sim-velo-map-msg");
  const chartEl = root.querySelector<HTMLElement>("#sim-velo-chart");
  const resetZoomBtn = root.querySelector<HTMLButtonElement>("#sim-alt-reset-zoom");
  const statsEl = root.querySelector<HTMLElement>("#sim-velo-stats");
  const bikeTableEl = root.querySelector<HTMLElement>("#sim-velo-km-eta-table");
  const runTableEl = root.querySelector<HTMLElement>("#sim-run-km-eta-table");
  const splitsBlock = root.querySelector<HTMLElement>("#sim-garmin-splits-block");
  const splitsTableEl = root.querySelector<HTMLElement>("#sim-garmin-splits-table");
  if (!mapEl || !mapMsg || !chartEl || !resetZoomBtn || !statsEl || !bikeTableEl || !runTableEl) return;

  // Splits Garmin : uniquement en localhost.
  if (isStrictLocalhost()) {
    try {
      const stored = localStorage.getItem(GARMIN_SPLITS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as GarminSplitsData;
        applyGarminSplits(splitsBlock, splitsTableEl, parsed);
      }
    } catch {
      /* ignore */
    }

    document.addEventListener(GARMIN_SPLITS_UPDATED_EVENT, ((ev: Event) => {
      const e = ev as CustomEvent<GarminSplitsData>;
      applyGarminSplits(splitsBlock, splitsTableEl, e.detail);
      renderSimBikeKmEtaTable(root);
    }) as EventListener);
  }

  mapMsg.hidden = true;
  mapMsg.textContent = "";
  chartEl.innerHTML = `<p class="sim-velo__chart-empty">Chargement du GPX…</p>`;
  statsEl.textContent = "";
  const swimSummaryEl = root.querySelector<HTMLElement>("#sim-swim-summary");
  if (swimSummaryEl) swimSummaryEl.innerHTML = buildSwimSummaryHtml();
  const t1SummaryEl = root.querySelector<HTMLElement>("#sim-t1-summary");
  if (t1SummaryEl) t1SummaryEl.innerHTML = buildT1SummaryHtml();
  const t2SummaryEl = root.querySelector<HTMLElement>("#sim-t2-summary");
  if (t2SummaryEl) t2SummaryEl.innerHTML = buildT2SummaryHtml(simRunEtaCache?.bikeOffsetS ?? 0);
  bikeTableEl.innerHTML = `<p class="sim-velo__km-eta-empty">Chargement de l'estimation vélo…</p>`;
  runTableEl.innerHTML = `<p class="sim-velo__km-eta-empty">Chargement de l'estimation course…</p>`;

  let xmlVelo: string;
  let xmlRun: string;
  try {
    const [resVelo, resRun] = await Promise.all([fetch(GPX_VELO_URL), fetch(GPX_RUN_URL)]);
    if (!resVelo.ok) throw new Error("vélo");
    if (!resRun.ok) throw new Error("course");
    xmlVelo = await resVelo.text();
    xmlRun = await resRun.text();
  } catch {
    chartEl.innerHTML = `<p class="sim-velo__chart-empty">Impossible de charger les GPX. Vérifiez <code>public/gpx/velo/parcours.gpx</code> et <code>public/gpx/run/parcours.gpx</code>.</p>`;
    simBikeEtaCache = null;
    simRunEtaCache = null;
    bikeTableEl.innerHTML = `<p class="sim-velo__km-eta-empty">GPX non chargé — pas d’estimation au km.</p>`;
    runTableEl.innerHTML = `<p class="sim-velo__km-eta-empty">GPX non chargé — pas d’estimation course au km.</p>`;
    return;
  }

  const pointsVelo = parseGpxTrack(xmlVelo);
  const pointsRun = parseGpxTrack(xmlRun);
  if (pointsVelo.length < 2 || pointsRun.length < 2) {
    chartEl.innerHTML = `<p class="sim-velo__chart-empty">GPX incomplet : le vélo et la course doivent chacun avoir au moins 2 points &lt;trkpt&gt; valides.</p>`;
    simBikeEtaCache = null;
    simRunEtaCache = null;
    bikeTableEl.innerHTML = `<p class="sim-velo__km-eta-empty">Tracé vélo insuffisant pour l’estimation.</p>`;
    runTableEl.innerHTML = `<p class="sim-velo__km-eta-empty">Tracé course insuffisant pour l’estimation.</p>`;
    return;
  }

  const points = pointsVelo.concat(pointsRun);
  const distM = cumulativeDistancesM(points);
  const distVelo = cumulativeDistancesM(pointsVelo);
  const distRun = cumulativeDistancesM(pointsRun);
  const bikeEndM = distVelo[distVelo.length - 1];
  const runLenM = distM[distM.length - 1] - bikeEndM;
  const elevations = points.map((p) => p.eleM);
  const totalKm = distM[distM.length - 1] / 1000;
  const bikeKm = bikeEndM / 1000;
  const runKm = runLenM / 1000;
  const eleMin = Math.min(...elevations);
  const eleMax = Math.max(...elevations);
  const distMaxM = distM[distM.length - 1];
  statsEl.innerHTML = `Vélo : <strong>${bikeKm.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} km</strong> · Course : <strong>${runKm.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} km</strong> · Total : <strong>${totalKm.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} km</strong> · Alt. min / max : <strong>${Math.round(eleMin)} m</strong> — <strong>${Math.round(eleMax)} m</strong> · ${points.length} points`;

  const prof = mergeBikeRunProfile(
    distVelo,
    pointsVelo.map((p) => p.eleM),
    distRun,
    pointsRun.map((p) => p.eleM),
    3500
  );

  // Prépend le segment natation (flat, 3.8 km) au profil combiné vélo+course.
  const swimEle = pointsVelo[0]?.eleM ?? 0;
  const swimEndAbsM = SWIM_DIST_M;
  const bikeEndAbsM = bikeEndM + SWIM_DIST_M;
  const distMaxAbsM = distMaxM + SWIM_DIST_M;
  const profSwimD = [0, ...prof.d.map((d) => d + SWIM_DIST_M)];
  const profSwimE = [swimEle, ...prof.e];
  const swimSplitIndex = 1;
  const bikeSplitIndex = 1 + prof.splitIndex;
  let selection: { aM: number; bM: number } | null = null;
  let navApi: MapNavApi | null = null;
  let unbindChart: (() => void) | null = null;

  function firstIndexGte(arr: number[], v: number): number {
    let lo = 0;
    let hi = Math.max(0, arr.length - 1);
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (arr[mid] >= v) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  function currentProfileForChart(): {
    distMaxAbsM: number;
    bikeEndAbsM: number;
    distancesM: number[];
    elevationsM: number[];
    dualLeg?: { splitIndex: number };
    triLeg?: { swimSplitIndex: number; bikeSplitIndex: number };
    offsetAbsM: number;
  } {
    if (!selection) {
      return {
        distMaxAbsM,
        bikeEndAbsM,
        distancesM: profSwimD,
        elevationsM: profSwimE,
        triLeg: { swimSplitIndex, bikeSplitIndex },
        offsetAbsM: 0,
      };
    }
    const a = Math.max(0, Math.min(distMaxAbsM, selection.aM));
    const b = Math.max(0, Math.min(distMaxAbsM, selection.bM));
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const dAll = profSwimD;
    const eAll = profSwimE;
    if (dAll.length < 2) {
      return { distMaxAbsM, bikeEndAbsM, distancesM: dAll, elevationsM: eAll, triLeg: { swimSplitIndex, bikeSplitIndex }, offsetAbsM: 0 };
    }
    let i0 = firstIndexGte(dAll, lo);
    i0 = Math.max(0, Math.min(i0, dAll.length - 2));
    let i1 = firstIndexGte(dAll, hi);
    i1 = Math.max(i0 + 1, Math.min(i1, dAll.length - 1));

    const dSliceAbs = dAll.slice(i0, i1 + 1);
    const eSlice = eAll.slice(i0, i1 + 1);
    const offsetAbsM = dSliceAbs[0] ?? 0;
    const dSlice = dSliceAbs.map((x) => x - offsetAbsM);
    const distMaxSel = dSlice[dSlice.length - 1] ?? 0;

    const bikeEndRel = bikeEndAbsM - offsetAbsM;
    let dualLeg: { splitIndex: number } | undefined;
    if (bikeEndRel > 1e-6 && bikeEndRel < distMaxSel - 1e-6) {
      const si = firstIndexGte(dSlice, bikeEndRel);
      dualLeg = { splitIndex: Math.max(0, Math.min(si, dSlice.length - 1)) };
    }
    return { distMaxAbsM: distMaxSel, bikeEndAbsM: bikeEndRel, distancesM: dSlice, elevationsM: eSlice, dualLeg, offsetAbsM };
  }

  function renderSelectedProfile(): void {
    const p = currentProfileForChart();
    chartEl!.innerHTML = buildAltitudeProfileSvg(
      p.distancesM,
      p.elevationsM,
      p.dualLeg,
      p.triLeg,
      {
        offsetAbsM: p.offsetAbsM,
        swimEndAbsM: swimEndAbsM,
        bikeEndAbsM: bikeEndAbsM,
        zoomed: selection !== null,
      }
    );
    resetZoomBtn!.hidden = selection === null;
  }

  function bindChartForCurrentProfile(): void {
    if (!navApi) return;
    const svg = chartEl!.querySelector<SVGSVGElement>("svg");
    if (!svg) return;
    unbindChart?.();
    const p = currentProfileForChart();
    unbindChart = bindAltitudeChartInteraction(
      svg,
      p.distMaxAbsM,
      p.offsetAbsM,
      swimEndAbsM,
      bikeEndAbsM,
      profSwimD,
      profSwimE,
      (aAbs, bAbs) => {
        selection = { aM: aAbs, bM: bAbs };
        navApi?.setSelectionRangeM(aAbs, bAbs);
        renderSelectedProfile();
        bindChartForCurrentProfile();
      },
      (absD) => navApi!.setRoutePositionM(absD),
      () => navApi!.resetRoutePosition()
    );
  }

  resetZoomBtn!.addEventListener("click", () => {
    selection = null;
    navApi?.resetZoom();
    renderSelectedProfile();
    bindChartForCurrentProfile();
  });

  renderSelectedProfile();

  simBikeEtaCache = { pointsVelo, distVelo };
  const bikeRows = computeBikeKmEtaRows(pointsVelo, distVelo, getFtp(), getTotalMassKg(), getBikeFatiguePctPerHour());
  const bikeTotalS = bikeRows.length > 0 ? bikeRows[bikeRows.length - 1].cumTimeEndS : 0;
  simRunEtaCache = { pointsRun, distRun, bikeOffsetS: bikeTotalS };
  ensureSimBikeKmEtaAthleteListener();
  renderSimBikeKmEtaTable(root);
  renderSimRunKmEtaTable(root);

  const svg = chartEl!.querySelector("svg");
  if (svg) {
    try {
      navApi = await mountLeafletMap(mapEl, points, distM, [
        { points: pointsVelo, color: MAP_COLOR_BIKE },
        { points: pointsRun, color: MAP_COLOR_RUN },
      ]);
      bindChartForCurrentProfile();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err);
      mapMsg.hidden = false;
      mapMsg.textContent =
        "Impossible d’afficher la carte (Leaflet / tuiles). Le profil altimétrique reste disponible ci-dessous.";
    }
  }
}
