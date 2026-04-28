export function isStrictLocalhost(): boolean {
  // Mode strict demandé : uniquement localhost / 127.0.0.1.
  return window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
}

