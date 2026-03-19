export const DEFAULT_ACTIVE_HOURS = Object.freeze({
  endHour: 18,
  startHour: 7
});

function normalizeHourValue(value, fallback) {
  const hour = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return fallback;
  }
  return hour;
}

function normalizeSavedAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatHourLabel(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function normalizeActiveHours(value, fallback = DEFAULT_ACTIVE_HOURS) {
  const fallbackHours = {
    endHour: normalizeHourValue(fallback?.endHour, DEFAULT_ACTIVE_HOURS.endHour),
    startHour: normalizeHourValue(fallback?.startHour, DEFAULT_ACTIVE_HOURS.startHour)
  };
  const startHour = normalizeHourValue(value?.startHour, fallbackHours.startHour);
  const endHour = normalizeHourValue(value?.endHour, fallbackHours.endHour);

  if (endHour <= startHour) {
    return fallbackHours;
  }

  return {
    endHour,
    startHour
  };
}

export function activeHoursSummary(hours) {
  const normalized = normalizeActiveHours(hours);
  return `${formatHourLabel(normalized.startHour)} -> ${formatHourLabel(normalized.endHour)}`;
}

export function formatCacheAge(value, now = new Date()) {
  const savedAt = normalizeSavedAt(value);
  if (!savedAt) {
    return "Donnees en cache";
  }

  const elapsedMinutes = Math.max(0, Math.floor((now.getTime() - savedAt.getTime()) / 60_000));
  if (elapsedMinutes <= 0) {
    return "Donnees en cache · il y a moins d'1 min";
  }

  return `Donnees en cache · il y a ${elapsedMinutes} min`;
}

export function readPlanSnapshot(snapshotMap, expectedKey, {
  maxAgeMs,
  nowMs = Date.now()
} = {}) {
  if (!expectedKey || !snapshotMap || typeof snapshotMap !== "object") {
    return null;
  }

  const snapshot = snapshotMap[expectedKey];
  const savedAt = normalizeSavedAt(snapshot?.savedAt);
  if (
    !savedAt ||
    (Number.isFinite(maxAgeMs) && nowMs - savedAt.getTime() > maxAgeMs) ||
    !snapshot?.plan?.options?.length
  ) {
    return null;
  }

  return {
    plan: snapshot.plan,
    savedAt
  };
}

export function upsertPlanSnapshotMap(snapshotMap, snapshotKey, plan, savedAt = new Date().toISOString(), {
  maxAgeMs,
  nowMs = Date.now()
} = {}) {
  const existingMap = snapshotMap && typeof snapshotMap === "object" ? snapshotMap : {};
  if (!snapshotKey || !plan?.options?.length) {
    return existingMap;
  }

  const nextSnapshots = {
    [snapshotKey]: {
      plan,
      savedAt
    }
  };

  for (const key of Object.keys(existingMap)) {
    if (key === snapshotKey) {
      continue;
    }

    const existing = readPlanSnapshot(existingMap, key, {
      maxAgeMs,
      nowMs
    });
    if (existing) {
      nextSnapshots[key] = {
        plan: existing.plan,
        savedAt: existing.savedAt.toISOString()
      };
    }
  }

  return nextSnapshots;
}

export function getTramAlertAction({
  alertKey,
  audioEnabled,
  audioUnlocked,
  lastTramAlertKey,
  source
}) {
  const normalizedAlertKey = String(alertKey || "");
  const previousAlertKey = String(lastTramAlertKey || "");

  if (source !== "live") {
    return {
      nextAlertKey: previousAlertKey,
      shouldPlay: false
    };
  }

  if (!normalizedAlertKey) {
    return {
      nextAlertKey: "",
      shouldPlay: false
    };
  }

  if (!audioEnabled) {
    return {
      nextAlertKey: normalizedAlertKey,
      shouldPlay: false
    };
  }

  if (previousAlertKey === normalizedAlertKey || !audioUnlocked) {
    return {
      nextAlertKey: previousAlertKey,
      shouldPlay: false
    };
  }

  return {
    nextAlertKey: normalizedAlertKey,
    shouldPlay: true
  };
}
