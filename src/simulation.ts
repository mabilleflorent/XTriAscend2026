/** Page Simulation : parcours vélo depuis GPX, carte OpenStreetMap (Leaflet), profil altimétrique. */

import { getFtp, getRaceStartHourMinute, getTotalMassKg, getVmaCapKmh } from "./athlete-settings";
import { ATHLETE_SETTINGS_CHANGED } from "./athlete-settings-rail";

const GPX_VELO_URL = "/gpx/velo/parcours.gpx";
const GPX_RUN_URL = "/gpx/run/parcours.gpx";

const MAP_COLOR_BIKE = "#1c70e2";
const MAP_COLOR_RUN = "#1d5c3f";
const CHART_COLOR_BIKE = "#1c70e2";
const CHART_COLOR_RUN = "#22804a";

/** Dimensions du SVG profil (utilisées pour le mapping souris ↔ distance). */
const CHART_LAYOUT = {
  W: 640,
  H: 220,
  PAD: { t: 18, r: 18, b: 46, l: 58 },
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

export type GpxTrackPoint = { lat: number; lng: number; eleM: number };

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR;
  const dLng = (b.lng - a.lng) * toR;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

/**
 * Moyenne glissante sur le profil brut (m) : réduit le bruit altimétrique GPX / baro.
 * Sans lissage, la somme des petites montées/descentes artificielles entre points gonfle
 * fortement D+ et D− par rapport aux totaux type Garmin (ascension / descente « lissée »).
 */
const GPX_ELEV_SMOOTH_HALF_WINDOW = 4;

function smoothElevationProfileM(eleM: number[], halfWindow: number): number[] {
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

/** Modèle statique vélo : P·η = Mg(sinα+Crr·cosα)·V + ½·ρ·CdA·V³ — constantes demandées. */
const BIKE_ETA = 0.97;
const BIKE_G = 9.81;
const BIKE_CRR = 0.005;
const BIKE_RHO = 1.15;
const BIKE_CDA = 0.32;

/**
 * Vitesse max en descente (km/h), convertie en m/s pour le plafonnement segment par segment.
 * Routes de montagne ouvertes : évite des vitesses « physiquement possibles en roue libre » peu réalistes / dangereuses dans le tableau.
 */
const BIKE_DESCENT_MAX_SPEED_KMH = 50;
const BIKE_DESCENT_MAX_SPEED_MPS = BIKE_DESCENT_MAX_SPEED_KMH / 3.6;

/**
 * Vitesse (m/s) solution de P·η = Mg(sinα+Crr cosα)·V + ½ ρ CdA V³.
 * Dichotomie sur [Vlo, Vhi] (robuste si la pente rend k négatif).
 */
function solveSteadyBikeSpeedMps(powerW: number, alphaRad: number, massKg: number): number {
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

function formatEtaSplitTime(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  /** Arrondir d’abord le total en secondes (évite « 3 min 60 s » quand s % 60 arrondit à 60). */
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
  massKg: number
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
    let V = solveSteadyBikeSpeedMps(powerW, alpha, massKg);
    if (dele < -1e-9) {
      V = Math.min(V, BIKE_DESCENT_MAX_SPEED_MPS);
    }
    const tSeg = slant / V;
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

function formatPaceMinPerKm(minPerKm: number): string {
  if (!Number.isFinite(minPerKm) || minPerKm <= 0) return "—";
  /** Arrondir le temps total en secondes, puis min/s — évite « 4:60 » si on arrondit les secondes du reste seul. */
  const totalSec = Math.round(minPerKm * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")} / km`;
}

/** Heure après `offsetSec` depuis le départ (minuit + départ course), avec jour(s) supplémentaires si besoin. */
function formatClockFromRaceStart(offsetSec: number, startH: number, startM: number): string {
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

function buildBikeKmEtaTableHtml(rows: BikeKmEtaRow[]): string {
  if (rows.length === 0) {
    return `<p class="sim-velo__km-eta-empty">Pas assez de données vélo pour estimer les temps au km.</p>`;
  }
  const { h: sh, m: sm } = getRaceStartHourMinute();
  const head = `<thead><tr>
<th scope="col">Km</th>
<th scope="col">Dénivelé</th>
<th scope="col">Temps estimé</th>
<th scope="col">Vmoy</th>
<th scope="col">Heure (fin km)</th>
</tr></thead>`;
  const body = rows
    .map((r) => {
      const vStr = r.avgKmh > 0 ? `${r.avgKmh.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km/h` : "—";
      const timeCol = formatClockFromRaceStart(r.cumTimeEndS, sh, sm);
      const elevHtml = buildElevationMeterHtml(r.dPlusM, r.dMinusM, r.isTotal);
      const trCls = r.isTotal ? ' class="sim-velo__km-eta-tr--total"' : "";
      return `<tr${trCls}>
<td>${escapeHtml(r.kmLabel)}</td>
<td class="sim-velo__km-eta-cell--elev">${elevHtml}</td>
<td class="sim-velo__km-eta-cell--num">${escapeHtml(formatEtaSplitTime(r.timeS))}</td>
<td class="sim-velo__km-eta-cell--num">${escapeHtml(vStr)}</td>
<td class="sim-velo__km-eta-cell--num">${escapeHtml(timeCol)}</td>
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
  const tableEl = root.querySelector<HTMLElement>("#sim-run-km-eta-table");
  if (!tableEl || !simRunEtaCache) return;
  let bikeTotalS = simRunEtaCache.bikeOffsetS;
  if (simBikeEtaCache) {
    const bikeRows = computeBikeKmEtaRows(
      simBikeEtaCache.pointsVelo,
      simBikeEtaCache.distVelo,
      getFtp(),
      getTotalMassKg()
    );
    bikeTotalS = bikeRows.length > 0 ? bikeRows[bikeRows.length - 1].cumTimeEndS : simRunEtaCache.bikeOffsetS;
  }
  const runRows = computeRunKmEtaRows(
    simRunEtaCache.pointsRun,
    simRunEtaCache.distRun,
    getVmaCapKmh(),
    bikeTotalS
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
  const tableEl = root.querySelector<HTMLElement>("#sim-velo-km-eta-table");
  if (!tableEl || !simBikeEtaCache) return;
  const P = getFtp();
  const M = getTotalMassKg();
  const rows = computeBikeKmEtaRows(simBikeEtaCache.pointsVelo, simBikeEtaCache.distVelo, P, M);
  tableEl.innerHTML = buildBikeKmEtaTableHtml(rows);
  renderSimRunKmEtaTable(root);
}

/** À appeler au démarrage (avant chargement GPX) pour que masse / FTP / VMA / heure de départ mettent à jour les tableaux km. */
export function ensureSimBikeKmEtaAthleteListener(): void {
  if (simBikeEtaAthleteListenerAttached) return;
  simBikeEtaAthleteListenerAttached = true;
  document.addEventListener(ATHLETE_SETTINGS_CHANGED, ((ev: Event) => {
    const e = ev as CustomEvent<{ key: string }>;
    const k = e.detail?.key;
    if (k !== "ftp" && k !== "mass" && k !== "raceStart" && k !== "vma") return;
    const panel = document.querySelector<HTMLElement>(".panel--simulation");
    if (!panel) return;
    renderSimBikeKmEtaTable(panel);
    renderSimRunKmEtaTable(panel);
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

/** Distances cumulées le long du tracé (mètres), même longueur que `points`. */
export function cumulativeDistancesM(points: GpxTrackPoint[]): number[] {
  const cumul: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cumul.push(cumul[i - 1] + haversineM(points[i - 1], points[i]));
  }
  return cumul;
}

function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

function downsampleProfile(distancesM: number[], elevationsM: number[], max: number): { d: number[]; e: number[] } {
  if (distancesM.length <= max) return { d: distancesM, e: elevationsM };
  const idxs: number[] = [];
  const step = (distancesM.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) idxs.push(Math.min(distancesM.length - 1, Math.round(i * step)));
  return {
    d: idxs.map((i) => distancesM[i]),
    e: idxs.map((i) => elevationsM[i]),
  };
}

/** Profil concaténé vélo → course : distances continues, indice du dernier point « vélo » pour deux couleurs. */
function mergeBikeRunProfile(
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
  const splitIndex = Math.max(0, pV.d.length - 1);
  return { d: dComb, e: eComb, splitIndex };
}

/** Position interpolée sur le parcours à la distance curviligne `distanceM` (m). */
function positionAtDistanceM(distanceM: number, points: GpxTrackPoint[], distM: number[]): { lat: number; lng: number } {
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

/** Pas d’axe « lisible » (1, 2, 5 × 10ⁿ) pour environ `targetSteps` intervalles (mètres ou tout domaine linéaire). */
function niceAxisStepM(rangeM: number, targetSteps: number): number {
  if (rangeM <= 0 || targetSteps < 1) return 1;
  const rough = rangeM / targetSteps;
  const exp = Math.floor(Math.log10(rough));
  const base = 10 ** exp;
  const m = rough / base;
  const mult = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return mult * base;
}

function formatDistanceKmLabel(dM: number, stepM: number): string {
  const km = dM / 1000;
  // Axe X : privilégier la lisibilité (pas de décimales), même en zoom fort.
  void stepM;
  return km.toLocaleString("fr-FR", { maximumFractionDigits: 0 });
}

function formatLegDistanceKmLabel(absDistanceM: number, stepM: number, bikeEndAbsM: number): string {
  const d = Math.max(0, absDistanceM);
  const km =
    bikeEndAbsM > 1e-6 && d >= bikeEndAbsM - 1e-6 ? (d - bikeEndAbsM) / 1000 : d / 1000;
  // Axe X : lisible (sans décimales). Le détail est dans l’overlay.
  void stepM;
  return km.toLocaleString("fr-FR", { maximumFractionDigits: 0 });
}

function buildAltitudeProfileSvg(
  distancesM: number[],
  elevationsM: number[],
  dualLeg?: { splitIndex: number },
  xLabelRef?: { offsetAbsM: number; bikeEndAbsM: number }
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

  const polylinePair = (() => {
    if (!dualLeg) {
      const pts = distancesM.map((d, i) => `${toX(d).toFixed(1)},${toY(elevationsM[i]).toFixed(1)}`).join(" ");
      return `<polyline points="${pts}" fill="none" stroke="${CHART_COLOR_BIKE}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    const si = Math.min(Math.max(0, dualLeg.splitIndex), n - 1);
    const ptsBike = distancesM
      .slice(0, si + 1)
      .map((d, j) => `${toX(d).toFixed(1)},${toY(elevationsM[j]).toFixed(1)}`)
      .join(" ");
    const ptsRun = distancesM
      .slice(si)
      .map((d, j) => `${toX(d).toFixed(1)},${toY(elevationsM[si + j]).toFixed(1)}`)
      .join(" ");
    return `<polyline points="${ptsBike}" fill="none" stroke="${CHART_COLOR_BIKE}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
<polyline points="${ptsRun}" fill="none" stroke="${CHART_COLOR_RUN}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  })();

  const targetYSteps = Math.max(18, Math.min(36, Math.floor(ph / 7)));
  const yStepM = niceAxisStepM(yRange, targetYSteps);
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

  const xGridAndLabels = xDistTicks
    .map((dM) => {
      const x = toX(dM).toFixed(1);
      const onLeft = dM <= xStepM * 0.02;
      const stroke = onLeft ? "#e8e8ea" : "#f0f0f1";
      const label = xLabelRef
        ? formatLegDistanceKmLabel(xLabelRef.offsetAbsM + dM, xStepM, xLabelRef.bikeEndAbsM)
        : formatDistanceKmLabel(dM, xStepM);
      return `<line x1="${x}" y1="${yTop}" x2="${x}" y2="${yBot}" stroke="${stroke}" stroke-width="1"/>
<text x="${x}" y="${xLabelY}" text-anchor="middle" font-size="${xTickFs}" fill="#71717a">${label}</text>`;
    })
    .join("\n");

  const xStart = toX(0).toFixed(1);
  const ox = PAD.l + 6;
  const oy = PAD.t + 4;

  return `<svg viewBox="0 0 ${W} ${H}" class="sim-velo__chart-svg" role="img" aria-label="Profil altimétrique — survolez pour prévisualiser, cliquez pour fixer le marqueur sur la carte ; un second curseur suit le survol si un point est déjà fixé">
${gridLines}
${xGridAndLabels}
<line x1="${PAD.l}" y1="${yBot}" x2="${W - PAD.r}" y2="${yBot}" stroke="#c4c4c8" stroke-width="1.5"/>
<line x1="${PAD.l}" y1="${yTop}" x2="${PAD.l}" y2="${yBot}" stroke="#c4c4c8" stroke-width="1.5"/>
<text x="12" y="${(PAD.t + ph / 2).toFixed(0)}" text-anchor="middle" font-size="10" fill="#52525b" transform="rotate(-90 12 ${(PAD.t + ph / 2).toFixed(0)})">Altitude (m)</text>
<text x="${((PAD.l + W - PAD.r) / 2).toFixed(0)}" y="${xTitleY}" text-anchor="middle" font-size="10" fill="#52525b">Distance (km)</text>
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

function cumDplusAtDistanceM(distanceM: number, distancesM: number[], cumDplusM: number[]): number {
  const n = Math.min(distancesM.length, cumDplusM.length);
  if (n === 0) return 0;
  const d = Math.max(0, Math.min(distancesM[n - 1] ?? 0, distanceM));
  // Trouver le dernier index i tel que distancesM[i] <= d (distances croissantes)
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (distancesM[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  return cumDplusM[lo] ?? 0;
}

/** Texte overlay : vélo = km cumulés parcours ; course = compteur remis à 0 au début du tracé course. */
function formatAltitudeHoverKm(
  distanceM: number,
  bikeEndM: number
): { line1: string; line2: string; leg: "bike" | "run" } {
  const d = Math.max(0, distanceM);
  const fmt = (km: number) =>
    `${km.toLocaleString("fr-FR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} km`;

  if (bikeEndM > 1e-6 && d >= bikeEndM - 1e-6) {
    const runKm = (d - bikeEndM) / 1000;
    return { line1: fmt(runKm), line2: "Course à pied", leg: "run" };
  }

  return {
    line1: fmt(d / 1000),
    line2: bikeEndM > 1e-6 ? "Vélo" : "",
    leg: "bike",
  };
}

function bindAltitudeChartInteraction(
  svg: SVGSVGElement,
  distMaxM: number,
  offsetAbsM: number,
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
    leg: "bike" | "run"
  ): void {
    if (!bg || !l1 || !l2) return;
    if (leg === "run") {
      bg.setAttribute("fill", "#f0fdf4");
      bg.setAttribute("stroke", "#16a34a");
      l1.setAttribute("fill", "#14532d");
      l2.setAttribute("fill", "#15803d");
    } else {
      bg.setAttribute("fill", "#e8f4ff");
      bg.setAttribute("stroke", "#1c70e2");
      l1.setAttribute("fill", "#0f3566");
      l2.setAttribute("fill", "#1557b8");
    }
  }

  function paintLockedLeg(leg: "bike" | "run"): void {
    if (!lockedBg || !lockedL1 || !lockedL2) return;
    if (leg === "run") {
      lockedBg.setAttribute("fill", "#ecfdf5");
      lockedBg.setAttribute("stroke", "#059669");
      lockedL1.setAttribute("fill", "#064e3b");
      lockedL2.setAttribute("fill", "#047857");
    } else {
      lockedBg.setAttribute("fill", "#e6f2fc");
      lockedBg.setAttribute("stroke", "#1c70e2");
      lockedL1.setAttribute("fill", "#0f3566");
      lockedL2.setAttribute("fill", "#1557b8");
    }
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
    const { line1, line2, leg } = formatAltitudeHoverKm(absD, bikeEndAbsM);
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
          <p class="sim-velo__chart-hint">Survolez ou faites glisser le doigt : le curseur <strong>orange</strong> (pointillés) et l’encart suivent la position ; l’encart est <strong>bleu</strong> sur le vélo (km cumulés depuis le départ) et <strong>vert</strong> sur la course (compteur <strong>repart à 0</strong> au début du tracé course). <strong>Cliquez</strong> (ou relâchez après un glissement tactile) pour <strong>fixer</strong> la position sur la carte : une <strong>deuxième</strong> ligne en pointillés <strong>indigo</strong> et son encart restent visibles ; le curseur orange continue de suivre le survol. <strong>Alt+clic</strong> sur le graphique pour effacer le repère fixe. Quand la souris quitte le graphique sans repère fixe, le marqueur carte revient au départ vélo.</p>
          <div class="sim-velo__chart-actions">
            <button class="sim-velo__chart-btn" id="sim-alt-reset-zoom" type="button" hidden>Réinitialiser le zoom</button>
          </div>
          <div class="sim-velo__chart" id="sim-velo-chart"></div>
        </div>
        <div class="sim-velo__km-eta" id="sim-velo-km-eta-block" aria-labelledby="t-sim-km-eta">
          <h4 class="sim-velo__chart-title" id="t-sim-km-eta">Temps estimé au kilomètre (vélo)</h4>
          <p class="sim-velo__km-eta-hint">
            Modèle puissance constante : <span class="sim-velo__km-eta-formula">P<sub>fournie</sub>·η = Mg(sinα+C<sub>rr</sub>cosα)·V + ½ρ·CdA·V³</span>
            avec η=0,97, g=9,81&nbsp;m/s², C<sub>rr</sub>=0,005, ρ=1,15&nbsp;kg/m³, CdA=0,32&nbsp;m² ; α et les <strong>D+ / D−</strong> au km partent d’un <strong>profil altimétrique lissé</strong> (moyenne glissante sur les points du GPX), plus proche des totaux « ascension / descente » des appareils que le brut point-à-point.
            En <strong>descente</strong> (Δalt &lt; 0 sur le segment), la vitesse simulée est <strong>plafonnée à 75&nbsp;km/h</strong> (routes ouvertes, prudence).
            La <strong>masse totale</strong>, la <strong>FTP vélo</strong> et l’<strong>heure de départ de la course</strong> se règlent dans le menu <strong>Paramètres</strong> à gauche. La colonne <strong>Heure (fin km)</strong> indique l’heure cumulée à la fin de chaque kilomètre vélo (et à la fin du tracé vélo pour la ligne Total) ; si l’effort dépasse minuit, un repère <strong>(+N j)</strong> est affiché.
          </p>
          <div class="sim-velo__km-eta-table-wrap" id="sim-velo-km-eta-table" aria-live="polite"></div>
        </div>
        <div class="sim-velo__km-eta sim-run-km-eta" id="sim-run-km-eta-block" aria-labelledby="t-sim-run-km-eta">
          <h4 class="sim-velo__chart-title" id="t-sim-run-km-eta">Temps estimé au kilomètre (course à pied)</h4>
          <p class="sim-velo__km-eta-hint">
            Par kilomètre, le <strong>Δalt net</strong> (D+ − D−, comme la jauge rouge / verte) fixe le modèle :
            <strong>km rouge</strong> (gain net) → temps = max(temps imposé par <strong>1000 m D+ / h</strong> sur le D+ du km, temps à allure <strong>VMA</strong> sur la distance horizontale) ;
            <strong>km vert</strong> (perte nette) → temps à allure <strong>VMA</strong> sur l’horizontale, avec <strong>+35&nbsp;% de temps</strong> si la pente moyenne du km est &lt; ≈ −28&nbsp;% et l’horizontale ≥ ~18&nbsp;m (freinage).
            <strong>Post-vélo</strong> : +8&nbsp;% de temps sur <strong>chaque</strong> km de course (malus d’enchaînement après le vélo).
            <strong>Allure plancher</strong> : au plus rapide <strong>5:00 / km</strong> sur la distance horizontale du km (on ne descend pas sous ce seuil).
            <strong>Fatigue</strong> : +5&nbsp;% de temps par heure de course déjà écoulée au <strong>début du km</strong> (en plus du post-vélo).
            <strong>D+ / D−</strong> : même <strong>lissage altimétrique GPX</strong> que le vélo. <strong>Heure (fin km)</strong> : départ affiché + vélo + course jusqu’à la fin du km.
          </p>
          <div class="sim-velo__km-eta-table-wrap" id="sim-run-km-eta-table" aria-live="polite"></div>
        </div>
      </section>
    </section>`;
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
  if (!mapEl || !mapMsg || !chartEl || !resetZoomBtn || !statsEl || !bikeTableEl || !runTableEl) return;

  mapMsg.hidden = true;
  mapMsg.textContent = "";
  chartEl.innerHTML = `<p class="sim-velo__chart-empty">Chargement du GPX…</p>`;
  statsEl.textContent = "";
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
    distMaxM: number;
    bikeEndM: number;
    distancesM: number[];
    elevationsM: number[];
    dualLeg?: { splitIndex: number };
    offsetAbsM: number;
  } {
    if (!selection) {
      return {
        distMaxM,
        bikeEndM,
        distancesM: prof.d,
        elevationsM: prof.e,
        dualLeg: { splitIndex: prof.splitIndex },
        offsetAbsM: 0,
      };
    }
    const a = Math.max(0, Math.min(distMaxM, selection.aM));
    const b = Math.max(0, Math.min(distMaxM, selection.bM));
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const dAll = prof.d;
    const eAll = prof.e;
    if (dAll.length < 2) {
      return { distMaxM, bikeEndM, distancesM: dAll, elevationsM: eAll, dualLeg: { splitIndex: prof.splitIndex }, offsetAbsM: 0 };
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

    const bikeEndRel = bikeEndM - offsetAbsM;
    let dualLeg: { splitIndex: number } | undefined;
    if (bikeEndRel > 1e-6 && bikeEndRel < distMaxSel - 1e-6) {
      const si = firstIndexGte(dSlice, bikeEndRel);
      dualLeg = { splitIndex: Math.max(0, Math.min(si, dSlice.length - 1)) };
    }
    return { distMaxM: distMaxSel, bikeEndM: bikeEndRel, distancesM: dSlice, elevationsM: eSlice, dualLeg, offsetAbsM };
  }

  function renderSelectedProfile(): void {
    const p = currentProfileForChart();
    chartEl!.innerHTML = buildAltitudeProfileSvg(p.distancesM, p.elevationsM, p.dualLeg, {
      offsetAbsM: p.offsetAbsM,
      bikeEndAbsM: bikeEndM,
    });
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
      p.distMaxM,
      p.offsetAbsM,
      bikeEndM,
      prof.d,
      prof.e,
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
  const bikeRows = computeBikeKmEtaRows(pointsVelo, distVelo, getFtp(), getTotalMassKg());
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
