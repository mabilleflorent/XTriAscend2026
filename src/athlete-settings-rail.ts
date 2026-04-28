import {
  getFtp,
  getRaceStartTimeHHMM,
  getSwimPaceMMSSPer100m,
  getT1MMSS,
  getT2MMSS,
  getTotalMassKg,
  getVmaCapKmh,
  setFtp,
  setRaceStartTimeHHMM,
  setSwimPaceSecPer100m,
  setT1Sec,
  setT2Sec,
  setTotalMassKg,
  setVmaCapKmh,
} from "./athlete-settings";

export const ATHLETE_SETTINGS_CHANGED = "xtriascend-athlete-settings";

export type AthleteSettingsChangedKey = "ftp" | "vma" | "mass" | "raceStart" | "swim" | "t1" | "t2";

type AthleteSettingsDetail = { key: AthleteSettingsChangedKey };

export function mountAthleteSettingsRail(): void {
  const root = document.getElementById("athlete-settings-rail");
  if (!root) return;

  const ftpInput = root.querySelector<HTMLInputElement>("#ftp-rail-input");
  const vmaInput = root.querySelector<HTMLInputElement>("#vma-cap-rail-input");
  const massInput = root.querySelector<HTMLInputElement>("#mass-rail-input");
  const raceStartInput = root.querySelector<HTMLInputElement>("#race-start-rail-input");
  const swimPaceInput = root.querySelector<HTMLInputElement>("#swim-pace-rail-input");
  const t1Input = root.querySelector<HTMLInputElement>("#t1-rail-input");
  const t2Input = root.querySelector<HTMLInputElement>("#t2-rail-input");

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

  if (swimPaceInput) {
    swimPaceInput.value = getSwimPaceMMSSPer100m();
    const commitSwim = () => {
      const m = swimPaceInput.value.trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return;
      const mm = parseInt(m[1], 10);
      const ss = parseInt(m[2], 10);
      if (!Number.isFinite(mm) || !Number.isFinite(ss) || ss < 0 || ss > 59) return;
      const sec = mm * 60 + ss;
      if (sec < 30 || sec > 20 * 60) return;
      setSwimPaceSecPer100m(sec);
      document.dispatchEvent(new CustomEvent<AthleteSettingsDetail>(ATHLETE_SETTINGS_CHANGED, { detail: { key: "swim" } }));
    };
    swimPaceInput.addEventListener("input", commitSwim);
    swimPaceInput.addEventListener("change", commitSwim);
  }

  if (t1Input) {
    t1Input.value = getT1MMSS();
    const commitT1 = () => {
      const m = t1Input.value.trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return;
      const mm = parseInt(m[1], 10);
      const ss = parseInt(m[2], 10);
      if (!Number.isFinite(mm) || !Number.isFinite(ss) || ss < 0 || ss > 59) return;
      const sec = mm * 60 + ss;
      if (sec < 0 || sec > 59 * 60 + 59) return;
      setT1Sec(sec);
      document.dispatchEvent(new CustomEvent<AthleteSettingsDetail>(ATHLETE_SETTINGS_CHANGED, { detail: { key: "t1" } }));
    };
    t1Input.addEventListener("input", commitT1);
    t1Input.addEventListener("change", commitT1);
  }

  if (t2Input) {
    t2Input.value = getT2MMSS();
    const commitT2 = () => {
      const m = t2Input.value.trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return;
      const mm = parseInt(m[1], 10);
      const ss = parseInt(m[2], 10);
      if (!Number.isFinite(mm) || !Number.isFinite(ss) || ss < 0 || ss > 59) return;
      const sec = mm * 60 + ss;
      if (sec < 0 || sec > 59 * 60 + 59) return;
      setT2Sec(sec);
      document.dispatchEvent(new CustomEvent<AthleteSettingsDetail>(ATHLETE_SETTINGS_CHANGED, { detail: { key: "t2" } }));
    };
    t2Input.addEventListener("input", commitT2);
    t2Input.addEventListener("change", commitT2);
  }
}

export function syncAthleteSettingsRailInputs(): void {
  const root = document.getElementById("athlete-settings-rail");
  const ftpInput = root?.querySelector<HTMLInputElement>("#ftp-rail-input");
  const vmaInput = root?.querySelector<HTMLInputElement>("#vma-cap-rail-input");
  const massInput = root?.querySelector<HTMLInputElement>("#mass-rail-input");
  const raceStartInput = root?.querySelector<HTMLInputElement>("#race-start-rail-input");
  const swimPaceInput = root?.querySelector<HTMLInputElement>("#swim-pace-rail-input");
  const t1Input = root?.querySelector<HTMLInputElement>("#t1-rail-input");
  const t2Input = root?.querySelector<HTMLInputElement>("#t2-rail-input");
  if (ftpInput) ftpInput.value = String(getFtp());
  if (vmaInput) vmaInput.value = String(getVmaCapKmh());
  if (massInput) massInput.value = String(getTotalMassKg());
  if (raceStartInput) raceStartInput.value = getRaceStartTimeHHMM();
  if (swimPaceInput) swimPaceInput.value = getSwimPaceMMSSPer100m();
  if (t1Input) t1Input.value = getT1MMSS();
  if (t2Input) t2Input.value = getT2MMSS();
}