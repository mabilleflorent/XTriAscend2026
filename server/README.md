# Connecteur Garmin (Option B) — local

Ce serveur est **local** (sur ton PC) et sert à :
- ouvrir un navigateur pour te laisser **te connecter** à Garmin Connect,
- sauvegarder une **session** : **`XTriAscend/.garmin-session.json`** (cookies) et **`XTriAscend/.garmin-playwright-storage.json`** (storageState Playwright pour les appels API hors navigateur — évite souvent les 403/HTML),
- afficher la **liste des activités du mois**.

⚠️ Cette intégration repose sur des endpoints **internes** Garmin Connect (non officiels) : ça peut casser et/ou être contraire aux CGU.

## Lancer

Dans WSL / Linux :

```bash
npm install
npx playwright install
npm run garmin:server
```

Puis ouvrir `http://127.0.0.1:8787`.

## Notes importantes (WSL)

- Le login utilise un navigateur **graphique** (headed). Sous WSL2, il faut généralement **WSLg** (ou un serveur X) pour voir la fenêtre.
- Pour réduire les **403** sur le SSO Garmin, le serveur tente d’abord **Chrome** puis **Edge** installés, puis **Chromium** Playwright, avec un **profil persistant** dans `.garmin-chromium-profile/`.
- Le **User-Agent** suit l’OS du process Node (Linux sous WSL, pas une chaîne Windows factice).
- Variables d’environnement utiles :
  - `GARMIN_BROWSER_CHANNEL=chrome` | `msedge` | `chromium` — canal préféré (les autres restent en repli).
  - `GARMIN_USER_AGENT=...` — forcer un UA précis si besoin.
  - `GARMIN_USER_DATA_DIR=/chemin/vers/profil` — autre dossier de profil Chromium (évite le conflit « Opening in existing browser session » si le profil par défaut est verrouillé).

### « Opening in existing browser session »

Un seul Chromium peut utiliser le dossier `.garmin-chromium-profile/` à la fois. **Ferme** la fenêtre restée ouverte, ou tue le processus (`pkill -f ".garmin-chromium-profile"`), ou définis `GARMIN_USER_DATA_DIR` vers un dossier vide. Ne lance pas deux fois « Se connecter » en parallèle (le serveur renvoie alors HTTP 409).

### Si tu vois encore `POST .../portal/api/login ... 403`

- Installe **Google Chrome** (ou Edge) **dans le même environnement** que celui qui lance `node` (souvent WSL : paquet `google-chrome-stable` ou navigateur visible via WSLg).
- Essaye : `GARMIN_BROWSER_CHANNEL=msedge npm run garmin:server` si tu utilises plutôt Edge.
- En dernier recours, lance le connecteur depuis **Windows** (Node + Chrome Windows) plutôt que depuis WSL : certains pare-feux / TLS / anti-bot se comportent différemment.

## Endpoints
- `/garmin/login` : lance le navigateur (headed) pour te connecter.
- `/garmin/playwright/step1-activities` : en mode détails, **défilement** de `#scrollableArea` jusqu’à voir une activité « ancrage » (défaut **21441722196**), en **accumulant** tous les ids vus sur le parcours (liste virtualisée). **`?scrollUntil=ID`** / **`?untilActivity=`** ou **`GARMIN_LIST_SCROLL_UNTIL_ACTIVITY_ID`** ; **`?scrollUntil=0`** désactive (une seule passe DOM). Si un `.fit` existe déjà (`activity-{id}…` sous **`public/fit/bike/`**), ignoré ; sinon export. **`?maxDetails=N`** / **`GARMIN_MAX_ACTIVITY_DETAILS`** pour plafonner. `?url=…`, `?details=0`, `?fit=0`. **Après** connexion dans ce profil.
- `/garmin/hard-reset` : déverrouille le flux « connexion en cours », tente de **tuer** les Chromium dont la ligne de commande contient le `user-data-dir`, supprime les **Singleton***, efface **`.garmin-session.json`**. Option `?wipeProfile=1` : supprime aussi tout le dossier **`.garmin-chromium-profile/`**.
- `/garmin/activities` : page HTML avec les activités (par défaut : **mois en cours**).
- `/api/garmin/activities/month` : JSON brut (si besoin pour l’UI).

### Filtres (même idée que l’URL `connect.garmin.com/app/activities?…`)

Query string optionnelle sur `/garmin/activities` et `/api/garmin/activities/month` :

- `startDate`, `endDate` (format `YYYY-MM-DD`)
- `activityType` (ex. `cycling`)
- `activitySubType` (ex. `virtual_ride`)
- `start`, `limit`, `sortOrder`

Exemple :  
`/garmin/activities?activityType=cycling&activitySubType=virtual_ride&startDate=2026-01-01&endDate=2026-08-01`

Les appels essaient d’abord **`https://connect.garmin.com/gc-api/activitylist-service/...`** (endpoint observé dans le Network du SPA), puis **`/modern/proxy/...`**, puis **`connectapi.garmin.com/...`**.

