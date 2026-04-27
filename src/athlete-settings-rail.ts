import {
  getFtp,
  getRaceStartTimeHHMM,
  getTotalMassKg,
  getVmaCapKmh,
  setFtp,
  setRaceStartTimeHHMM,
  setTotalMassKg,
  setVmaCapKmh,
} from "./athlete-settings";

export const ATHLETE_SETTINGS_CHANGED = "xtriascend-athlete-settings";

export type AthleteSettingsChangedKey = "ftp" | "vma" | "mass" | "raceStart";

type AthleteSettingsDetail = { key: AthleteSettingsChangedKey };

export function mountAthleteSettingsRail(): void {
  const root = document.getElementById("athlete-settings-rail");
  if (!root) return;

  const ftpInput = root.querySelector<HTMLInputElement>("#ftp-rail-input");
  const vmaInput = root.querySelector<HTMLInputElement>("#vma-cap-rail-input");
  const massInput = root.querySelector<HTMLInputElement>("#mass-rail-input");
  const raceStartInput = root.querySelector<HTMLInputElement>("#race-start-rail-input");

  if (ftpInput) {
    ftpInput.value = String(getFtp());
    const commitFtp = () => {
      const val = parseInt(ftpInput.value, 10);
      if (Number.isFinite(val) && val >= 50 && val <= 600) {
        setFtp(val);
        document.dispatchEvent(
          new CustomEvent<AthleteSettingsDetail>(ATHLETE_SETTINGS_CHANGED, { detail: { key: "ftp" } })
        );
      }
    };
    ftpInput.addEventListener("input", commitFtp);
    ftpInput.addEventListener("change", commitFtp);
  }

  if (vmaInput) {
    vmaInput.value = String(getVmaCapKmh());
    vmaInput.addEventListener("change", () => {
      const val = parseFloat(vmaInput.value.replace(",", "."));
      if (Number.isFinite(val) && val >= 8 && val <= 30) {
        setVmaCapKmh(val);
        document.dispatchEvent(
          new CustomEvent<AthleteSettingsDetail>(ATHLETE_SETTINGS_CHANGED, { detail: { key: "vma" } })
        );
      }
    });
  }

  if (massInput) {
    massInput.value = String(getTotalMassKg());
    const commitMass = () => {
      const val = parseFloat(massInput.value.replace(",", "."));
      if (Number.isFinite(val) && val >= 50 && val <= 150) {
        setTotalMassKg(val);
        document.dispatchEvent(
          new CustomEvent<AthleteSettingsDetail>(ATHLETE_SETTINGS_CHANGED, { detail: { key: "mass" } })
        );
      }
    };
    massInput.addEventListener("input", commitMass);
    massInput.addEventListener("change", commitMass);
  }

  if (raceStartInput) {
    raceStartInput.value = getRaceStartTimeHHMM();
    const commitRaceStart = () => {
      const v = raceStartInput.value;
      if (!v) return;
      const p = v.split(":");
      const h = parseInt(p[0], 10);
      const m = parseInt(p[1] ?? "0", 10);
      if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return;
      const norm = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      setRaceStartTimeHHMM(norm);
      if (raceStartInput.value !== norm) raceStartInput.value = norm;
      document.dispatchEvent(
        new CustomEvent<AthleteSettingsDetail>(ATHLETE_SETTINGS_CHANGED, { detail: { key: "raceStart" } })
      );
    };
    raceStartInput.addEventListener("input", commitRaceStart);
    raceStartInput.addEventListener("change", commitRaceStart);
  }
}

export function syncAthleteSettingsRailInputs(): void {
  const root = document.getElementById("athlete-settings-rail");
  const ftpInput = root?.querySelector<HTMLInputElement>("#ftp-rail-input");
  const vmaInput = root?.querySelector<HTMLInputElement>("#vma-cap-rail-input");
  const massInput = root?.querySelector<HTMLInputElement>("#mass-rail-input");
  const raceStartInput = root?.querySelector<HTMLInputElement>("#race-start-rail-input");
  if (ftpInput) ftpInput.value = String(getFtp());
  if (vmaInput) vmaInput.value = String(getVmaCapKmh());
  if (massInput) massInput.value = String(getTotalMassKg());
  if (raceStartInput) raceStartInput.value = getRaceStartTimeHHMM();
}