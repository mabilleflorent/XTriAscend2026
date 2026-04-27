/// <reference types="vite/client" />
/// <reference path="./garmin-fitsdk.d.ts" />

interface ImportMetaEnv {
  /** URL du serveur Garmin local (ex. `http://127.0.0.1:8787`) — défaut si absent. */
  readonly VITE_GARMIN_SERVER_URL?: string;
}
