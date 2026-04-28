/** FTP vélo, VMA course et masse totale : stockage local partagé (Simulation + Suivi). */

const FTP_STORAGE_KEY = "xtriascend_ftp";
const FTP_DEFAULT = 250;

export function getFtp(): number {
  const stored = localStorage.getItem(FTP_STORAGE_KEY);
  const val = stored ? parseInt(stored, 10) : NaN;
  return Number.isFinite(val) && val > 0 ? val : FTP_DEFAULT;
}

export function setFtp(val: number): void {
  localStorage.setItem(FTP_STORAGE_KEY, String(val));
}

const VMA_CAP_STORAGE_KEY = "xtriascend_vma_cap_kmh";
const VMA_CAP_DEFAULT = 14;

/** Ancienne clé (allure seuil min/km) : convertie vers une VMA approx = 60 / allure. */
const THRESHOLD_PACE_STORAGE_KEY = "xtriascend_threshold_pace_cap";

export function getVmaCapKmh(): number {
  const stored = localStorage.getItem(VMA_CAP_STORAGE_KEY);
  const val = stored ? parseFloat(stored.replace(",", ".")) : NaN;
  if (Number.isFinite(val) && val >= 8 && val <= 30) return val;

  const legacy = localStorage.getItem(THRESHOLD_PACE_STORAGE_KEY);
  const pace = legacy ? parseFloat(legacy.replace(",", ".")) : NaN;
  if (Number.isFinite(pace) && pace >= 3 && pace <= 12) {
    const vma = 60 / pace;
    return vma >= 8 && vma <= 30 ? vma : VMA_CAP_DEFAULT;
  }
  return VMA_CAP_DEFAULT;
}

export function setVmaCapKmh(val: number): void {
  localStorage.setItem(VMA_CAP_STORAGE_KEY, String(val));
}

const TOTAL_MASS_STORAGE_KEY = "xtriascend_total_mass_kg";
const LEGACY_SIM_MASS_STORAGE_KEY = "xtri_sim_bike_mass_kg";
const TOTAL_MASS_DEFAULT_KG = 82;

export function getTotalMassKg(): number {
  const stored = localStorage.getItem(TOTAL_MASS_STORAGE_KEY);
  const val = stored ? parseFloat(stored.replace(",", ".")) : NaN;
  if (Number.isFinite(val) && val >= 50 && val <= 150) return val;

  const legacy = localStorage.getItem(LEGACY_SIM_MASS_STORAGE_KEY);
  const leg = legacy ? parseFloat(legacy.replace(",", ".")) : NaN;
  if (Number.isFinite(leg) && leg >= 50 && leg <= 150) {
    setTotalMassKg(leg);
    localStorage.removeItem(LEGACY_SIM_MASS_STORAGE_KEY);
    return leg;
  }
  return TOTAL_MASS_DEFAULT_KG;
}

export function setTotalMassKg(kg: number): void {
  localStorage.setItem(TOTAL_MASS_STORAGE_KEY, String(kg));
}

const RACE_START_STORAGE_KEY = "xtriascend_race_start_hhmm";
const RACE_START_DEFAULT_HHMM = "03:00";

function normalizeHHMM(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Heure de départ de la course (affichage / simulation), format 24 h « HH:MM ». Défaut 03:00. */
export function getRaceStartTimeHHMM(): string {
  const stored = localStorage.getItem(RACE_START_STORAGE_KEY);
  if (stored) {
    const n = normalizeHHMM(stored);
    if (n) return n;
  }
  return RACE_START_DEFAULT_HHMM;
}

export function setRaceStartTimeHHMM(hhmm: string): void {
  const n = normalizeHHMM(hhmm);
  localStorage.setItem(RACE_START_STORAGE_KEY, n ?? RACE_START_DEFAULT_HHMM);
}

const SWIM_PACE_STORAGE_KEY = "xtriascend_swim_pace_mmss_per_100m";
const SWIM_PACE_LEGACY_STORAGE_KEY = "xtriascend_swim_pace_min_per_100m";
const SWIM_PACE_DEFAULT_SEC_PER_100M = 120; // 2:00 / 100 m

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/** Parse "MM:SS" (ou "M:SS") vers secondes. */
function parseMMSS(raw: string): number | null {
  const s = raw.trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const mm = parseInt(m[1], 10);
  const ss = parseInt(m[2], 10);
  if (!Number.isFinite(mm) || !Number.isFinite(ss) || mm < 0 || ss < 0 || ss > 59) return null;
  return mm * 60 + ss;
}

function formatMMSS(totalSec: number): string {
  const s = clampInt(totalSec, 0, 99 * 60 + 59);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** Allure de nage en secondes par 100 m. Défaut : 2:00 /100m. */
export function getSwimPaceSecPer100m(): number {
  const stored = localStorage.getItem(SWIM_PACE_STORAGE_KEY);
  if (stored) {
    const sec = parseMMSS(stored);
    if (sec !== null && sec >= 30 && sec <= 20 * 60) return sec; // 0:30 → 20:00
  }

  // Rétro-compat : ancien stockage en minutes décimales /100m
  const legacy = localStorage.getItem(SWIM_PACE_LEGACY_STORAGE_KEY);
  const legacyVal = legacy ? parseFloat(legacy.replace(",", ".")) : NaN;
  if (Number.isFinite(legacyVal) && legacyVal >= 0.5 && legacyVal <= 10) {
    const sec = Math.round(legacyVal * 60);
    localStorage.setItem(SWIM_PACE_STORAGE_KEY, formatMMSS(sec));
    localStorage.removeItem(SWIM_PACE_LEGACY_STORAGE_KEY);
    return sec;
  }

  return SWIM_PACE_DEFAULT_SEC_PER_100M;
}

export function setSwimPaceSecPer100m(secPer100m: number): void {
  const sec = clampInt(secPer100m, 30, 20 * 60);
  localStorage.setItem(SWIM_PACE_STORAGE_KEY, formatMMSS(sec));
}

/** Compat : minutes /100m (float) pour les calculs existants. */
export function getSwimPaceMinPer100m(): number {
  return getSwimPaceSecPer100m() / 60;
}

/** Compat : setter minutes (float) — converti en MM:SS. */
export function setSwimPaceMinPer100m(val: number): void {
  if (!Number.isFinite(val)) return;
  setSwimPaceSecPer100m(Math.round(val * 60));
}

const T1_STORAGE_KEY = "xtriascend_t1_mmss";
const T2_STORAGE_KEY = "xtriascend_t2_mmss";
const T1_LEGACY_STORAGE_KEY = "xtriascend_t1_min";
const T2_LEGACY_STORAGE_KEY = "xtriascend_t2_min";
const TRANSITION_DEFAULT_SEC = 0;

/** Transition natation → vélo (T1) en secondes. Défaut : 0. */
export function getT1Sec(): number {
  const stored = localStorage.getItem(T1_STORAGE_KEY);
  if (stored) {
    const sec = parseMMSS(stored);
    if (sec !== null && sec >= 0 && sec <= 59 * 60 + 59) return sec;
  }
  // rétro-compat minutes
  const legacy = localStorage.getItem(T1_LEGACY_STORAGE_KEY);
  const legacyVal = legacy ? parseFloat(legacy.replace(",", ".")) : NaN;
  if (Number.isFinite(legacyVal) && legacyVal >= 0 && legacyVal <= 60) {
    const sec = Math.round(legacyVal * 60);
    localStorage.setItem(T1_STORAGE_KEY, formatMMSS(sec));
    localStorage.removeItem(T1_LEGACY_STORAGE_KEY);
    return sec;
  }
  return TRANSITION_DEFAULT_SEC;
}

export function setT1Sec(sec: number): void {
  const s = clampInt(sec, 0, 59 * 60 + 59);
  localStorage.setItem(T1_STORAGE_KEY, formatMMSS(s));
}

/** Transition vélo → CAP (T2) en secondes. Défaut : 0. */
export function getT2Sec(): number {
  const stored = localStorage.getItem(T2_STORAGE_KEY);
  if (stored) {
    const sec = parseMMSS(stored);
    if (sec !== null && sec >= 0 && sec <= 59 * 60 + 59) return sec;
  }
  // rétro-compat minutes
  const legacy = localStorage.getItem(T2_LEGACY_STORAGE_KEY);
  const legacyVal = legacy ? parseFloat(legacy.replace(",", ".")) : NaN;
  if (Number.isFinite(legacyVal) && legacyVal >= 0 && legacyVal <= 60) {
    const sec = Math.round(legacyVal * 60);
    localStorage.setItem(T2_STORAGE_KEY, formatMMSS(sec));
    localStorage.removeItem(T2_LEGACY_STORAGE_KEY);
    return sec;
  }
  return TRANSITION_DEFAULT_SEC;
}

export function setT2Sec(sec: number): void {
  const s = clampInt(sec, 0, 59 * 60 + 59);
  localStorage.setItem(T2_STORAGE_KEY, formatMMSS(s));
}

/** Helpers pour l’UI (valeur MM:SS). */
export function getT1MMSS(): string {
  return formatMMSS(getT1Sec());
}

export function getT2MMSS(): string {
  return formatMMSS(getT2Sec());
}

export function getSwimPaceMMSSPer100m(): string {
  return formatMMSS(getSwimPaceSecPer100m());
}

/** Compat : minutes (float) */
export function getT1Min(): number {
  return getT1Sec() / 60;
}

export function setT1Min(val: number): void {
  if (!Number.isFinite(val)) return;
  setT1Sec(Math.round(val * 60));
}

export function getT2Min(): number {
  return getT2Sec() / 60;
}

export function setT2Min(val: number): void {
  if (!Number.isFinite(val)) return;
  setT2Sec(Math.round(val * 60));
}

/** Décode getRaceStartTimeHHMM() en heures et minutes. */
export function getRaceStartHourMinute(): { h: number; m: number } {
  const n = normalizeHHMM(getRaceStartTimeHHMM());
  if (!n) return { h: 3, m: 0 };
  const [a, b] = n.split(":");
  return { h: parseInt(a, 10), m: parseInt(b, 10) };
}
