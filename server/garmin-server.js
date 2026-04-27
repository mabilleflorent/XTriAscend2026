import express from "express";
import { chromium, request } from "playwright";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function ensureNodeLtsOrDie() {
  const major = parseInt(String(process.versions?.node ?? "0").split(".")[0] ?? "0", 10);
  if (!Number.isFinite(major) || major < 22) {
    // eslint-disable-next-line no-console
    console.error(
      `[garmin-server] Node.js ${process.versions?.node ?? "inconnu"} détecté. Version requise: Node 22 LTS ou supérieur.\n` +
        `→ Installe/upgrade Node depuis https://nodejs.org/ puis relance.`
    );
    process.exit(1);
  }
}

ensureNodeLtsOrDie();

/** Sans `node:child_process/promises` (anciennes versions Node ou runtimes partiels). */
const execFile = promisify(execFileCallback);

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8787;
const HOST = process.env.HOST ?? "127.0.0.1";

/** Parent du dossier `server/` : stable quel que soit le répertoire courant au lancement de `node`. */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SESSION_FILE = path.join(PROJECT_ROOT, ".garmin-session.json");
/** État Playwright (cookies + origines) — meilleure fidélité que `fetch` + chaîne Cookie pour connectapi. */
const STORAGE_STATE_FILE = path.join(PROJECT_ROOT, ".garmin-playwright-storage.json");

/** Page liste activités (filtre vélo virtuel) — étape Playwright 1. */
const GARMIN_ACTIVITIES_LIST_DEFAULT_URL =
  "https://connect.garmin.com/app/activities?activityType=cycling&activitySubType=virtual_ride&startDate=2026-01-01&endDate=2026-08-01";

/** Préfixe classe CSS module de la zone scrollable (le suffixe `__xxxxx` change entre builds). */
const ACTIVITY_LIST_SCROLLABLE_CLASS_PREFIX = "ActivityList_activitiesListItems__";

/** Exports .fit (vélo) — dossier versionné via `.gitkeep`, contenu ignoré par git. */
const GARMIN_BIKE_EXPORT_DIR = path.join(PROJECT_ROOT, "public", "fit", "bike");

/**
 * Id d’activité « ancrage » : on défile la liste jusqu’à ce qu’elle apparaisse (chargement virtualisé),
 * en accumulant tous les ids vus entre le haut de liste et cette ligne.
 */
const GARMIN_LIST_SCROLL_ANCHOR_ACTIVITY_ID_DEFAULT = "21441722196";

/** Profil Chromium persistant (un seul process à la fois sur ce dossier). */
function getGarminUserDataDir() {
  const raw = process.env.GARMIN_USER_DATA_DIR?.trim();
  return raw ? path.resolve(raw) : path.join(PROJECT_ROOT, ".garmin-chromium-profile");
}

/** Échappe la chaîne pour un motif `pkill -f` (regex étendue). */
function escapeForPkillFullCommandLine(s) {
  return s.replace(/[.+*?^$(){}|[\]\\]/g, "\\$&");
}

async function killProcessesUsingGarminProfileDir(profileDir) {
  const abs = path.resolve(profileDir);
  if (process.platform === "win32") {
    const safe = abs.replace(/'/g, "''");
    const cmd = [
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" + safe + "*' }",
      "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ].join(" ");
    try {
      await execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cmd],
        { timeout: 20000, windowsHide: true }
      );
    } catch {
      /* ignore */
    }
    return;
  }
  const pattern = escapeForPkillFullCommandLine(abs);
  try {
    await execFile("pkill", ["-f", pattern], { timeout: 15000 });
  } catch (err) {
    const code = err && typeof err === "object" ? err.code : undefined;
    if (code === 1 || code === 2) return;
    throw err;
  }
}

async function removeChromiumSingletonFiles(profileDir) {
  const names = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
  for (const n of names) {
    await fs.rm(path.join(profileDir, n), { force: true }).catch(() => {});
  }
}

function formatGarminBrowserLaunchError(err) {
  const msg = String(err?.message ?? err);
  const lower = msg.toLowerCase();
  const dir = getGarminUserDataDir();
  if (
    lower.includes("existing browser") ||
    lower.includes("singleton") ||
    lower.includes("user data directory") ||
    lower.includes("profile") ||
    lower.includes("lock")
  ) {
    return `${msg}

Le profil « ${dir} » est probablement déjà utilisé par une autre fenêtre Chromium/Chrome (ou un ancien processus).
→ Ferme toute fenêtre ouverte par le connecteur Garmin, ou exécute par ex. : pkill -f ".garmin-chromium-profile"
→ Ou utilise un autre dossier : GARMIN_USER_DATA_DIR=/tmp/garmin-profile-playwright npm run garmin:server`;
  }
  return `${msg}

Profil Chromium : ${dir}`;
}

/** UA cohérent avec l’OS (évite fingerprint UA Linux vs Windows sous WSL). */
function defaultChromeLikeUserAgent() {
  if (process.platform === "darwin") {
    return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  }
  if (process.platform === "win32") {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  }
  return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
}

/**
 * Lance un contexte persistant en essayant des canaux « navigateur installé »
 * (moins bloqué par le SSO que Chromium Playwright seul).
 * GARMIN_BROWSER_CHANNEL=chrome|msedge|chromium (optionnel, défaut: chrome puis msedge puis chromium)
 */
async function launchGarminBrowserContext() {
  const envChannel = (process.env.GARMIN_BROWSER_CHANNEL || "").trim().toLowerCase();
  const all = ["chrome", "msedge", "chromium"];
  const preferred =
    envChannel === "chrome" || envChannel === "msedge" || envChannel === "chromium"
      ? envChannel
      : null;
  const order = preferred
    ? [preferred, ...all.filter((c) => c !== preferred)]
    : all;

  const commonOpts = {
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
    userAgent: process.env.GARMIN_USER_AGENT?.trim() || defaultChromeLikeUserAgent(),
  };

  let lastErr = null;
  for (const channel of order) {
    try {
      const opts =
        channel === "chromium"
          ? { ...commonOpts }
          : { ...commonOpts, channel };
      const context = await chromium.launchPersistentContext(getGarminUserDataDir(), opts);
      // eslint-disable-next-line no-console
      console.log(`[garmin] Navigateur: ${channel}`);
      return context;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("Impossible de lancer le navigateur");
}

/** Plage « mois civil » local (YYYY-MM-DD). Évite le décalage UTC de toISOString(). */
function monthRangeISO(d = new Date()) {
  const y = d.getFullYear();
  const m = d.getMonth();
  const pad = (n) => String(n).padStart(2, "0");
  const startDate = `${y}-${pad(m + 1)}-01`;
  const lastDay = new Date(y, m + 1, 0).getDate();
  const endDate = `${y}-${pad(m + 1)}-${pad(lastDay)}`;
  return { startDate, endDate };
}

/** Garde un seul scalaire par clé (Express peut renvoyer des tableaux). */
function singleQueryParam(v) {
  if (v === undefined || v === null) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/** Paramètres reconnus pour la recherche d’activités (alignés sur l’URL /app/activities). */
function activitySearchQueryFromRequest(reqQuery) {
  const q = {};
  const startDate = singleQueryParam(reqQuery.startDate);
  const endDate = singleQueryParam(reqQuery.endDate);
  const activityType = singleQueryParam(reqQuery.activityType);
  const activitySubType = singleQueryParam(reqQuery.activitySubType);
  const start = singleQueryParam(reqQuery.start);
  const limit = singleQueryParam(reqQuery.limit);
  const sortOrder = singleQueryParam(reqQuery.sortOrder);
  if (startDate) q.startDate = startDate;
  if (endDate) q.endDate = endDate;
  if (activityType) q.activityType = activityType;
  if (activitySubType) q.activitySubType = activitySubType;
  if (start) q.start = start;
  if (limit) q.limit = limit;
  if (sortOrder) q.sortOrder = sortOrder;
  return q;
}

async function readSessionCookies() {
  try {
    const raw = await fs.readFile(SESSION_FILE, "utf-8");
    const j = JSON.parse(raw);
    if (!Array.isArray(j.cookies) || j.cookies.length === 0) return null;
    return j.cookies;
  } catch {
    return null;
  }
}

async function writeSessionCookies(cookies) {
  const list = Array.isArray(cookies) ? cookies : [];
  await fs.writeFile(SESSION_FILE, JSON.stringify({ savedAt: Date.now(), cookies: list }, null, 2), "utf-8");
  // eslint-disable-next-line no-console
  console.log(`[garmin] Session enregistrée (${list.length} cookies) → ${SESSION_FILE}`);
}

/** Cookies JSON + storageState (pour requêtes API hors navigateur avec la même session). */
async function saveGarminSessionFromContext(context) {
  const cookies = await context.cookies();
  await writeSessionCookies(cookies);
  await context.storageState({ path: STORAGE_STATE_FILE });
  // eslint-disable-next-line no-console
  console.log(`[garmin] storageState → ${STORAGE_STATE_FILE}`);
}

/** URL du SPA Garmin Connect après connexion. */
function isGarminConnectAppUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === "connect.garmin.com" && u.pathname.startsWith("/app");
  } catch {
    return false;
  }
}

/** Heuristique : session web Connect probable (si l’API liste échoue encore). */
function hasLikelyGarminConnectAuth(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return false;
  const dom = (d) => (d || "").replace(/^\./, "").toLowerCase();
  const names = new Set(cookies.filter((c) => dom(c.domain).includes("garmin.com")).map((c) => c.name));
  if (names.has("JWT_WEB") || names.has("SESSIONID")) return true;
  const connectOnly = cookies.filter((c) => dom(c.domain).includes("connect.garmin.com"));
  return connectOnly.length >= 4;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cookiesToHeader(cookies) {
  return cookies
    .filter((c) => c && typeof c.name === "string" && typeof c.value === "string")
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/** Cookies pertinents pour les appels API Garmin (aligné sur python-garminconnect / navigateur). */
function cookiesForGarminApi(cookies) {
  return cookies.filter((c) => {
    const raw = (c.domain || "").replace(/^\./, "").toLowerCase();
    if (!raw) return true;
    return (
      raw === "garmin.com" ||
      raw.endsWith(".garmin.com") ||
      raw === "connect.garmin.com" ||
      raw === "connectapi.garmin.com" ||
      raw === "sso.garmin.com"
    );
  });
}

function parseGarminJsonBody(text, status) {
  const t = text.trim();
  if (t.startsWith("<!DOCTYPE") || t.startsWith("<!doctype") || t.startsWith("<html")) {
    throw new Error(
      "Garmin a renvoyé du HTML au lieu du JSON (souvent session expirée ou mauvais endpoint). Réessaie « Se connecter à Garmin »."
    );
  }
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`Réponse non JSON (HTTP ${status}): ${t.slice(0, 160)}…`);
  }
}

function garminRefererUrl(refererPath) {
  const p = refererPath.startsWith("/") ? refererPath : `/${refererPath}`;
  return `https://connect.garmin.com${p}`;
}

/** Requêtes vers connect.garmin.com (proxy). Si `cookieHeader` est vide, pas d’en-tête Cookie (ex. storageState Playwright). */
function garminConnectWebHeaders(cookieHeader, refererPath = "/app/activities") {
  const ua = process.env.GARMIN_USER_AGENT?.trim() || defaultChromeLikeUserAgent();
  /** @type {Record<string, string>} */
  const h = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "User-Agent": ua,
    Origin: "https://connect.garmin.com",
    Referer: garminRefererUrl(refererPath),
  };
  if (cookieHeader) h.Cookie = cookieHeader;
  return h;
}

/** Requêtes vers connectapi.garmin.com. */
function garminConnectApiHeaders(cookieHeader, refererPath = "/app/activities") {
  const ua = process.env.GARMIN_USER_AGENT?.trim() || defaultChromeLikeUserAgent();
  /** @type {Record<string, string>} */
  const h = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "User-Agent": ua,
    Origin: "https://connect.garmin.com",
    Referer: garminRefererUrl(refererPath),
    NK: "NT",
    "DI-Backend": "connectapi.garmin.com",
  };
  if (cookieHeader) h.Cookie = cookieHeader;
  return h;
}

/** Aperçu corps réponse (debug) — tronqué. */
function bodyPreview(text, max = 500) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** Extrait le jeton depuis le HTML Connect (meta csrf-token ou JSON embarqué). */
function extractGarminCsrfFromHtml(html) {
  if (!html || typeof html !== "string") return null;
  const patterns = [
    /<meta\s+name="csrf-token"\s+content="([^"]+)"/i,
    /<meta\s+content="([^"]+)"\s+name="csrf-token"/i,
    /"csrfToken"\s*:\s*"([^"]+)"/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

/**
 * Charge une page shell Connect avec les cookies pour obtenir le CSRF attendu par gc-api.
 * (Aligné sur python-garminconnect : en-tête connect-csrf-token.)
 */
async function fetchGarminCsrfToken(cookieHeader) {
  if (!cookieHeader) return null;
  const ua = process.env.GARMIN_USER_AGENT?.trim() || defaultChromeLikeUserAgent();
  const tryUrls = [
    "https://connect.garmin.com/app/",
    "https://connect.garmin.com/app/activities",
    "https://connect.garmin.com/modern/",
  ];
  for (const url of tryUrls) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
          "User-Agent": ua,
          Origin: "https://connect.garmin.com",
          Referer: "https://connect.garmin.com/",
          Cookie: cookieHeader,
        },
      });
      const text = await res.text();
      const tok = extractGarminCsrfFromHtml(text);
      if (tok) return tok;
    } catch {
      /* essai suivant */
    }
  }
  // Shell HTML du proxy (souvent 200) contient `<meta name="csrf-token" …>` même quand /app/ est une SPA minimale.
  try {
    const shellUrl =
      "https://connect.garmin.com/modern/proxy/activitylist-service/activities/search/activities?startDate=2020-01-01&endDate=2030-01-01&start=0&limit=1";
    const res = await fetch(shellUrl, {
      headers: garminConnectWebHeaders(cookieHeader, "/app/activities"),
    });
    const tok = extractGarminCsrfFromHtml(await res.text());
    if (tok) return tok;
  } catch {
    /* ignore */
  }
  return null;
}

/** En-tête attendu par l’API gc-api côté SPA. */
function withGarminCsrfHeader(headers, csrfToken) {
  if (!csrfToken) return headers;
  return { ...headers, "connect-csrf-token": csrfToken };
}

/**
 * Uniquement des logs (console + texte pour la page) : appelle les URLs activités comme en prod, sans interpréter le JSON.
 */
async function logGarminActivityRequests(cookies, query = {}) {
  const lines = [];
  const log = (s) => {
    lines.push(s);
    // eslint-disable-next-line no-console
    console.log(`[garmin/activities] ${s}`);
  };

  log(`--- Diagnostic ${new Date().toISOString()} ---`);
  const { startDate: monthStart, endDate: monthEnd } = monthRangeISO(new Date());
  const params = new URLSearchParams();
  params.set("startDate", query.startDate ?? monthStart);
  params.set("endDate", query.endDate ?? monthEnd);
  params.set("start", query.start ?? "0");
  params.set("limit", query.limit ?? "100");
  if (query.activityType) params.set("activityType", query.activityType);
  if (query.activitySubType) params.set("activitySubType", query.activitySubType);
  if (query.sortOrder) params.set("sortOrder", query.sortOrder);
  const qs = params.toString();
  const referer = `/app/activities?${qs}`;
  const pathSeg = "activitylist-service/activities/search/activities";
  /** Endpoint SPA actuel (Network F12), même origine — souvent fiable vs /modern/proxy ou connectapi. */
  const urlGcApi = `https://connect.garmin.com/gc-api/${pathSeg}?${qs}`;

  const filtered = cookiesForGarminApi(cookies);
  const cookieHeader = cookiesToHeader(filtered);
  log(`Cookies Garmin (après filtre): ${filtered.length} entrées, longueur header Cookie: ${cookieHeader.length} car.`);

  const csrf = await fetchGarminCsrfToken(cookieHeader);
  log(
    csrf
      ? `Jeton CSRF récupéré pour gc-api (préfixe ${csrf.slice(0, 8)}…).`
      : "Jeton CSRF: introuvable sur /app/ ou /modern/ — gc-api risque encore 403."
  );

  const fetchAttempts = [
    {
      label: "fetch gc-api",
      url: urlGcApi,
      headers: withGarminCsrfHeader(garminConnectWebHeaders(cookieHeader, referer), csrf),
    },
    { label: "fetch proxy", url: `https://connect.garmin.com/modern/proxy/${pathSeg}?${qs}`, headers: garminConnectWebHeaders(cookieHeader, referer) },
    { label: "fetch connectapi", url: `https://connectapi.garmin.com/${pathSeg}?${qs}`, headers: garminConnectApiHeaders(cookieHeader, referer) },
  ];

  for (const { label, url, headers } of fetchAttempts) {
    log(`[${label}] GET ${url}`);
    log(`[${label}] En-têtes: ${Object.keys(headers).join(", ")}`);
    try {
      const res = await fetch(url, { headers });
      const text = await res.text();
      const ct = res.headers.get("content-type") || "(aucun)";
      log(`[${label}] → HTTP ${res.status}, Content-Type: ${ct}, corps: ${text.length} octets`);
      log(`[${label}] Aperçu corps: ${bodyPreview(text)}`);
    } catch (err) {
      log(`[${label}] → exception: ${String(err?.message ?? err)}`);
    }
  }

  let storageOk = false;
  try {
    await fs.access(STORAGE_STATE_FILE);
    storageOk = true;
  } catch {
    log("Playwright storageState: fichier absent → pas d’essai request.newContext.");
  }

  if (storageOk) {
    let apiContext = null;
    try {
      apiContext = await request.newContext({
        storageState: STORAGE_STATE_FILE,
        userAgent: process.env.GARMIN_USER_AGENT?.trim() || defaultChromeLikeUserAgent(),
      });
      let csrfPw = null;
      try {
        const warm = await apiContext.get("https://connect.garmin.com/app/", {
          headers: garminConnectWebHeaders("", "/app/"),
        });
        csrfPw = extractGarminCsrfFromHtml(await warm.text());
        log(csrfPw ? `Playwright: CSRF depuis /app/ (préfixe ${csrfPw.slice(0, 8)}…).` : "Playwright: CSRF introuvable sur /app/.");
      } catch (e) {
        log(`Playwright: lecture CSRF: ${String(e?.message ?? e)}`);
      }

      const pwAttempts = [
        { label: "pw gc-api", url: urlGcApi, headers: withGarminCsrfHeader(garminConnectWebHeaders("", referer), csrfPw) },
        { label: "pw proxy", url: `https://connect.garmin.com/modern/proxy/${pathSeg}?${qs}`, headers: garminConnectWebHeaders("", referer) },
        { label: "pw connectapi", url: `https://connectapi.garmin.com/${pathSeg}?${qs}`, headers: garminConnectApiHeaders("", referer) },
      ];
      for (const { label, url, headers } of pwAttempts) {
        log(`[${label}] GET ${url}`);
        log(`[${label}] En-têtes: ${Object.keys(headers).join(", ")}`);
        try {
          const res = await apiContext.get(url, { headers });
          const text = await res.text();
          const hdr = res.headers();
          const ct = hdr["content-type"] ?? hdr["Content-Type"] ?? "(aucun)";
          log(`[${label}] → HTTP ${res.status()}, Content-Type: ${ct}, corps: ${text.length} octets`);
          log(`[${label}] Aperçu corps: ${bodyPreview(text)}`);
        } catch (err) {
          log(`[${label}] → exception: ${String(err?.message ?? err)}`);
        }
      }
    } catch (err) {
      log(`Playwright newContext / requêtes: ${String(err?.message ?? err)}`);
    } finally {
      await apiContext?.dispose();
    }
  }

  log("--- Fin diagnostic ---");
  return lines;
}

/**
 * Même liste d’activités via le client HTTP Playwright + storageState (souvent OK quand `fetch` + Cookie reçoit 403/HTML).
 */
async function listActivitiesWithPlaywrightStorage(qs, refererPath) {
  try {
    await fs.access(STORAGE_STATE_FILE);
  } catch {
    return null;
  }

  const pathSeg = "activitylist-service/activities/search/activities";
  const attempts = [
    { url: `https://connect.garmin.com/gc-api/${pathSeg}?${qs}`, headers: garminConnectWebHeaders("", refererPath) },
    { url: `https://connect.garmin.com/modern/proxy/${pathSeg}?${qs}`, headers: garminConnectWebHeaders("", refererPath) },
    { url: `https://connectapi.garmin.com/${pathSeg}?${qs}`, headers: garminConnectApiHeaders("", refererPath) },
  ];

  const apiContext = await request.newContext({
    storageState: STORAGE_STATE_FILE,
    userAgent: process.env.GARMIN_USER_AGENT?.trim() || defaultChromeLikeUserAgent(),
  });

  let csrfPw = null;
  try {
    const warm = await apiContext.get("https://connect.garmin.com/app/", {
      headers: garminConnectWebHeaders("", "/app/"),
    });
    csrfPw = extractGarminCsrfFromHtml(await warm.text());
  } catch {
    /* ignore */
  }

  const attemptsWithCsrf = attempts.map((a, i) =>
    i === 0 ? { ...a, headers: withGarminCsrfHeader(a.headers, csrfPw) } : a
  );

  const errors = [];
  try {
    for (const { url, headers } of attemptsWithCsrf) {
      try {
        const res = await apiContext.get(url, { headers });
        const text = await res.text();
        if (!res.ok()) {
          throw new Error(`Garmin HTTP ${res.status()} (${url.slice(0, 72)}…): ${text.slice(0, 320)}`);
        }
        return parseGarminJsonBody(text, res.status());
      } catch (e) {
        errors.push(String(e?.message ?? e));
      }
    }
    throw new Error(errors.join("\n---\n"));
  } finally {
    await apiContext.dispose();
  }
}

/**
 * Recherche d’activités (même logique que l’UI « /app/activities » — non documentée officiellement).
 * @param {Record<string, string>} [query] — ex. activityType, activitySubType, startDate, endDate (voir page Garmin)
 */
async function listActivities(cookies, query = {}) {
  const { startDate: monthStart, endDate: monthEnd } = monthRangeISO(new Date());
  const params = new URLSearchParams();
  params.set("startDate", query.startDate ?? monthStart);
  params.set("endDate", query.endDate ?? monthEnd);
  params.set("start", query.start ?? "0");
  params.set("limit", query.limit ?? "100");
  if (query.activityType) params.set("activityType", query.activityType);
  if (query.activitySubType) params.set("activitySubType", query.activitySubType);
  if (query.sortOrder) params.set("sortOrder", query.sortOrder);

  const qs = params.toString();
  const cookieHeader = cookiesToHeader(cookiesForGarminApi(cookies));
  if (!cookieHeader) {
    throw new Error("Aucun cookie Garmin utilisable. Reconnecte-toi.");
  }

  const csrf = await fetchGarminCsrfToken(cookieHeader);

  const referer = `/app/activities?${qs}`;
  const pathSeg = "activitylist-service/activities/search/activities";

  /** `gc-api` : endpoint observé dans le Network du SPA Connect (JSON). */
  const attempts = [
    {
      url: `https://connect.garmin.com/gc-api/${pathSeg}?${qs}`,
      headers: withGarminCsrfHeader(garminConnectWebHeaders(cookieHeader, referer), csrf),
    },
    {
      url: `https://connect.garmin.com/modern/proxy/${pathSeg}?${qs}`,
      headers: garminConnectWebHeaders(cookieHeader, referer),
    },
    {
      url: `https://connectapi.garmin.com/${pathSeg}?${qs}`,
      headers: garminConnectApiHeaders(cookieHeader, referer),
    },
  ];

  const errors = [];
  for (const { url, headers } of attempts) {
    try {
      const res = await fetch(url, { headers });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Garmin HTTP ${res.status} (${url.slice(0, 72)}…): ${text.slice(0, 320)}`);
      }
      return parseGarminJsonBody(text, res.status);
    } catch (e) {
      errors.push(String(e?.message ?? e));
    }
  }

  try {
    const pw = await listActivitiesWithPlaywrightStorage(qs, referer);
    if (pw != null) return pw;
  } catch (e) {
    errors.push(String(e?.message ?? e));
  }
  throw new Error(errors.join("\n---\n"));
}

function htmlPage(title, body) {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${title}</title>
  <style>
    body{font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:980px;margin:32px auto;padding:0 16px;color:#111827}
    table{width:100%;border-collapse:collapse;margin-top:16px}
    th,td{padding:.55rem .6rem;border-bottom:1px solid #e5e7eb;text-align:left;font-size:.9rem}
    th{font-size:.78rem;color:#374151;background:#f9fafb}
    .muted{color:#6b7280}
    code{background:#f3f4f6;padding:.1rem .25rem;border-radius:6px}
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * Une ligne de log par activité sous #scrollableArea.
 * Les hashes CSS modules (`__lWW3P`) changent ; on cible le préfixe avant `__` via [class*="…"].
 */
async function logGarminActivityListItemSummaries(scrollable, log) {
  log("--- Résumé des activités (DOM) ---");
  let items = scrollable.locator(':scope > div[class*="ActivityListItem_listItem__"]');
  let n = await items.count();
  if (n === 0) {
    log("Aucun bloc avec classe contenant « ActivityListItem_listItem__ » — repli sur :scope > div.");
    items = scrollable.locator(":scope > div");
    n = await items.count();
  }
  let shown = 0;
  for (let i = 0; i < n; i++) {
    const item = items.nth(i);
    const link = item.locator('a[href^="/app/activity/"]').first();
    if ((await link.count()) === 0) continue;
    shown += 1;
    const href = (await link.getAttribute("href")) ?? "";
    const title = ((await link.textContent()) ?? "").trim().replace(/\s+/g, " ");
    const id = href.match(/\/app\/activity\/(\d+)/)?.[1] ?? "?";
    const day = ((await item.locator('[class*="ActivityListItem_activityDate__"]').first().textContent().catch(() => "")) ?? "").trim();
    const year = ((await item.locator('[class*="ActivityListItem_activityDateYear__"]').first().textContent().catch(() => "")) ?? "").trim();
    const sport = ((await item.locator('[class*="ActivityListItem_activityTypeText__"]').first().textContent().catch(() => "")) ?? "").trim();
    log(`  #${shown} id=${id} | ${day} ${year} | ${sport} | ${title.slice(0, 120)}`);
  }
  log(`--- ${shown} ligne(s) avec lien /app/activity/ (sur ${n} blocs parcourus) ---`);
}

async function collectGarminActivityIdsFromScrollable(scrollable) {
  /** @type {{ id: string, title: string }[]} */
  const out = [];
  let items = scrollable.locator(':scope > div[class*="ActivityListItem_listItem__"]');
  let n = await items.count();
  if (n === 0) {
    items = scrollable.locator(":scope > div");
    n = await items.count();
  }
  for (let i = 0; i < n; i++) {
    const item = items.nth(i);
    const link = item.locator('a[href^="/app/activity/"]').first();
    if ((await link.count()) === 0) continue;
    const href = (await link.getAttribute("href")) ?? "";
    const m = href.match(/\/app\/activity\/(\d+)/);
    if (!m) continue;
    const title = ((await link.textContent()) ?? "").trim().replace(/\s+/g, " ");
    out.push({ id: m[1], title });
  }
  return out;
}

/**
 * Défile `#scrollableArea` et fusionne les ids visibles à chaque étape jusqu’à voir `anchorActivityId`
 * (ou bas de liste / limite d’itérations). Indispensable si Garmin ne monte pas toute la liste d’un coup.
 * @param {import('playwright').Locator} scrollable
 */
async function accumulateGarminActivityIdsWhileScrollingUntil(scrollable, anchorActivityId, log) {
  /** @type {{ id: string, title: string }[]} */
  const ordered = [];
  const seen = new Set();
  const maxSteps = 450;
  let stagnant = 0;

  const mergeVisible = async () => {
    const batch = await collectGarminActivityIdsFromScrollable(scrollable);
    for (const row of batch) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        ordered.push(row);
      }
    }
  };

  for (let step = 0; step < maxSteps; step++) {
    await mergeVisible();
    if (seen.has(anchorActivityId)) {
      const link = scrollable
        .locator(
          `a[href="/app/activity/${anchorActivityId}"], a[href="/app/activity/${anchorActivityId}/"]`
        )
        .first();
      if ((await link.count()) > 0) {
        await link.scrollIntoViewIfNeeded().catch(() => {});
      }
      log(
        `Liste : activité ancrage ${anchorActivityId} vue après ${step} défilement(s) — ${ordered.length} id(s) distincts accumulés.`
      );
      return ordered;
    }

    const before = await scrollable.evaluate((el) => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));

    await scrollable.evaluate((el) => {
      const delta = Math.max(80, Math.floor(el.clientHeight * 0.88));
      el.scrollTop = Math.min(el.scrollTop + delta, el.scrollHeight);
    });
    await sleep(400);

    const after = await scrollable.evaluate((el) => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));

    if (after.scrollTop === before.scrollTop && after.scrollHeight === before.scrollHeight) {
      stagnant += 1;
      if (stagnant >= 12) {
        log(
          `Liste : défilement sans progrès (${stagnant} fois) — ancrage ${anchorActivityId} ${seen.has(anchorActivityId) ? "trouvé" : "non trouvé"}, ${ordered.length} id(s) accumulés.`
        );
        return ordered;
      }
    } else {
      stagnant = 0;
    }

    const atBottom = after.scrollTop + after.clientHeight >= after.scrollHeight - 6;
    if (atBottom) {
      await sleep(550);
      await mergeVisible();
      if (seen.has(anchorActivityId)) {
        log(`Liste : ancrage ${anchorActivityId} vue en bas de liste — ${ordered.length} id(s) accumulés.`);
        return ordered;
      }
      const scrollHeightAfter = await scrollable.evaluate((el) => el.scrollHeight);
      if (scrollHeightAfter > after.scrollHeight) {
        continue;
      }
      log(
        `Liste : bas de liste atteint, activité ${anchorActivityId} toujours absente — ${ordered.length} id(s) accumulés (filtre URL / période ?).`
      );
      return ordered;
    }
  }

  log(
    `Liste : arrêt après ${maxSteps} défilements — ancrage ${anchorActivityId} ${seen.has(anchorActivityId) ? "trouvé" : "non trouvé"}, ${ordered.length} id(s) accumulés.`
  );
  return ordered;
}

/**
 * Id d’activité cible pour le défilement. `null` = pas de défilement (une seule passe sur le DOM initial).
 * Query `scrollUntil` ou `untilActivity`, sinon env `GARMIN_LIST_SCROLL_UNTIL_ACTIVITY_ID`, sinon défaut
 * {@link GARMIN_LIST_SCROLL_ANCHOR_ACTIVITY_ID_DEFAULT}. `0` / `off` désactive.
 * @returns {string | null}
 */
function parseScrollUntilActivityId(req) {
  const q = singleQueryParam(req.query.scrollUntil) ?? singleQueryParam(req.query.untilActivity);
  if (q === "0" || q === "off" || q === "false") return null;
  if (q != null && q !== "") {
    return /^\d+$/.test(q) ? q : GARMIN_LIST_SCROLL_ANCHOR_ACTIVITY_ID_DEFAULT;
  }
  const env = process.env.GARMIN_LIST_SCROLL_UNTIL_ACTIVITY_ID?.trim();
  if (env === "0" || env === "off" || env === "false") return null;
  if (env && /^\d+$/.test(env)) return env;
  return GARMIN_LIST_SCROLL_ANCHOR_ACTIVITY_ID_DEFAULT;
}

/**
 * Limite optionnelle sur le nombre de fiches à traiter après la liste DOM.
 * Sans `?maxDetails=` ni `GARMIN_MAX_ACTIVITY_DETAILS` : `null` = **tous** les ids issus de l’étape liste (DOM courant ou accumulation après défilement).
 * @returns {number | null}
 */
function parseMaxActivityDetails(req) {
  const raw = singleQueryParam(req.query.maxDetails);
  const fromQuery = raw != null && raw !== "" ? parseInt(raw, 10) : NaN;
  const fromEnv = parseInt(process.env.GARMIN_MAX_ACTIVITY_DETAILS ?? "", 10);
  if (Number.isFinite(fromQuery) && fromQuery > 0) {
    return Math.min(Math.max(fromQuery, 1), 1000);
  }
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.min(Math.max(fromEnv, 1), 1000);
  }
  return null;
}

/** @param {{ id: string, title: string }[]} ids @param {number | null} maxDetails */
function sliceIdsForActivityDetails(ids, maxDetails) {
  if (maxDetails == null) return ids;
  return ids.slice(0, Math.min(maxDetails, ids.length));
}

function sanitizeActivityNameForFilename(title) {
  let s = String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[/\\?*:|"<>#%&{}~[\]`!@$+=]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (s.length > 120) s = s.slice(0, 120).replace(/-+$/g, "");
  if (!s) return "sans-nom";
  return s;
}

/** Nom de fichier : `activity-{id}-{nomSanitisé}.fit` */
function fitFilenameForActivity(id, title) {
  const part = sanitizeActivityNameForFilename(title);
  let name = `activity-${id}-${part}.fit`;
  name = name.replace(/[/\\?*:|"<>]/g, "_");
  const max = 220;
  if (name.length > max) {
    const keep = max - `.fit`.length - `activity-${id}-`.length;
    const cut = Math.max(8, keep);
    name = `activity-${id}-${part.slice(0, cut)}.fit`.replace(/[/\\?*:|"<>]/g, "_");
  }
  return name;
}

/**
 * Indique si un fichier .fit pour cette activité est déjà dans `public/fit/bike/`.
 * Convention : nom commence par `activity-{id}` (ex. `activity-22501915684.fit`), sans confondre avec un id plus long.
 */
async function garminActivityFitExistsOnDisk(id) {
  const prefix = `activity-${id}`;
  let entries;
  try {
    entries = await fs.readdir(GARMIN_BIKE_EXPORT_DIR);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (name === ".gitkeep") continue;
    const lower = name.toLowerCase();
    if (!lower.endsWith(".fit")) continue;
    if (!lower.startsWith(prefix.toLowerCase())) continue;
    const after = name.slice(prefix.length);
    if (after.length > 0 && /^\d/.test(after)) continue;
    try {
      const st = await fs.stat(path.join(GARMIN_BIKE_EXPORT_DIR, name));
      if (st.isFile()) return true;
    } catch {
      /* fichier supprimé entre-temps */
    }
  }
  return false;
}

/**
 * Bouton « … » / Plus de la fiche activité (pas celui de « Confidentialité » : deux Toggle Menu sur la page).
 */
async function locatorActivityExportMenuToggle(page) {
  const plusFr = page.getByTitle("Plus...").getByRole("button", { name: /Toggle Menu/i });
  if ((await plusFr.count()) === 1) return plusFr;
  const plusEn = page.getByTitle("More...").getByRole("button", { name: /Toggle Menu/i });
  if ((await plusEn.count()) === 1) return plusEn;
  const all = page.locator('button[aria-label="Toggle Menu"][class*="Menu_menuBtn__"]');
  const n = await all.count();
  if (n >= 2) return all.nth(1);
  if (n === 1) return all.first();
  return all.last();
}

/**
 * Menu activité : ouvre le bouton « Toggle Menu » du bloc **Plus…**, puis « Exporter le fichier » et enregistre le .fit.
 */
async function tryExportGarminActivityFitFile(page, id, title, log) {
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(250);
  try {
    const toggle = await locatorActivityExportMenuToggle(page);
    await toggle.click({ timeout: 25_000 });

    const exportItem = page
      .locator('div[class*="Menu_menuItems__"]')
      .filter({ hasText: "Exporter le fichier" })
      .filter({ visible: true })
      .first();
    await exportItem.waitFor({ state: "visible", timeout: 15_000 });

    const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
    await exportItem.click();
    const download = await downloadPromise;

    const suggested = (download.suggestedFilename() || "").trim();
    const lower = suggested.toLowerCase();
    const ext = lower.endsWith(".fit") ? ".fit" : lower.endsWith(".zip") ? ".zip" : path.extname(lower) || "";
    const baseNameNoExt = fitFilenameForActivity(id, title).replace(/\.fit$/i, "");
    const safeSuggested = suggested.replace(/[/\\?*:|"<>]/g, "_");
    const finalName = ext ? `${baseNameNoExt}${ext}` : safeSuggested || `${baseNameNoExt}.bin`;

    const outPath = path.join(GARMIN_BIKE_EXPORT_DIR, finalName);
    await download.saveAs(outPath);

    const buf = await fs.readFile(outPath);
    const head = buf.subarray(0, 16);
    const isFit = head.length >= 12 && head[8] === 0x2e && head[9] === 0x46 && head[10] === 0x49 && head[11] === 0x54;
    const isZip = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b; // PK

    if (isFit) {
      log(`  id=${id}: FIT → ${outPath} (${buf.length} octets)`);
      return;
    }

    if (isZip) {
      // Essayons d'extraire le premier .fit du zip.
      const zipPath = outPath;
      const targetFitName = `${baseNameNoExt}.fit`;
      const targetFitPath = path.join(GARMIN_BIKE_EXPORT_DIR, targetFitName);
      try {
        log(`  id=${id}: ZIP téléchargé (${zipPath}) — tentative d'extraction .fit…`);
        if (process.platform === "win32") {
          // Expand-Archive puis prise du premier *.fit
          const tmpDir = path.join(GARMIN_BIKE_EXPORT_DIR, `.__zip_${id}_${Date.now()}`);
          await fs.mkdir(tmpDir, { recursive: true });
          await execFile("powershell", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${tmpDir}" -Force`,
          ]);
          // Cherche récursivement (les archives Garmin ont parfois un sous-dossier).
          const { stdout } = await execFile("powershell", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Get-ChildItem -LiteralPath "${tmpDir}" -Recurse -File | Where-Object { $_.Name -match '\\.fit$' } | Select-Object -First 1 -ExpandProperty FullName`,
          ]);
          const fitFull = String(stdout || "").trim();
          if (!fitFull) throw new Error("aucun .fit dans l'archive");
          await fs.rename(fitFull, targetFitPath);
          await fs.rm(tmpDir, { recursive: true, force: true });
        } else {
          // Extraction via python3 (évite dépendance à `unzip` selon l'environnement).
          await execFile("python3", [
            "-c",
            [
              "import sys, zipfile",
              "zip_path, out_path = sys.argv[1], sys.argv[2]",
              "with zipfile.ZipFile(zip_path, 'r') as z:",
              "  names = z.namelist()",
              "  fit = next((n for n in names if n.lower().endswith('.fit')), None)",
              "  if not fit: raise SystemExit('no_fit_entry')",
              "  with z.open(fit) as src, open(out_path, 'wb') as dst:",
              "    dst.write(src.read())",
            ].join("\n"),
            zipPath,
            targetFitPath,
          ]);
        }
        const fitBuf = await fs.readFile(targetFitPath);
        const fitHead = fitBuf.subarray(0, 16);
        const ok = fitHead.length >= 12 && fitHead[8] === 0x2e && fitHead[9] === 0x46 && fitHead[10] === 0x49 && fitHead[11] === 0x54;
        if (fitBuf.length === 0) throw new Error("extraction a produit un fichier 0 octet");
        if (!ok) throw new Error("extraction terminée mais signature .FIT absente");
        log(`  id=${id}: ZIP → FIT → ${targetFitPath} (${fitBuf.length} octets)`);
        await fs.rm(zipPath, { force: true }).catch(() => {});
        return;
      } catch (e) {
        const hx = Array.from(head).map((x) => x.toString(16).padStart(2, "0")).join(" ");
        log(`  id=${id}: export ZIP non exploitable — ${String(e?.message ?? e)} (zip=${zipPath}, head=${hx})`);
        return;
      }
    }

    const hx = Array.from(head).map((x) => x.toString(16).padStart(2, "0")).join(" ");
    log(`  id=${id}: téléchargement non FIT (ext=${ext || "?"}) — gardé tel quel: ${outPath} (head=${hx})`);
  } catch (e) {
    log(`  id=${id}: export FIT — ${String(e?.message ?? e)}`);
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(150);
  }
}

/**
 * Pour chaque id : ouvre `https://connect.garmin.com/app/activity/{id}`, attend la barre d’actions (menu Plus…),
 * puis exporte le .fit si demandé.
 */
async function exportGarminActivityFitForIds(page, ids, maxDetails, log, options = {}) {
  const { exportFit = true } = options;
  await fs.mkdir(GARMIN_BIKE_EXPORT_DIR, { recursive: true });
  const slice = sliceIdsForActivityDetails(ids, maxDetails);
  const rows =
    exportFit === true
      ? await Promise.all(
          slice.map(async ({ id, title }) => ({
            id,
            title,
            fitOnDisk: await garminActivityFitExistsOnDisk(id),
          }))
        )
      : slice.map(({ id, title }) => ({ id, title, fitOnDisk: false }));
  const nSkip = exportFit ? rows.filter((r) => r.fitOnDisk).length : 0;
  const limitIntro =
    maxDetails == null
      ? `toute la liste collectée sur la page (${slice.length} id(s))`
      : `plafond maxDetails=${maxDetails} (${slice.length} id(s))`;
  log(
    `--- Détail activité${exportFit ? " + export FIT" : ""} (${limitIntro}${exportFit && nSkip > 0 ? `, dont ${nSkip} .fit déjà sur disque → aucune ouverture de fiche` : ""}) ---`
  );
  for (const { id, title, fitOnDisk } of rows) {
    if (exportFit && fitOnDisk) {
      log(
        `  id=${id}: .fit déjà sous public/fit/bike/ — pas d’ouverture de la page activité (pas de goto).`
      );
      continue;
    }
    const actUrl = `https://connect.garmin.com/app/activity/${id}`;
    log(`goto: ${actUrl} — ${title.slice(0, 70)}`);
    await page.goto(actUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
    const toggle = await locatorActivityExportMenuToggle(page);
    try {
      await toggle.waitFor({ state: "visible", timeout: 90_000 });
    } catch {
      log(`  id=${id}: menu d’actions (Plus…) pas visible en 90s — export .fit peut échouer.`);
    }
    if (exportFit) {
      await tryExportGarminActivityFitFile(page, id, title, log);
    } else {
      log(`  id=${id}: export .fit désactivé (?fit=0).`);
    }
  }
  log(
    `--- Fin détails : ${slice.length} activité(s) traitée(s)${
      maxDetails == null ? "" : ` (plafond maxDetails=${maxDetails})`
    }, ${ids.length} id(s) collecté(s) sur la liste — fichiers sous public/fit/bike/ ---`
  );
}

const app = express();

/** Évite deux lancements Playwright sur le même user-data-dir (erreur « existing browser session »). */
let garminLoginInProgress = false;
/** Évite connexion + étape Playwright UI en parallèle sur le même profil. */
let garminPlaywrightStep1InProgress = false;

/** CORS minimal pour l’UI locale (Vite) → API locale. */
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/garmin/")) return next();
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

/** État du login lancé en arrière-plan (piloté par le front). */
let garminLoginJob = {
  state: "idle",
  startedAt: 0,
  finishedAt: 0,
  message: "",
  error: "",
};

async function runGarminLoginBackground() {
  garminLoginJob = {
    state: "running",
    startedAt: Date.now(),
    finishedAt: 0,
    message: "Ouverture du navigateur…",
    error: "",
  };

  garminLoginInProgress = true;
  let context = null;
  try {
    context = await launchGarminBrowserContext();
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();

    const loginUrl =
      "https://sso.garmin.com/portal/sso/en-US/sign-in?clientId=GarminConnect&service=https%3A%2F%2Fconnect.garmin.com%2Fapp";
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

    garminLoginJob.message = "Fenêtre ouverte : connecte-toi sur Garmin (et valide 2FA si demandé).";

    const deadline = Date.now() + 10 * 60_000;
    let lastErr = null;
    while (Date.now() < deadline) {
      const cookies = await context.cookies();
      const pageUrl = page.url();
      try {
        await listActivities(cookies, {});
        await saveGarminSessionFromContext(context);
        await context.close();
        context = null;
        garminLoginJob = {
          state: "success",
          startedAt: garminLoginJob.startedAt,
          finishedAt: Date.now(),
          message: "Connexion confirmée : session enregistrée.",
          error: "",
        };
        return;
      } catch (e) {
        lastErr = e;
        if (isGarminConnectAppUrl(pageUrl) && hasLikelyGarminConnectAuth(cookies)) {
          try {
            await saveGarminSessionFromContext(context);
            await context.close();
            context = null;
            garminLoginJob = {
              state: "success",
              startedAt: garminLoginJob.startedAt,
              finishedAt: Date.now(),
              message: "Connexion probable : session enregistrée (API liste non confirmée).",
              error: "",
            };
            return;
          } catch (writeErr) {
            lastErr = writeErr;
          }
        }
        await sleep(2000);
      }
    }

    await context?.close().catch(() => {});
    context = null;
    garminLoginJob = {
      state: "timeout",
      startedAt: garminLoginJob.startedAt,
      finishedAt: Date.now(),
      message: "Timeout : connexion non confirmée.",
      error: String(lastErr?.message ?? lastErr ?? ""),
    };
  } catch (e) {
    await context?.close().catch(() => {});
    context = null;
    garminLoginJob = {
      state: "error",
      startedAt: garminLoginJob.startedAt || Date.now(),
      finishedAt: Date.now(),
      message: "Erreur pendant le login.",
      error: String(e?.message ?? e),
    };
  } finally {
    garminLoginInProgress = false;
  }
}

/** État de l'export FIT lancé en arrière-plan (piloté par le front). */
let garminExportJob = {
  state: "idle",
  startedAt: 0,
  finishedAt: 0,
  message: "",
  error: "",
  lines: /** @type {string[]} */ ([]),
};

function exportJobLog(s) {
  garminExportJob.message = s;
  garminExportJob.lines.push(s);
  // eslint-disable-next-line no-console
  console.log(`[garmin/export] ${s}`);
}

async function runGarminExportBackground(options = {}) {
  const targetUrl = options.targetUrl ?? GARMIN_ACTIVITIES_LIST_DEFAULT_URL;
  const runDetails = options.runDetails ?? true;
  const exportFit = options.exportFit ?? true;
  const maxDetails = options.maxDetails ?? null;
  const scrollUntilId = options.scrollUntilId ?? GARMIN_LIST_SCROLL_ANCHOR_ACTIVITY_ID_DEFAULT;

  garminExportJob = {
    state: "running",
    startedAt: Date.now(),
    finishedAt: 0,
    message: "Ouverture du navigateur…",
    error: "",
    lines: [],
  };

  garminPlaywrightStep1InProgress = true;
  let context = null;
  try {
    context = await launchGarminBrowserContext();
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();

    exportJobLog(`goto: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
    exportJobLog(`URL après chargement: ${page.url()}`);

    const scrollable = page.locator("#scrollableArea");
    await scrollable.waitFor({ state: "visible", timeout: 90_000 });
    exportJobLog(`#scrollableArea visible`);

    /** @type {{ id: string, title: string }[]} */
    let ids = [];
    if (runDetails && scrollUntilId) {
      exportJobLog(`Liste : défilement jusqu’à ${scrollUntilId} (accumulation ids)…`);
      ids = await accumulateGarminActivityIdsWhileScrollingUntil(scrollable, scrollUntilId, exportJobLog);
    } else if (runDetails) {
      ids = await collectGarminActivityIdsFromScrollable(scrollable);
    }

    exportJobLog(`IDs collectés: ${ids.length}`);

    if (runDetails && ids.length > 0) {
      await exportGarminActivityFitForIds(page, ids, maxDetails, exportJobLog, { exportFit });
    } else if (!runDetails) {
      exportJobLog("Mode détails: non — uniquement la liste.");
    } else {
      exportJobLog("Aucun id d’activité — rien à exporter.");
    }

    await context.close();
    context = null;
    garminExportJob = {
      ...garminExportJob,
      state: "success",
      finishedAt: Date.now(),
      message: "Export terminé.",
    };
  } catch (e) {
    await context?.close().catch(() => {});
    context = null;
    garminExportJob = {
      ...garminExportJob,
      state: "error",
      finishedAt: Date.now(),
      message: "Export en échec.",
      error: String(e?.message ?? e),
    };
  } finally {
    garminPlaywrightStep1InProgress = false;
  }
}

app.get("/", async (_req, res) => {
  const has = (await readSessionCookies())?.length;
  res.type("html").send(
    htmlPage(
      "Connecteur Garmin (local)",
      `<h1>Connecteur Garmin (local)</h1>
<p class="muted">Ce connecteur tourne en local. Il automatise un navigateur pour te laisser te connecter à Garmin Connect, puis lit la liste d’activités du mois via des endpoints internes.</p>
<p class="muted">Filtre vélo virtuel (ex.) : <a href="/garmin/activities?activityType=cycling&amp;activitySubType=virtual_ride&amp;startDate=2026-01-01&amp;endDate=2026-08-01">cycling / virtual_ride</a> — mêmes paramètres que sur connect.garmin.com/app/activities.</p>
<p class="muted">Session locale: <code>${has ? "présente" : "absente"}</code> — cookies <code>${escapeHtml(SESSION_FILE)}</code> + storage Playwright <code>${escapeHtml(STORAGE_STATE_FILE)}</code> (reconnexion recommandée si tu vois encore des erreurs API).</p>
<p class="muted" style="font-size:.85rem">À utiliser si « Connexion déjà en cours » reste affiché ou si une fenêtre Chromium est bloquée.</p>`
    )
  );
});

app.get("/api/garmin/login/status", async (_req, res) => {
  res.json({
    ...garminLoginJob,
    inProgress: garminLoginInProgress,
  });
});

app.post("/api/garmin/login/start", async (_req, res) => {
  if (garminLoginInProgress || garminPlaywrightStep1InProgress) {
    res.status(409).json({ error: "busy", inProgress: true, job: garminLoginJob });
    return;
  }
  // Fire & forget : le front poll /status.
  void runGarminLoginBackground();
  res.json({ started: true });
});

app.get("/api/garmin/export/status", async (_req, res) => {
  res.json({
    ...garminExportJob,
    inProgress: garminPlaywrightStep1InProgress,
  });
});

app.post("/api/garmin/export/start", async (_req, res) => {
  if (garminLoginInProgress || garminPlaywrightStep1InProgress) {
    res.status(409).json({ error: "busy", inProgress: true, export: garminExportJob, login: garminLoginJob });
    return;
  }
  void runGarminExportBackground();
  res.json({ started: true });
});

app.get("/api/garmin/fit/bike/list", async (_req, res) => {
  try {
    await fs.mkdir(GARMIN_BIKE_EXPORT_DIR, { recursive: true });
    const entries = await fs.readdir(GARMIN_BIKE_EXPORT_DIR, { withFileTypes: true });
    const files = [];
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (ent.name === ".gitkeep") continue;
      if (!ent.name.toLowerCase().endsWith(".fit")) continue;
      try {
        const st = await fs.stat(path.join(GARMIN_BIKE_EXPORT_DIR, ent.name));
        files.push({ name: ent.name, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* ignore */
      }
    }
    files.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
    res.json({ dir: GARMIN_BIKE_EXPORT_DIR, files });
  } catch (e) {
    res.status(500).json({ error: "list_failed", message: String(e?.message ?? e) });
  }
});

/**
 * Tue les processus dont la ligne de commande contient le user-data-dir Garmin,
 * supprime les fichiers Singleton*, enlève la session API et déverrouille le flux login.
 * ?wipeProfile=1 : supprime aussi tout le dossier profil Chromium.
 */
app.get("/garmin/hard-reset", async (req, res) => {
  const wipeProfile = singleQueryParam(req.query.wipeProfile) === "1";
  const profileDir = getGarminUserDataDir();
  const lines = [];

  garminLoginInProgress = false;
  garminPlaywrightStep1InProgress = false;
  lines.push("Verrous « connexion en cours » / « étape Playwright 1 » réinitialisés.");

  try {
    await killProcessesUsingGarminProfileDir(profileDir);
    lines.push("Recherche / arrêt des processus Chromium utilisant ce profil terminée.");
  } catch (e) {
    lines.push(`Arrêt navigateurs : ${String(e?.message ?? e)}`);
  }

  await sleep(500);
  try {
    await removeChromiumSingletonFiles(profileDir);
    lines.push("Fichiers SingletonLock / Socket / Cookie supprimés si présents.");
  } catch (e) {
    lines.push(`Verrous : ${String(e?.message ?? e)}`);
  }

  try {
    await fs.rm(SESSION_FILE, { force: true });
    lines.push("Session API locale supprimée (.garmin-session.json).");
  } catch (e) {
    lines.push(`Session : ${String(e?.message ?? e)}`);
  }
  try {
    await fs.rm(STORAGE_STATE_FILE, { force: true });
    lines.push("Fichier storageState Playwright supprimé (.garmin-playwright-storage.json).");
  } catch (e) {
    lines.push(`storageState : ${String(e?.message ?? e)}`);
  }
  try {
    await fs.mkdir(GARMIN_BIKE_EXPORT_DIR, { recursive: true });
    const entries = await fs.readdir(GARMIN_BIKE_EXPORT_DIR, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name === ".gitkeep") continue;
      await fs.rm(path.join(GARMIN_BIKE_EXPORT_DIR, ent.name), { recursive: true, force: true });
    }
    lines.push("Fichiers dans public/fit/bike/ supprimés (.gitkeep conservé).");
  } catch (e) {
    lines.push(`public/fit/bike : ${String(e?.message ?? e)}`);
  }

  if (wipeProfile) {
    try {
      await fs.rm(profileDir, { recursive: true, force: true });
      lines.push("Dossier profil Chromium entier supprimé.");
    } catch (e) {
      lines.push(`Profil : ${String(e?.message ?? e)}`);
    }
  }

  const list = lines.map((t) => `<li>${escapeHtml(t)}</li>`).join("");
  res.type("html").send(
    htmlPage(
      "Garmin — réinitialisation",
      `<h1>Réinitialisation terminée</h1>
<ul>${list}</ul>
<p class="muted">Profil Chromium utilisé par le connecteur : <code>${escapeHtml(profileDir)}</code>${
        wipeProfile ? " (dossier supprimé ci-dessus si l’étape a réussi)." : " (conservé ; utilise « Hard reset + profil » sur l’accueil pour tout effacer)."
      }</p>`
    )
  );
});

app.get("/garmin/login", async (_req, res) => {
  // Login assisté: on ouvre un vrai navigateur (headed) pour que l’utilisateur se connecte lui-même.
  // À la fin, on sauvegarde les cookies nécessaires.
  //
  // IMPORTANT: utiliser le Chrome installé + un profil persistant réduit fortement les 403 anti-bot
  // sur le SSO Garmin (le Chromium Playwright “nu” est souvent bloqué).
  if (garminLoginInProgress || garminPlaywrightStep1InProgress) {
    res
      .status(409)
      .type("html")
      .send(
        htmlPage(
          "Connexion Garmin — occupé",
          `<h1>Connexion déjà en cours</h1>
<p class="muted">Une fenêtre de connexion Garmin ou une étape Playwright (liste activités) est déjà en cours. Ferme-la ou attends la fin du flux avant de réessayer.</p>
<p class="muted">Utilise le front (Vite) pour relancer les actions, ou appelle directement les endpoints si besoin.</p>`
        )
      );
    return;
  }

  garminLoginInProgress = true;
  let context = null;
  try {
    context = await launchGarminBrowserContext();
  } catch (e) {
    garminLoginInProgress = false;
    res
      .status(503)
      .type("html")
      .send(
        htmlPage(
          "Connexion Garmin — navigateur",
          `<h1>Impossible d’ouvrir le navigateur</h1>
<pre class="muted" style="white-space:pre-wrap;font-size:.85rem">${escapeHtml(
            formatGarminBrowserLaunchError(e)
          )}</pre>
<p class="muted">Relance l’action depuis le front.</p>`
        )
      );
    return;
  }

  try {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();

    const loginUrl =
      "https://sso.garmin.com/portal/sso/en-US/sign-in?clientId=GarminConnect&service=https%3A%2F%2Fconnect.garmin.com%2Fapp";
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

    const deadline = Date.now() + 10 * 60_000;
    let lastErr = null;
    while (Date.now() < deadline) {
      const cookies = await context.cookies();
      const pageUrl = page.url();
      try {
        await listActivities(cookies, {});
        await saveGarminSessionFromContext(context);
        await context.close();
        context = null;
        res.redirect("/garmin/activities");
        return;
      } catch (e) {
        lastErr = e;
        // L’API liste peut échouer alors que le navigateur est bien connecté : on enregistre quand même les cookies.
        if (isGarminConnectAppUrl(pageUrl) && hasLikelyGarminConnectAuth(cookies)) {
          try {
            await saveGarminSessionFromContext(context);
            await context.close();
            context = null;
            res.redirect("/garmin/activities");
            return;
          } catch (writeErr) {
            lastErr = writeErr;
          }
        }
        await sleep(2000);
      }
    }

    await context.close().catch(() => {});
    context = null;
    res
      .status(504)
      .type("html")
      .send(
        htmlPage(
          "Connexion Garmin — timeout",
          `<h1>Connexion Garmin — timeout</h1>
<p class="muted">La connexion n’a pas été confirmée (API toujours inaccessible).</p>
<p class="muted">${escapeHtml(String(lastErr?.message ?? lastErr ?? ""))}</p>
<p class="muted">Relance l’action depuis le front.</p>`
        )
      );
  } catch (e) {
    await context?.close().catch(() => {});
    context = null;
    if (!res.headersSent) {
      res
        .status(500)
        .type("html")
        .send(
          htmlPage(
            "Connexion Garmin — erreur",
            `<h1>Erreur pendant la connexion</h1>
<p class="muted">${escapeHtml(String(e?.message ?? e))}</p>
<p class="muted">Relance l’action depuis le front.</p>`
          )
        );
    }
  } finally {
    garminLoginInProgress = false;
  }
});

/**
 * Playwright — liste + détails :
 * - ouvre la page liste (profil déjà connecté),
 * - attend <code>#scrollableArea</code>, résume les lignes,
 * - pour chaque id d’activité : <code>https://connect.garmin.com/app/activity/{id}</code>, exporte les .fit dans <code>public/fit/bike/</code>.
 *
 * Query : <code>?url=</code> (doit commencer par <code>https://connect.garmin.com/</code>),
 * <code>?maxDetails=20</code> (1–1000, optionnel) pour plafonner ; sans query ni <code>GARMIN_MAX_ACTIVITY_DETAILS</code>, on traite <strong>tous</strong> les ids de la liste DOM (même périmètre que le résumé des lignes).
 * Défilement virtualisé : par défaut on accumule les ids en scrollant jusqu’à voir l’activité <code>21441722196</code> (<code>?scrollUntil=</code> / <code>?untilActivity=</code> ou <code>GARMIN_LIST_SCROLL_UNTIL_ACTIVITY_ID</code>, <code>scrollUntil=0</code> pour désactiver).
 * <code>?details=0</code> pour ne faire que la liste (pas de navigation par activité),
 * <code>?fit=0</code> pour ne pas télécharger les fichiers .fit (menu « Toggle Menu » → « Exporter le fichier »).
 * Si un <code>.fit</code> existe déjà pour l’id (<code>activity-{id}*.fit</code> sous <code>public/fit/bike/</code>), l’activité est ignorée (pas de <code>goto</code>).
 */
app.get("/garmin/playwright/step1-activities", async (req, res) => {
  const customUrl = singleQueryParam(req.query.url);
  const targetUrl =
    customUrl && customUrl.startsWith("https://connect.garmin.com/") ? customUrl : GARMIN_ACTIVITIES_LIST_DEFAULT_URL;
  const runDetails = singleQueryParam(req.query.details) !== "0";
  const maxDetails = parseMaxActivityDetails(req);
  const exportFit = singleQueryParam(req.query.fit) !== "0";
  const scrollUntilId = parseScrollUntilActivityId(req);

  if (garminLoginInProgress || garminPlaywrightStep1InProgress) {
    res
      .status(409)
      .type("html")
      .send(
        htmlPage(
          "Playwright — occupé",
          `<h1>Navigateur déjà utilisé</h1>
<p class="muted">Termine la connexion Garmin ou une autre étape Playwright avant de relancer l’étape 1.</p>
<p class="muted">Relance l’action depuis le front.</p>`
        )
      );
    return;
  }

  garminPlaywrightStep1InProgress = true;
  let context = null;
  const lines = [];
  const log = (s) => {
    lines.push(s);
    // eslint-disable-next-line no-console
    console.log(`[garmin/playwright/step1] ${s}`);
  };

  try {
    context = await launchGarminBrowserContext();
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();

    log(`goto: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
    log(`URL après chargement: ${page.url()}`);

    const scrollable = page.locator("#scrollableArea");
    await scrollable.waitFor({ state: "visible", timeout: 90_000 });
    const cls = (await scrollable.getAttribute("class")) ?? "";
    const childCount = await scrollable.locator(":scope > *").count();
    log(`#scrollableArea visible — class="${cls}" — enfants directs: ${childCount}`);

    if (!cls.includes(ACTIVITY_LIST_SCROLLABLE_CLASS_PREFIX)) {
      log(
        `Avertissement: la classe ne contient pas le préfixe attendu "${ACTIVITY_LIST_SCROLLABLE_CLASS_PREFIX}" (build Garmin différent ?).`
      );
    }

    /** @type {{ id: string, title: string }[]} */
    let ids = [];
    if (runDetails && scrollUntilId) {
      log(
        `Liste : défilement de #scrollableArea jusqu’à l’activité ${scrollUntilId} (accumulation des ids rencontrés). ?scrollUntil=0 pour désactiver.`
      );
      ids = await accumulateGarminActivityIdsWhileScrollingUntil(scrollable, scrollUntilId, log);
      await logGarminActivityListItemSummaries(scrollable, log);
    } else {
      await logGarminActivityListItemSummaries(scrollable, log);
      if (runDetails) {
        ids = await collectGarminActivityIdsFromScrollable(scrollable);
      }
    }

    if (runDetails) {
      log(
        `Mode détails: oui — ${
          maxDetails == null
            ? "sans plafond : toutes les activités de la liste DOM seront considérées."
            : `plafond explicite maxDetails=${maxDetails} activité(s).`
        } Export .fit: ${exportFit ? "oui (?fit=0 pour désactiver)" : "non"}.`
      );
      log(`IDs collectés: ${ids.length}`);
      if (typeof maxDetails === "number" && ids.length > maxDetails) {
        log(
          `Plafond maxDetails=${maxDetails} : ${ids.length - maxDetails} activité(s) en fin de liste ne seront pas traitées. Retire ?maxDetails= et GARMIN_MAX_ACTIVITY_DETAILS pour tout traiter.`
        );
      }
      if (ids.length === 0) {
        log("Aucun id d’activité — pas de navigation vers les pages détail.");
      } else {
        await exportGarminActivityFitForIds(page, ids, maxDetails, log, { exportFit });
      }
    } else {
      log("Mode détails: non (?details=0) — uniquement la liste.");
    }

    await context.close();
    context = null;

    const pre = escapeHtml(lines.join("\n"));
    res.type("html").send(
      htmlPage(
        "Playwright — liste + détails",
        `<h1>Liste d’activités + export .fit</h1>
<p class="muted">La zone <code>#scrollableArea</code> a été analysée${
          runDetails
            ? ` ; les fichiers .fit sont sous <code>${escapeHtml(GARMIN_BIKE_EXPORT_DIR)}</code> (${
                maxDetails == null
                  ? "toute la liste DOM collectée"
                  : `au plus <code>${maxDetails}</code> activité(s)`
              }${exportFit ? ", export si le menu le permet" : ", sans export .fit"}).`
            : "."
        } Connecte-toi via <a href="/garmin/login">Se connecter</a> si besoin.</p>
<p class="muted">Raccourcis : <a href="/garmin/playwright/step1-activities?details=0">liste seule</a> · <a href="/garmin/playwright/step1-activities?maxDetails=3">3 détails</a> · <a href="/garmin/playwright/step1-activities?fit=0">sans .fit</a> · <a href="/garmin/playwright/step1-activities?scrollUntil=0">sans défilement liste</a></p>
<pre style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:1rem;font-size:.8rem;white-space:pre-wrap;word-break:break-word;max-height:70vh;overflow:auto">${pre}</pre>`
      )
    );
  } catch (e) {
    await context?.close().catch(() => {});
    context = null;
    log(`Erreur: ${String(e?.message ?? e)}`);
    const pre = escapeHtml(lines.join("\n"));
    res
      .status(500)
      .type("html")
      .send(
        htmlPage(
          "Playwright — étape 1 échec",
          `<h1>Étape 1 — échec</h1>
<p class="muted">Souvent : session absente (redirige vers SSO). Utilise <a href="/garmin/login">Se connecter à Garmin</a> puis réessaie.</p>
<pre style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:1rem;font-size:.8rem;white-space:pre-wrap;word-break:break-word;max-height:70vh;overflow:auto">${pre}</pre>`
        )
      );
  } finally {
    garminPlaywrightStep1InProgress = false;
  }
});

app.get("/garmin/logout", async (_req, res) => {
  await fs.rm(SESSION_FILE, { force: true });
  res.redirect("/");
});

app.get("/garmin/activities", async (req, res) => {
  const cookies = await readSessionCookies();
  if (!cookies || cookies.length === 0) {
    res.type("html").send(
      htmlPage(
        "Activités Garmin",
        `<h1>Activités Garmin — ce mois-ci</h1>
<p>Aucune session locale Garmin n’est disponible.</p>
<p class="muted">Le fichier attendu est <code>${escapeHtml(SESSION_FILE)}</code> (toujours à la racine du dépôt XTriAscend, pas selon le shell d’où tu lances <code>node</code>).</p>
<p class="muted">Connecte-toi via le front, puis réessaie.</p>`
      )
    );
    return;
  }

  const aq = activitySearchQueryFromRequest(req.query);
  const lines = await logGarminActivityRequests(cookies, aq);
  const pre = escapeHtml(lines.join("\n"));

  res.type("html").send(
    htmlPage(
      "Activités Garmin — logs",
      `<h1>Activités Garmin — diagnostic (logs)</h1>
<p class="muted">Les mêmes lignes sont écrites dans le <strong>terminal</strong> où tourne <code>npm run garmin:server</code> (préfixe <code>[garmin/activities]</code>).</p>
<pre style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:1rem;font-size:.8rem;white-space:pre-wrap;word-break:break-word;max-height:70vh;overflow:auto">${pre}</pre>`
    )
  );
});

app.get("/api/garmin/activities/month", async (req, res) => {
  const cookies = await readSessionCookies();
  if (!cookies || cookies.length === 0) {
    res.status(401).json({ error: "not_authenticated" });
    return;
  }
  try {
    const aq = activitySearchQueryFromRequest(req.query);
    const data = await listActivities(cookies, aq);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: "garmin_fetch_failed", message: String(e?.message ?? e) });
  }
});

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Garmin local connector: http://${HOST}:${PORT}`);
});

