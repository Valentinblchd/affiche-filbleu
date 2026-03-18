import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { access, constants as fsConstants, readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ ||= "Europe/Paris";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const publicDir = join(__dirname, "public");
const scriptsDir = join(__dirname, "scripts");

const host = process.env.HOST || "127.0.0.1";
const preferredPort = Number.parseInt(process.env.PORT || "3173", 10);
const appDirectory = process.env.APP_DIR || __dirname;
const selfUpdateEnabled = process.env.SELF_UPDATE_ENABLED === "1";
const autoUpdateEnabled = selfUpdateEnabled && process.env.AUTO_UPDATE_ENABLED !== "0";
const autoUpdateIntervalMs = Math.max(
  60_000,
  Number.parseInt(process.env.AUTO_UPDATE_INTERVAL_MS || "300000", 10) || 300_000
);
const updateCheckScriptPath = process.env.UPDATE_CHECK_SCRIPT || join(scriptsDir, "check-update.sh");
const updateApplyScriptPath = process.env.UPDATE_APPLY_SCRIPT || join(scriptsDir, "apply-update.sh");

const upstreamBaseUrl = "https://filbleu.latitude-cartagene.com";
const itineraryParams = "departure,bus,tram,walking";
const busOnlyItineraryParams = "departure,bus,walking";
const tramOnlyItineraryParams = "departure,tram,walking";
const addressLookupBaseUrl = "https://api-adresse.data.gouv.fr/search/";
const addressReverseBaseUrl = "https://api-adresse.data.gouv.fr/reverse/";
const transferWindowMinutes = 3;
const maxMixedConnectionWaitMinutes = 15;
const estimatedTramMetersPerMinute = 300;
const initCacheTtlMs = 6 * 60 * 60 * 1000;
const disruptionCacheTtlMs = 2 * 60 * 1000;
const geocodeCacheTtlMs = 5 * 60 * 1000;
const liveScheduleCacheTtlMs = 30 * 1000;
const localGeocodeRadiusMeters = 30_000;
const nearestBusMaxDistanceMeters = 5_000;
const nearbyBusAreaLimit = 4;
const nearbyBusSourceMaxDistanceMeters = 1_200;
const busTramTransferAreaLimit = 8;
const nearestTramMaxDistanceMeters = 600;
const nearbyTramAreaLimit = 4;
const transferWalkMaxDistanceMeters = 250;
const transferCandidateAreaLimit = 14;
const timetableCacheTtlMs = 6 * 60 * 60 * 1000;
const updateStatusCacheTtlMs = 30 * 1000;
const staleJourneyGraceMinutes = 2;
const appTimeZone = "Europe/Paris";
const toursCenter = {
  lat: 47.3941,
  lon: 0.6848
};
const walkingMetersPerMinute = 75;

const initCache = {
  expiresAt: 0,
  value: null
};

const disruptionCache = {
  expiresAt: 0,
  value: null
};

const geocodeCache = new Map();
const scheduleCache = new Map();
const updateStatusCache = {
  expiresAt: 0,
  value: null
};
let updateInProgress = false;
let autoUpdateCheckInProgress = false;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const parisDateTimePartsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: appTimeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

const parisClockFormatter = new Intl.DateTimeFormat("fr-FR", {
  timeZone: appTimeZone,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

const parisOffsetFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: appTimeZone,
  timeZoneName: "shortOffset",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

function jsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function textResponse(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(body);
}

async function isExecutableFile(filePath) {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeUpdateStatusPayload(payload) {
  const enabled = Boolean(payload?.enabled);
  return {
    automatic: autoUpdateEnabled,
    branch: String(payload?.branch || ""),
    currentVersion: String(payload?.currentVersion || ""),
    enabled,
    error: String(payload?.error || ""),
    inProgress: updateInProgress,
    latestVersion: String(payload?.latestVersion || ""),
    updateAvailable: enabled && Boolean(payload?.updateAvailable)
  };
}

function runJsonScript(scriptPath, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(scriptPath, [], {
      cwd: appDirectory,
      env: {
        ...process.env,
        APP_DIR: appDirectory
      }
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finalize = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timerId);
      callback();
    };

    const timerId = setTimeout(() => {
      child.kill("SIGKILL");
      finalize(() => reject(new Error("La verification de mise a jour a expire.")));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      finalize(() => reject(error));
    });

    child.once("close", (code) => {
      finalize(() => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Le script a echoue avec le code ${code}.`));
          return;
        }

        const rawOutput = stdout.trim();
        if (!rawOutput) {
          resolve({});
          return;
        }

        try {
          resolve(JSON.parse(rawOutput));
        } catch {
          reject(new Error("La reponse du script de mise a jour est invalide."));
        }
      });
    });
  });
}

async function getUpdateStatus({ force = false } = {}) {
  if (!selfUpdateEnabled) {
    return normalizeUpdateStatusPayload({
      enabled: false
    });
  }

  const now = Date.now();
  if (!force && updateStatusCache.value && updateStatusCache.expiresAt > now) {
    return {
      ...updateStatusCache.value,
      inProgress: updateInProgress
    };
  }

  if (!(await isExecutableFile(updateCheckScriptPath))) {
    const fallback = normalizeUpdateStatusPayload({
      enabled: false,
      error: "Script de verification absent."
    });
    updateStatusCache.value = fallback;
    updateStatusCache.expiresAt = now + updateStatusCacheTtlMs;
    return fallback;
  }

  try {
    const payload = await runJsonScript(updateCheckScriptPath);
    const status = normalizeUpdateStatusPayload(payload);
    updateStatusCache.value = status;
    updateStatusCache.expiresAt = now + updateStatusCacheTtlMs;
    return status;
  } catch (error) {
    const fallback = normalizeUpdateStatusPayload({
      enabled: true,
      error: error instanceof Error ? error.message : "Verification indisponible."
    });
    updateStatusCache.value = fallback;
    updateStatusCache.expiresAt = now + updateStatusCacheTtlMs;
    return fallback;
  }
}

function triggerUpdateProcess() {
  updateInProgress = true;
  updateStatusCache.expiresAt = 0;

  const child = spawn(updateApplyScriptPath, [], {
    cwd: appDirectory,
    env: {
      ...process.env,
      APP_DIR: appDirectory
    },
    stdio: "ignore"
  });

  const finalize = () => {
    updateInProgress = false;
    updateStatusCache.expiresAt = 0;
  };

  child.once("error", finalize);
  child.once("close", finalize);
}

async function checkForAutomaticUpdates() {
  if (!autoUpdateEnabled || updateInProgress || autoUpdateCheckInProgress) {
    return;
  }

  autoUpdateCheckInProgress = true;
  try {
    const status = await getUpdateStatus({ force: true });
    if (!status.enabled || !status.updateAvailable || updateInProgress) {
      return;
    }

    if (!(await isExecutableFile(updateApplyScriptPath))) {
      return;
    }

    triggerUpdateProcess();
  } finally {
    autoUpdateCheckInProgress = false;
  }
}

function scheduleAutomaticUpdates() {
  if (!autoUpdateEnabled) {
    return;
  }

  setTimeout(() => {
    void checkForAutomaticUpdates();
  }, 15_000);

  setInterval(() => {
    void checkForAutomaticUpdates();
  }, autoUpdateIntervalMs);
}

function padNumber(value, size = 2) {
  return String(value).padStart(size, "0");
}

function formatterPartsToObject(formatter, date) {
  return formatter.formatToParts(date).reduce((result, part) => {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }
    return result;
  }, {});
}

function parisDateTimeParts(date) {
  const parts = formatterPartsToObject(parisDateTimePartsFormatter, date);
  return {
    day: Number.parseInt(parts.day || "0", 10),
    hour: Number.parseInt(parts.hour || "0", 10),
    minute: Number.parseInt(parts.minute || "0", 10),
    month: Number.parseInt(parts.month || "0", 10),
    second: Number.parseInt(parts.second || "0", 10),
    year: Number.parseInt(parts.year || "0", 10)
  };
}

function formatCompactDateParts(parts) {
  return `${padNumber(parts.year, 4)}${padNumber(parts.month)}${padNumber(parts.day)}`;
}

function shiftCalendarDate(parts, days) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return {
    day: shifted.getUTCDate(),
    month: shifted.getUTCMonth() + 1,
    year: shifted.getUTCFullYear()
  };
}

function timeZoneOffsetMinutesAt(utcMs) {
  const parts = formatterPartsToObject(parisOffsetFormatter, new Date(utcMs));
  const offsetLabel = String(parts.timeZoneName || "");
  const match = offsetLabel.match(/(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) {
    return 0;
  }

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number.parseInt(match[2] || "0", 10);
  const minutes = Number.parseInt(match[3] || "0", 10);
  return sign * (hours * 60 + minutes);
}

function parisWallTimeToDate({
  day,
  hour = 0,
  minute = 0,
  month,
  second = 0,
  year
}) {
  const wallTimeUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  let resolvedUtcMs = wallTimeUtcMs;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offsetMinutes = timeZoneOffsetMinutesAt(resolvedUtcMs);
    const nextUtcMs = wallTimeUtcMs - offsetMinutes * 60 * 1000;
    if (nextUtcMs === resolvedUtcMs) {
      break;
    }
    resolvedUtcMs = nextUtcMs;
  }

  return new Date(resolvedUtcMs);
}

function toLocalInputValue(date) {
  const parts = parisDateTimeParts(date);
  return `${padNumber(parts.year, 4)}-${padNumber(parts.month)}-${padNumber(parts.day)}T${padNumber(parts.hour)}:${padNumber(parts.minute)}`;
}

function compactDate(date) {
  return formatCompactDateParts(parisDateTimeParts(date));
}

function compactDateTime(date) {
  const parts = parisDateTimeParts(date);
  return `${formatCompactDateParts(parts)}T${padNumber(parts.hour)}${padNumber(parts.minute)}${padNumber(parts.second)}`;
}

function parseCompactDateTime(value) {
  if (!value || !/^\d{8}T\d{6}$/.test(value)) {
    return null;
  }

  const year = Number.parseInt(value.slice(0, 4), 10);
  const month = Number.parseInt(value.slice(4, 6), 10);
  const day = Number.parseInt(value.slice(6, 8), 10);
  const hour = Number.parseInt(value.slice(9, 11), 10);
  const minute = Number.parseInt(value.slice(11, 13), 10);
  const second = Number.parseInt(value.slice(13, 15), 10);
  return parisWallTimeToDate({
    day,
    hour,
    minute,
    month,
    second,
    year
  });
}

function serviceDayKey(date) {
  const parts = parisDateTimeParts(date);
  const serviceDate = parts.hour < 4
    ? shiftCalendarDate(parts, -1)
    : parts;
  return formatCompactDateParts(serviceDate);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function differenceInMinutes(later, earlier) {
  return Math.round((later.getTime() - earlier.getTime()) / 60000);
}

function optionDepartsSoonEnough(option, requestedDepartureAt, graceMinutes = staleJourneyGraceMinutes) {
  const departureValue = option?.departureAt || option?.origin?.departureAt || "";
  const departureMs = Date.parse(departureValue);
  if (!Number.isFinite(departureMs)) {
    return false;
  }

  return departureMs >= requestedDepartureAt.getTime() - graceMinutes * 60 * 1000;
}

function sameServiceDay(left, right) {
  return serviceDayKey(left) === serviceDayKey(right);
}

function stripHtml(html) {
  if (!html) {
    return "";
  }

  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#039;/gi, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function cleanDisplayLabel(value) {
  const normalized = String(value || "")
    .replace(/\s+\(Tours\)$/i, "")
    .trim();
  return normalized || String(value || "");
}

function slugify(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeSearchText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function parseCoordinate(value) {
  const number = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) ? number : null;
}

function distanceBetweenMeters(fromLat, fromLon, toLat, toLon) {
  const earthRadiusMeters = 6_371_000;
  const latDelta = ((toLat - fromLat) * Math.PI) / 180;
  const lonDelta = ((toLon - fromLon) * Math.PI) / 180;
  const fromLatRadians = (fromLat * Math.PI) / 180;
  const toLatRadians = (toLat * Math.PI) / 180;

  const a =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(fromLatRadians) *
      Math.cos(toLatRadians) *
      Math.sin(lonDelta / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMeters * c;
}

function estimateWalkMinutes(distanceMeters) {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 80) {
    return 0;
  }

  return Math.max(1, Math.ceil(distanceMeters / walkingMetersPerMinute));
}

function formatDistance(distanceMeters) {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    return "0 m";
  }

  if (distanceMeters < 1_000) {
    return `${Math.round(distanceMeters / 10) * 10} m`;
  }

  return `${(distanceMeters / 1_000).toFixed(1)} km`;
}

function findNearestArea(areas, lat, lon, predicate = () => true) {
  let bestArea = null;
  let bestDistanceMeters = Number.POSITIVE_INFINITY;

  for (const area of areas) {
    if (!predicate(area)) {
      continue;
    }

    const areaLat = parseCoordinate(area.lat);
    const areaLon = parseCoordinate(area.lon);
    if (areaLat === null || areaLon === null) {
      continue;
    }

    const distanceMeters = distanceBetweenMeters(lat, lon, areaLat, areaLon);
    if (distanceMeters < bestDistanceMeters) {
      bestArea = area;
      bestDistanceMeters = distanceMeters;
    }
  }

  if (!bestArea) {
    return null;
  }

  return {
    area: bestArea,
    distanceMeters: bestDistanceMeters
  };
}

function findNearestAreas(
  areas,
  lat,
  lon,
  predicate = () => true,
  limit = 4,
  maxDistanceMeters = Number.POSITIVE_INFINITY
) {
  return areas
    .filter((area) => predicate(area))
    .map((area) => ({
      area,
      distanceMeters: distanceBetweenMeters(lat, lon, area.lat, area.lon)
    }))
    .filter((entry) => entry.distanceMeters <= maxDistanceMeters)
    .sort((left, right) => left.distanceMeters - right.distanceMeters)
    .slice(0, Math.max(1, limit));
}

function parseLocationId(value) {
  const [lonRaw, latRaw] = String(value || "").split(";");
  if (!lonRaw || !latRaw) {
    return null;
  }

  const lat = parseCoordinate(latRaw);
  const lon = parseCoordinate(lonRaw);
  if (lat === null || lon === null) {
    return null;
  }

  return { lat, lon };
}

function areaSearchScore(area, query) {
  const normalizedQuery = normalizeSearchText(query).trim();
  if (!normalizedQuery) {
    return -1;
  }

  const haystack = normalizeSearchText(
    `${area.label} ${area.name} ${area.town} ${area.lineCodes.join(" ")}`
  );
  const index = haystack.indexOf(normalizedQuery);

  if (index === -1) {
    return -1;
  }

  let score = 220 - index;
  if (normalizeSearchText(area.name).startsWith(normalizedQuery)) {
    score += 30;
  }
  if (normalizeSearchText(area.label).startsWith(normalizedQuery)) {
    score += 20;
  }

  return score;
}

function placeSearchScore(place, query) {
  const normalizedQuery = normalizeSearchText(query).trim();
  if (!normalizedQuery) {
    return -1;
  }

  const haystack = normalizeSearchText(
    `${place.name || ""} ${place.address || ""} ${place.city || ""}`
  );
  const index = haystack.indexOf(normalizedQuery);

  if (index === -1) {
    return -1;
  }

  let score = 200 - index;
  if (normalizeSearchText(place.name).startsWith(normalizedQuery)) {
    score += 35;
  }

  return score;
}

function routeCacheKey(pathname, params) {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right));
  const query = new URLSearchParams(entries);
  return `${pathname}?${query.toString()}`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "affiche-filbleu/1.0"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Upstream ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json();
}

async function geocodeAddressQuery(query) {
  const cacheKey = normalizeSearchText(query).trim();
  const cached = geocodeCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const searchParams = new URLSearchParams({
    autocomplete: "1",
    lat: String(toursCenter.lat),
    limit: "6",
    lon: String(toursCenter.lon),
    q: query
  });

  const payload = await fetchJson(`${addressLookupBaseUrl}?${searchParams.toString()}`);
  const features = Array.isArray(payload.features) ? payload.features : [];

  geocodeCache.set(cacheKey, {
    expiresAt: Date.now() + geocodeCacheTtlMs,
    value: features
  });

  return features;
}

async function reverseGeocodeCoordinates(lat, lon) {
  const cacheKey = `reverse:${lat.toFixed(5)}:${lon.toFixed(5)}`;
  const cached = geocodeCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const searchParams = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    limit: "1"
  });

  const payload = await fetchJson(`${addressReverseBaseUrl}?${searchParams.toString()}`);
  const feature = Array.isArray(payload.features) ? payload.features[0] || null : null;

  geocodeCache.set(cacheKey, {
    expiresAt: Date.now() + geocodeCacheTtlMs,
    value: feature
  });

  return feature;
}

function isTramRoute(meta) {
  if (!meta) {
    return false;
  }

  const normalizedCode = String(meta.lineCode || "").trim().toUpperCase();
  if (normalizedCode === "A") {
    return true;
  }

  const haystack = `${meta.cat} ${meta.mode}`.toLowerCase();
  return /^[A-Z]$/.test(normalizedCode) && haystack.includes("tram");
}

function isTrainRoute(meta) {
  if (!meta) {
    return false;
  }

  const haystack = `${meta.cat} ${meta.mode}`.toLowerCase();
  return haystack.includes("train");
}

function isBusRoute(meta) {
  return Boolean(meta) && !isTramRoute(meta) && !isTrainRoute(meta);
}

function severityLabel(severity) {
  switch (severity) {
    case "blocking":
      return "Interruption";
    case "delays":
      return "Retards";
    case "warning":
      return "Alerte";
    default:
      return "Information";
  }
}

function normalizeDirection(direction) {
  return direction || "Direction non precisee";
}

function normalizeLineBadge(meta) {
  return {
    code: meta?.lineCode || "?",
    color: meta?.color || "1c2740",
    textColor: meta?.textColor || "ffffff"
  };
}

function buildNetworkData(rawData) {
  const lineMetaById = new Map();
  const routeMetaById = new Map();
  const areaById = new Map();
  const stopPointById = new Map();

  for (const line of rawData.lines || []) {
    lineMetaById.set(line.id, {
      cat: line.cat || "",
      lineCode: line.code || "",
      lineId: line.id || "",
      lineName: line.name || "",
      mode: line.mode || ""
    });

    for (const route of line.routes || []) {
      routeMetaById.set(route.route_id, {
        cat: line.cat || "",
        color: line.color || "1c2740",
        directionId: route.direction_id || "",
        directionName: normalizeDirection(route.direction || route.name),
        lineCode: line.code || "",
        lineId: line.id || "",
        lineName: line.name || "",
        mode: line.mode || "",
        routeId: route.route_id,
        textColor: line.text || "ffffff"
      });
    }
  }

  for (const stop of rawData.stops || []) {
    const stopAreaId = stop.stop_area || stop.id;
    const routeIds = (stop.lines || [])
      .map((line) => line.route_id)
      .filter(Boolean);
    const town =
      stop.town ||
      stop.address?.administrative_regions?.[0]?.name ||
      "Tours";
    const label = `${stop.name} (${town})`;
    const stopPoint = {
      id: stop.id,
      label: stop.address?.label || label,
      lat: Number.parseFloat(stop.coord?.lat || stop.address?.coord?.lat || "0"),
      lon: Number.parseFloat(stop.coord?.lon || stop.address?.coord?.lon || "0"),
      name: stop.name,
      pmr: Boolean(stop.pmr),
      routeIds
    };

    stopPointById.set(stopPoint.id, stopPoint);

    if (!areaById.has(stopAreaId)) {
      areaById.set(stopAreaId, {
        id: stopAreaId,
        label,
        lat: stopPoint.lat,
        lineCodes: new Set(),
        lon: stopPoint.lon,
        name: stop.name,
        hasBus: false,
        hasTram: false,
        stopPoints: [],
        town
      });
    }

    const area = areaById.get(stopAreaId);
    area.stopPoints.push(stopPoint);

    for (const routeId of routeIds) {
      const meta = routeMetaById.get(routeId);
      if (!meta) {
        continue;
      }

      area.lineCodes.add(meta.lineCode);
      area.hasTram ||= isTramRoute(meta);
      area.hasBus ||= isBusRoute(meta);
    }
  }

  const areas = [...areaById.values()]
    .map((area) => ({
      ...area,
      lineCodes: [...area.lineCodes].sort(),
      searchKey: slugify(`${area.name} ${area.town} ${[...area.lineCodes].join(" ")}`)
    }))
    .sort((left, right) => {
      if (left.hasTram !== right.hasTram) {
        return left.hasTram ? -1 : 1;
      }
      return left.label.localeCompare(right.label, "fr");
    });

  const tramAreaIds = areas
    .filter((area) => area.hasTram)
    .map((area) => area.id);

  return {
    areas,
    areasById: new Map(areas.map((area) => [area.id, area])),
    lineMetaById,
    rawData,
    routeMetaById,
    stopPointById,
    tramAreaIds
  };
}

async function getNetworkData() {
  const now = Date.now();
  if (initCache.value && initCache.expiresAt > now) {
    return initCache.value;
  }

  const rawData = await fetchJson(`${upstreamBaseUrl}/api/init-application`);
  const processed = buildNetworkData(rawData);
  initCache.value = processed;
  initCache.expiresAt = now + initCacheTtlMs;
  return processed;
}

async function searchOriginSuggestions(query, networkData) {
  const normalizedQuery = normalizeSearchText(query).trim();
  if (normalizedQuery.length < 2) {
    return [];
  }

  const areaSuggestions = networkData.areas
    .filter((area) => area.hasBus)
    .map((area) => ({
      area,
      score: areaSearchScore(area, normalizedQuery)
    }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map(({ area }) => ({
      areaId: area.id,
      areaLabel: area.label,
      details:
        area.lineCodes.slice(0, 5).join(" · ") || "Arret bus Fil Bleu",
      kind: "area",
      label: area.label
    }));

  const placeSuggestions = (Array.isArray(networkData.rawData.places) ? networkData.rawData.places : [])
    .map((place) => ({
      place,
      score: placeSearchScore(place, normalizedQuery)
    }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map(({ place }) => {
      const lat = parseCoordinate(place.coord?.lat);
      const lon = parseCoordinate(place.coord?.lon);

      if (lat === null || lon === null) {
        return null;
      }

      const nearestArea = findNearestArea(
        networkData.areas,
        lat,
        lon,
        (area) => area.hasBus
      );

      if (!nearestArea || nearestArea.distanceMeters > nearestBusMaxDistanceMeters) {
        return null;
      }

      const walkMinutes = estimateWalkMinutes(nearestArea.distanceMeters);
      const walkLabel = walkMinutes > 0
        ? `${walkMinutes} min a pied`
        : "sur place";

      return {
        areaId: nearestArea.area.id,
        areaLabel: nearestArea.area.label,
        details: `${place.address || place.city || "Lieu"} · bus: ${nearestArea.area.label} · ${walkLabel}`,
        kind: "place",
        label: place.city
          ? `${place.name} (${place.city})`
          : place.name,
        lat,
        lon,
        walkDistanceLabel: formatDistance(nearestArea.distanceMeters),
        walkDistanceMeters: Math.round(nearestArea.distanceMeters),
        walkMinutes
      };
    })
    .filter(Boolean);

  let addressSuggestions = [];

  try {
    const features = await geocodeAddressQuery(query);
    addressSuggestions = features
      .map((feature) => {
        const [lonRaw, latRaw] = Array.isArray(feature.geometry?.coordinates)
          ? feature.geometry.coordinates
          : [];
        const lat = parseCoordinate(latRaw);
        const lon = parseCoordinate(lonRaw);
        const score = Number.parseFloat(feature.properties?.score ?? "0");

        if (lat === null || lon === null || score < 0.45) {
          return null;
        }

        const distanceFromToursMeters = distanceBetweenMeters(
          lat,
          lon,
          toursCenter.lat,
          toursCenter.lon
        );
        if (distanceFromToursMeters > localGeocodeRadiusMeters) {
          return null;
        }

        const nearestArea = findNearestArea(
          networkData.areas,
          lat,
          lon,
          (area) => area.hasBus
        );

        if (!nearestArea || nearestArea.distanceMeters > nearestBusMaxDistanceMeters) {
          return null;
        }

        const walkMinutes = estimateWalkMinutes(nearestArea.distanceMeters);
        const walkLabel = walkMinutes > 0
          ? `${walkMinutes} min a pied`
          : "sur place";

        return {
          areaId: nearestArea.area.id,
          areaLabel: nearestArea.area.label,
          details: `Arret bus: ${nearestArea.area.label} · ${walkLabel}`,
          kind: "address",
          label: feature.properties?.label || query,
          lat,
          lon,
          score,
          walkDistanceLabel: formatDistance(nearestArea.distanceMeters),
          walkDistanceMeters: Math.round(nearestArea.distanceMeters),
          walkMinutes
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score)
      .slice(0, 5);
  } catch {
    addressSuggestions = [];
  }

  const seen = new Set();
  return [...areaSuggestions, ...placeSuggestions, ...addressSuggestions]
    .filter((suggestion) => {
      const key = [
        suggestion.kind,
        suggestion.label,
        suggestion.areaId
      ].join("|");

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function compactPeriodOverlapsDate(period, date) {
  const start = parseCompactDateTime(period.begin);
  const end = parseCompactDateTime(period.end);
  if (!start || !end) {
    return true;
  }

  const dayParts = parisDateTimeParts(date);
  const nextDayParts = shiftCalendarDate(dayParts, 1);
  const dayStart = parisWallTimeToDate(dayParts);
  const dayEnd = parisWallTimeToDate(nextDayParts);
  return start < dayEnd && end >= dayStart;
}

function buildDisruptionSummary(disruption) {
  const impactedLines = new Set();
  const impactedAreas = new Set();

  for (const impactedObject of disruption.impacted_objects || []) {
    if (impactedObject.line) {
      impactedLines.add(impactedObject.line);
    }
    if (impactedObject.from) {
      impactedAreas.add(impactedObject.from);
    }
    if (impactedObject.to) {
      impactedAreas.add(impactedObject.to);
    }
  }

  const plainMessage = stripHtml(disruption.message);
  const manifestHaystack = normalizeSearchText(
    `${disruption.title} ${disruption.reason} ${plainMessage}`
  );

  return {
    begin: disruption.begin,
    end: disruption.end,
    id: disruption.id,
    impactedAreas: [...impactedAreas],
    impactedLines: [...impactedLines],
    isManifestation: /(manifest|manif|cortege|defile|rassemblement)/.test(manifestHaystack),
    message: plainMessage,
    periods: disruption.periods || [],
    reason: disruption.reason || "Perturbation",
    severity: disruption.severity || "info",
    severityLabel: severityLabel(disruption.severity),
    title: disruption.title || "Perturbation reseau"
  };
}

async function getDisruptions() {
  const now = Date.now();
  if (disruptionCache.value && disruptionCache.expiresAt > now) {
    return disruptionCache.value;
  }

  const rawDisruptions = await fetchJson(`${upstreamBaseUrl}/api/disruptions`);
  const processed = (Array.isArray(rawDisruptions) ? rawDisruptions : [])
    .map(buildDisruptionSummary);

  disruptionCache.value = processed;
  disruptionCache.expiresAt = now + disruptionCacheTtlMs;
  return processed;
}

function autocompleteKind(embeddedType) {
  switch (embeddedType) {
    case "stop_area":
      return "stop";
    case "address":
      return "address";
    case "poi":
      return "place";
    default:
      return "place";
  }
}

function autocompleteDetails(item) {
  switch (item.embedded_type) {
    case "stop_area":
      return "Arret Fil Bleu";
    case "address":
      return item.address?.label || "Adresse";
    case "poi":
      return "Lieu";
    default:
      return "Lieu";
  }
}

function normalizeAutocompleteSuggestion(item) {
  return {
    details: autocompleteDetails(item),
    id: item.id,
    kind: autocompleteKind(item.embedded_type),
    label: cleanDisplayLabel(item.address?.label || item.label || item.name || "Point")
  };
}

function autocompleteSuggestionPriority(kind) {
  switch (kind) {
    case "stop":
      return 0;
    case "address":
      return 1;
    case "place":
    default:
      return 2;
  }
}

async function searchLocations(query, type) {
  const endpointType = type === "to" ? "inputEnd" : "inputStart";
  const searchParams = new URLSearchParams({
    query,
    type: endpointType
  });

  const payload = await fetchJson(
    `${upstreamBaseUrl}/api/autocomplete?${searchParams.toString()}`
  );

  const dedupedByLabel = new Map();
  const normalizedSuggestions = (Array.isArray(payload) ? payload : [])
    .filter((item) => {
      return Boolean(item?.id) &&
        ["stop_area", "address", "poi"].includes(item.embedded_type);
    })
    .map(normalizeAutocompleteSuggestion)
    .map((suggestion, index) => ({
      ...suggestion,
      index
    }))
    .sort((left, right) => {
      const priorityDiff =
        autocompleteSuggestionPriority(left.kind) -
        autocompleteSuggestionPriority(right.kind);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      return left.index - right.index;
    });

  for (const suggestion of normalizedSuggestions) {
    const key = normalizeSearchText(suggestion.label).trim();
    if (!dedupedByLabel.has(key)) {
      dedupedByLabel.set(key, suggestion);
    }
  }

  return [...dedupedByLabel.values()]
    .sort((left, right) => left.index - right.index)
    .slice(0, 8)
    .map(({ index, ...suggestion }) => suggestion);
}

async function resolvePlanAutocompleteSelection({ id, label, type }) {
  const cleanedLabel = cleanDisplayLabel(label);
  if (!id || String(id).startsWith("stop_area:") || parseLocationId(id)) {
    return {
      id,
      label: cleanedLabel
    };
  }

  const normalizedLabel = normalizeSearchText(cleanedLabel).trim();
  if (!normalizedLabel) {
    return {
      id,
      label: cleanedLabel
    };
  }

  const suggestions = await searchLocations(cleanedLabel, type).catch(() => []);
  const exactStopSuggestion = suggestions.find((suggestion) => {
    return suggestion.kind === "stop" &&
      normalizeSearchText(cleanDisplayLabel(suggestion.label)).trim() === normalizedLabel;
  });

  if (!exactStopSuggestion) {
    return {
      id,
      label: cleanedLabel
    };
  }

  return {
    id: exactStopSuggestion.id,
    label: exactStopSuggestion.label
  };
}

function findLinkId(links, type) {
  return (Array.isArray(links) ? links : []).find((link) => link.type === type)?.id || null;
}

function labelFromPlace(place, fallback = "") {
  return cleanDisplayLabel(
    place?.stop_point?.label ||
    place?.stop_area?.label ||
    place?.address?.label ||
    place?.poi?.label ||
    place?.label ||
    place?.name ||
    fallback
  );
}

function stopAreaIdFromPlace(place) {
  return place?.stop_point?.stop_area?.id || place?.stop_area?.id || null;
}

function buildAreaLabelOverrides({
  from,
  fromLabel,
  to,
  toLabel
}) {
  const overrides = new Map();

  if (String(from || "").startsWith("stop_area:") && fromLabel) {
    overrides.set(from, cleanDisplayLabel(fromLabel));
  }

  if (String(to || "").startsWith("stop_area:") && toLabel) {
    overrides.set(to, cleanDisplayLabel(toLabel));
  }

  return overrides;
}

function applyAreaLabelOverrides(section, areaLabelOverrides = new Map()) {
  if (!section || areaLabelOverrides.size === 0) {
    return section;
  }

  const [fromAreaId, toAreaId] = Array.isArray(section.stopAreaIds)
    ? section.stopAreaIds
    : [];
  const overrideFrom = fromAreaId ? areaLabelOverrides.get(fromAreaId) : null;
  const overrideTo = toAreaId ? areaLabelOverrides.get(toAreaId) : null;

  if (!overrideFrom && !overrideTo) {
    return section;
  }

  return {
    ...section,
    from: overrideFrom || section.from,
    to: overrideTo || section.to
  };
}

function uniqueBy(items, keyBuilder) {
  const seen = new Set();
  const uniqueItems = [];

  for (const item of items) {
    const key = keyBuilder(item);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueItems.push(item);
  }

  return uniqueItems;
}

function formatDurationMinutes(totalMinutes) {
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) {
    return "0 min";
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes} min`;
  }

  if (minutes === 0) {
    return `${hours} h`;
  }

  return `${hours} h ${String(minutes).padStart(2, "0")}`;
}

function describeSection(section) {
  if (section.type === "waiting") {
    return "Attente";
  }

  if (section.type === "transfer") {
    return "Correspondance a pied";
  }

  if (section.mode === "walking" || section.type === "crow_fly") {
    return "Marche";
  }

  return "Deplacement";
}

function normalizeJourneySection(section) {
  const departureAt = parseCompactDateTime(section.departure_date_time);
  const arrivalAt = parseCompactDateTime(section.arrival_date_time);
  if (!departureAt || !arrivalAt) {
    return null;
  }

  const durationMinutes = Math.max(
    0,
    Number.isFinite(section.duration)
      ? Math.round(section.duration / 60)
      : differenceInMinutes(arrivalAt, departureAt)
  );

  if (section.type === "crow_fly" && durationMinutes === 0) {
    return null;
  }

  if (section.type === "public_transport") {
    const display = section.display_informations || {};
    const modeLabel = display.physical_mode || display.commercial_mode || "Transport";

    return {
      arrivalAt: arrivalAt.toISOString(),
      arrivalAtLabel: formatClock(arrivalAt),
      badge: {
        color: display.color || "103c63",
        textColor: display.text_color || "ffffff"
      },
      departureAt: departureAt.toISOString(),
      departureAtLabel: formatClock(departureAt),
      direction: normalizeDirection(display.direction || display.headsign),
      durationLabel: formatDurationMinutes(durationMinutes),
      durationMinutes,
      from: labelFromPlace(section.from, "Depart"),
      kind: "public_transport",
      lineCode: display.code || display.label || "?",
      lineId: findLinkId(section.links, "line"),
      lineName: display.name || "",
      modeLabel,
      note: display.name || "",
      stopAreaIds: [
        stopAreaIdFromPlace(section.from),
        stopAreaIdFromPlace(section.to)
      ].filter(Boolean),
      to: labelFromPlace(section.to, "Arrivee"),
      type: section.type
    };
  }

  return {
    arrivalAt: arrivalAt.toISOString(),
    arrivalAtLabel: formatClock(arrivalAt),
    departureAt: departureAt.toISOString(),
    departureAtLabel: formatClock(departureAt),
    durationLabel: formatDurationMinutes(durationMinutes),
    durationMinutes,
    from: labelFromPlace(section.from),
    kind:
      section.type === "waiting"
        ? "waiting"
        : section.type === "transfer"
          ? "transfer"
          : "walking",
    label: describeSection(section),
    stopAreaIds: [
      stopAreaIdFromPlace(section.from),
      stopAreaIdFromPlace(section.to)
    ].filter(Boolean),
    to: labelFromPlace(section.to),
    type: section.type
  };
}

async function fetchItinerary({
  departureAt,
  from,
  params = itineraryParams,
  to
}) {
  const searchParams = new URLSearchParams({
    allowDisruptions: "true",
    datetime: compactDateTime(departureAt),
    from,
    params,
    to
  });

  return fetchJson(`${upstreamBaseUrl}/api/itinerary?${searchParams.toString()}`);
}

function transportModeKey(modeLabel) {
  const normalized = normalizeSearchText(modeLabel);

  if (normalized.includes("tram")) {
    return "tram";
  }

  if (normalized.includes("tempo")) {
    return "tempo";
  }

  if (normalized.includes("bus")) {
    return "bus";
  }

  return slugify(modeLabel || "transport") || "transport";
}

function resolvedModeLabel(rawModeLabel, lineMeta) {
  const rawHaystack = normalizeSearchText(rawModeLabel || "");
  if (rawHaystack.includes("bus")) {
    return "Bus";
  }

  if (rawHaystack.includes("tram")) {
    return "Tram";
  }

  if (rawHaystack.includes("tempo")) {
    return "Tempo";
  }

  const modeHaystack = normalizeSearchText(
    `${lineMeta?.mode || ""} ${lineMeta?.cat || ""} ${lineMeta?.lineCode || ""}`
  );

  if (lineMeta?.lineCode === "A" || modeHaystack.includes("tram")) {
    return "Tram";
  }

  if (modeHaystack.includes("tempo")) {
    return "Tempo";
  }

  if (modeHaystack.includes("bus")) {
    return "Bus";
  }

  return rawModeLabel || "Transport";
}

function transportLabelForOption({
  hasBus,
  hasTempo,
  hasTram,
  modeKeys,
  transferCount
}) {
  if (hasTram && !hasBus && !hasTempo && transferCount === 0) {
    return "Tram direct";
  }

  if (hasTram && !hasBus && !hasTempo) {
    return "Tout en tram";
  }

  if (hasTempo && !hasBus && !hasTram && transferCount === 0) {
    return "Tempo direct";
  }

  if (hasTempo && !hasBus && !hasTram) {
    return "Tout en tempo";
  }

  if (hasTram && hasBus) {
    return transferCount === 0 ? "Bus + tram direct" : "Bus + tram";
  }

  if (hasTram && hasTempo && !hasBus) {
    return transferCount === 0 ? "Tram + tempo direct" : "Tram + tempo";
  }

  if (hasTempo && hasBus && !hasTram) {
    return transferCount === 0 ? "Tempo + bus direct" : "Tempo + bus";
  }

  if (hasBus && !hasTram) {
    return transferCount === 0 ? "Bus direct" : "Bus";
  }

  if (modeKeys.length === 0) {
    return "Marche";
  }

  return "Transport";
}

function optionPreferenceRank(option) {
  if (option.isTramOnly && option.transferCount === 0) {
    return 0;
  }

  if (option.isTramOnly) {
    return 1;
  }

  if (option.hasTram && option.transferCount === 0) {
    return 2;
  }

  if (option.transferCount === 0) {
    return 3;
  }

  if (option.hasTram) {
    return 4;
  }

  if (option.hasTempo && option.transferCount === 0) {
    return 5;
  }

  if (option.hasTempo) {
    return 6;
  }

  return 7;
}

function compareJourneyOptions(left, right) {
  if (left.arrivalAt !== right.arrivalAt) {
    return left.arrivalAt.localeCompare(right.arrivalAt);
  }

  if (left.walkingMinutes !== right.walkingMinutes) {
    return left.walkingMinutes - right.walkingMinutes;
  }

  if (left.durationMinutes !== right.durationMinutes) {
    return left.durationMinutes - right.durationMinutes;
  }

  if (left.leaveInMinutes !== right.leaveInMinutes) {
    return left.leaveInMinutes - right.leaveInMinutes;
  }

  const leftDepartureMinute = String(left.departureAt || "").slice(0, 16);
  const rightDepartureMinute = String(right.departureAt || "").slice(0, 16);
  if (leftDepartureMinute !== rightDepartureMinute) {
    return rightDepartureMinute.localeCompare(leftDepartureMinute);
  }

  if (left.departureAt !== right.departureAt) {
    return right.departureAt.localeCompare(left.departureAt);
  }

  if (left.transferCount !== right.transferCount) {
    return left.transferCount - right.transferCount;
  }

  return optionPreferenceRank(left) - optionPreferenceRank(right);
}

function sortJourneyOptions(options) {
  return [...options].sort(compareJourneyOptions);
}

function normalizeJourneyOption(
  journey,
  requestedDepartureAt,
  lineMetaById = new Map(),
  areaLabelOverrides = new Map()
) {
  const departureAt = parseCompactDateTime(journey.departure_date_time);
  const arrivalAt = parseCompactDateTime(journey.arrival_date_time);
  if (!departureAt || !arrivalAt) {
    return null;
  }

  const sections = (Array.isArray(journey.sections) ? journey.sections : [])
    .map(normalizeJourneySection)
    .map((section) => {
      if (!section || section.kind !== "public_transport") {
        return section;
      }

      const lineMeta = lineMetaById.get(section.lineId);
      return {
        ...section,
        modeLabel: resolvedModeLabel(section.modeLabel, lineMeta)
      };
    })
    .map((section) => applyAreaLabelOverrides(section, areaLabelOverrides))
    .filter(Boolean);
  const transitSections = sections.filter((section) => section.kind === "public_transport");
  const lines = uniqueBy(
    transitSections.map((section) => ({
      badge: section.badge,
      lineCode: section.lineCode,
      lineId: section.lineId,
      modeLabel: section.modeLabel
    })),
    (line) => `${line.lineId || line.lineCode}|${line.modeLabel}`
  );
  const durationMinutes = Math.max(0, differenceInMinutes(arrivalAt, departureAt));
  const walkingMinutes = Math.max(0, Math.round((journey.durations?.walking || 0) / 60));
  const waitingMinutes = sections
    .filter((section) => section.kind === "waiting")
    .reduce((total, section) => total + section.durationMinutes, 0);
  const modeKeys = uniqueBy(
    transitSections.map((section) => transportModeKey(section.modeLabel)),
    (mode) => mode
  );
  const hasTram = modeKeys.includes("tram");
  const hasTempo = modeKeys.includes("tempo");
  const hasBus = modeKeys.includes("bus");
  const transferCount =
    Number.isFinite(journey.nb_transfers) && journey.nb_transfers >= 0
      ? journey.nb_transfers
      : Math.max(0, lines.length - 1);

  return {
    arrivalAt: arrivalAt.toISOString(),
    arrivalAtLabel: formatClock(arrivalAt),
    departureAt: departureAt.toISOString(),
    departureAtLabel: formatClock(departureAt),
    durationLabel: formatDurationMinutes(durationMinutes),
    durationMinutes,
    hasBus,
    hasTempo,
    hasTram,
    isBusOnly: hasBus && !hasTram && !hasTempo && modeKeys.length === 1,
    isDirect: transferCount === 0,
    isTramOnly: hasTram && !hasBus && !hasTempo && modeKeys.length === 1,
    leaveInMinutes: Math.max(0, differenceInMinutes(departureAt, requestedDepartureAt)),
    lines,
    modeKeys,
    routeLabel:
      lines.length > 0
        ? lines.map((line) => `${line.modeLabel} ${line.lineCode}`).join(" -> ")
        : "Marche",
    sections,
    transferCount,
    transportLabel: transportLabelForOption({
      hasBus,
      hasTempo,
      hasTram,
      modeKeys,
      transferCount
    }),
    walkingMinutes,
    waitingMinutes
  };
}

function optionIsNearbyTramDuplicate(left, right, windowMinutes = 4) {
  if (!left?.isTramOnly || !right?.isTramOnly) {
    return false;
  }

  const leftLineId = left.lines?.[0]?.lineId;
  const rightLineId = right.lines?.[0]?.lineId;
  if (!leftLineId || !rightLineId || leftLineId !== rightLineId) {
    return false;
  }

  const leftDepartureMs = Date.parse(left.departureAt);
  const rightDepartureMs = Date.parse(right.departureAt);
  if (!Number.isFinite(leftDepartureMs) || !Number.isFinite(rightDepartureMs)) {
    return false;
  }

  return Math.abs(leftDepartureMs - rightDepartureMs) <= windowMinutes * 60 * 1000;
}

function compareNearbyTramOptions(left, right) {
  if (left.arrivalAt !== right.arrivalAt) {
    return left.arrivalAt.localeCompare(right.arrivalAt);
  }

  if (left.walkingMinutes !== right.walkingMinutes) {
    return left.walkingMinutes - right.walkingMinutes;
  }

  if (left.durationMinutes !== right.durationMinutes) {
    return left.durationMinutes - right.durationMinutes;
  }

  return left.departureAt.localeCompare(right.departureAt);
}

function optionLinesKey(option) {
  return (option.lines || [])
    .map((line) => `${line.modeLabel}:${line.lineCode}`)
    .join("|");
}

function compareEquivalentJourneyOptions(left, right) {
  if (left.walkingMinutes !== right.walkingMinutes) {
    return left.walkingMinutes - right.walkingMinutes;
  }

  if (left.durationMinutes !== right.durationMinutes) {
    return left.durationMinutes - right.durationMinutes;
  }

  if (left.waitingMinutes !== right.waitingMinutes) {
    return left.waitingMinutes - right.waitingMinutes;
  }

  return right.departureAt.localeCompare(left.departureAt);
}

function dedupeEquivalentJourneyOptions(options) {
  const kept = new Map();

  for (const option of sortJourneyOptions(options)) {
    const key = [
      option.transportLabel,
      option.routeLabel,
      optionLinesKey(option),
      String(option.arrivalAt || "").slice(0, 16)
    ].join("|");
    const existing = kept.get(key);
    if (!existing || compareEquivalentJourneyOptions(option, existing) < 0) {
      kept.set(key, option);
    }
  }

  return sortJourneyOptions([...kept.values()]);
}

function optionDominates(left, right) {
  if (!left || !right || left === right) {
    return false;
  }

  const leftArrivalAt = Date.parse(left.arrivalAt);
  const rightArrivalAt = Date.parse(right.arrivalAt);
  if (!Number.isFinite(leftArrivalAt) || !Number.isFinite(rightArrivalAt)) {
    return false;
  }

  if (Math.abs(leftArrivalAt - rightArrivalAt) > 60 * 1000) {
    return false;
  }

  if (left.walkingMinutes > right.walkingMinutes) {
    return false;
  }

  if (left.durationMinutes > right.durationMinutes) {
    return false;
  }

  return left.walkingMinutes < right.walkingMinutes ||
    left.durationMinutes < right.durationMinutes;
}

function pruneDominatedJourneyOptions(options) {
  const sortedOptions = sortJourneyOptions(options);

  return sortedOptions.filter((option, index) => {
    return !sortedOptions.some((candidate, candidateIndex) => {
      return candidateIndex !== index && optionDominates(candidate, option);
    });
  });
}

function dedupeNearbyTramOptions(options) {
  const kept = [];

  for (const option of sortJourneyOptions(options)) {
    const existingIndex = kept.findIndex((candidate) => optionIsNearbyTramDuplicate(candidate, option));
    if (existingIndex === -1) {
      kept.push(option);
      continue;
    }

    if (compareNearbyTramOptions(option, kept[existingIndex]) < 0) {
      kept[existingIndex] = option;
    }
  }

  return sortJourneyOptions(kept);
}

function summarizeWalkToTramOption({
  destinationArea,
  destinationLabel,
  originLabel,
  requestedDepartureAt,
  tramArea,
  tramLeg,
  walkDistanceMeters
}) {
  const walkMinutes = estimateWalkMinutes(walkDistanceMeters);
  const departureAt = addMinutes(tramLeg.departAt, -walkMinutes);
  const durationMinutes = Math.max(0, differenceInMinutes(tramLeg.arrivalAt, departureAt));
  const leaveInMinutes = Math.max(0, differenceInMinutes(departureAt, requestedDepartureAt));
  const cleanedTramLabel = cleanDisplayLabel(tramArea.label);
  const cleanedDestinationLabel = cleanDisplayLabel(destinationLabel || destinationArea.label);
  const sections = [];

  if (walkMinutes > 0) {
    const walkArrivalAt = addMinutes(departureAt, walkMinutes);
    sections.push({
      arrivalAt: walkArrivalAt.toISOString(),
      arrivalAtLabel: formatClock(walkArrivalAt),
      departureAt: departureAt.toISOString(),
      departureAtLabel: formatClock(departureAt),
      durationLabel: formatDurationMinutes(walkMinutes),
      durationMinutes: walkMinutes,
      from: cleanDisplayLabel(originLabel || "Point de depart"),
      kind: "walking",
      label: "Marche",
      stopAreaIds: [tramArea.id],
      to: cleanedTramLabel,
      type: "street_network"
    });
  }

  sections.push({
    arrivalAt: tramLeg.arrivalAt.toISOString(),
    arrivalAtLabel: formatClock(tramLeg.arrivalAt),
    badge: tramLeg.badge,
    departureAt: tramLeg.departAt.toISOString(),
    departureAtLabel: formatClock(tramLeg.departAt),
    direction: tramLeg.direction,
    durationLabel: formatDurationMinutes(tramLeg.travelMinutes),
    durationMinutes: tramLeg.travelMinutes,
    from: cleanedTramLabel,
    kind: "public_transport",
    lineCode: tramLeg.lineCode,
    lineId: tramLeg.lineId,
    lineName: tramLeg.lineName,
    modeLabel: "Tram",
    note: tramLeg.lineName || "",
    stopAreaIds: [tramArea.id, destinationArea.id],
    to: cleanedDestinationLabel,
    type: "public_transport"
  });

  return {
    arrivalAt: tramLeg.arrivalAt.toISOString(),
    arrivalAtLabel: formatClock(tramLeg.arrivalAt),
    departureAt: departureAt.toISOString(),
    departureAtLabel: formatClock(departureAt),
    durationLabel: formatDurationMinutes(durationMinutes),
    durationMinutes,
    hasBus: false,
    hasTempo: false,
    hasTram: true,
    isBusOnly: false,
    isDirect: true,
    isTramOnly: true,
    leaveInMinutes,
    lines: [{
      badge: tramLeg.badge,
      lineCode: tramLeg.lineCode,
      lineId: tramLeg.lineId,
      modeLabel: "Tram"
    }],
    modeKeys: ["tram"],
    routeLabel: `Tram ${tramLeg.lineCode}`,
    sections,
    transferCount: 0,
    transportLabel: "Tram direct",
    walkingMinutes: walkMinutes,
    waitingMinutes: Math.max(
      0,
      differenceInMinutes(tramLeg.departAt, addMinutes(departureAt, walkMinutes))
    )
  };
}

function areaRouteIds(area, networkData, routeMatcher = () => true) {
  const routeIds = new Set();

  for (const stopPoint of area?.stopPoints || []) {
    for (const routeId of stopPoint.routeIds || []) {
      const meta = networkData.routeMetaById.get(routeId);
      if (meta && routeMatcher(meta)) {
        routeIds.add(routeId);
      }
    }
  }

  return routeIds;
}

function sharesAnyRoute(leftRouteIds, rightRouteIds) {
  for (const routeId of leftRouteIds) {
    if (rightRouteIds.has(routeId)) {
      return true;
    }
  }

  return false;
}

function areaMatchesBusLineHints(area, busLineHints, networkData) {
  if (!Array.isArray(busLineHints) || busLineHints.length === 0) {
    return true;
  }

  const hintedLineKeys = new Set(
    busLineHints.flatMap((line) => [
      line.lineCode || "",
      line.lineId || ""
    ].filter(Boolean))
  );

  return (area.stopPoints || []).some((stopPoint) =>
    (stopPoint.routeIds || []).some((routeId) => {
      const meta = networkData.routeMetaById.get(routeId);
      if (!isBusRoute(meta)) {
        return false;
      }

      return hintedLineKeys.has(meta.lineCode) || hintedLineKeys.has(meta.lineId);
    })
  );
}

function resolveSourceTramAreas({ departureAt, from, networkData }) {
  if (String(from || "").startsWith("stop_area:")) {
    const sourceArea = networkData.areasById.get(from);
    if (!sourceArea?.hasTram) {
      return [];
    }

    return [{
      area: sourceArea,
      readyAt: departureAt,
      walkDistanceMeters: 0,
      walkMinutes: 0
    }];
  }

  const originPoint = parseLocationId(from);
  if (!originPoint) {
    return [];
  }

  return findNearestAreas(
    networkData.areas,
    originPoint.lat,
    originPoint.lon,
    (area) => area.hasTram,
    nearbyTramAreaLimit,
    nearestTramMaxDistanceMeters
  ).map(({ area, distanceMeters }) => {
    const walkMinutes = estimateWalkMinutes(distanceMeters);
    return {
      area,
      readyAt: addMinutes(departureAt, walkMinutes),
      walkDistanceMeters: distanceMeters,
      walkMinutes
    };
  });
}

function resolveSourceBusAreas({ departureAt, from, networkData }) {
  if (String(from || "").startsWith("stop_area:")) {
    const sourceArea = networkData.areasById.get(from);
    if (!sourceArea?.hasBus) {
      return [];
    }

    return [{
      area: sourceArea,
      readyAt: departureAt,
      walkDistanceMeters: 0,
      walkMinutes: 0
    }];
  }

  const originPoint = parseLocationId(from);
  if (!originPoint) {
    return [];
  }

  return findNearestAreas(
    networkData.areas,
    originPoint.lat,
    originPoint.lon,
    (area) => area.hasBus,
    nearbyBusAreaLimit,
    nearbyBusSourceMaxDistanceMeters
  ).map(({ area, distanceMeters }) => {
    const walkMinutes = estimateWalkMinutes(distanceMeters);
    return {
      area,
      readyAt: addMinutes(departureAt, walkMinutes),
      walkDistanceMeters: distanceMeters,
      walkMinutes
    };
  });
}

function buildBusTramTransferAreas(destinationArea, networkData) {
  const destinationTramRoutes = areaRouteIds(destinationArea, networkData, isTramRoute);
  if (destinationTramRoutes.size === 0) {
    return [];
  }

  return networkData.areas
    .filter((area) => {
      return area.hasBus &&
        area.hasTram &&
        area.id !== destinationArea.id &&
        sharesAnyRoute(
          areaRouteIds(area, networkData, isTramRoute),
          destinationTramRoutes
        );
    })
    .sort((left, right) => {
      const leftDistance = distanceBetweenMeters(left.lat, left.lon, destinationArea.lat, destinationArea.lon);
      const rightDistance = distanceBetweenMeters(right.lat, right.lon, destinationArea.lat, destinationArea.lon);
      return rightDistance - leftDistance;
    });
}

function buildTransferPairs(networkData, destinationArea, busLineHints = []) {
  const destinationBusRoutes = areaRouteIds(destinationArea, networkData, isBusRoute);
  if (destinationBusRoutes.size === 0) {
    return [];
  }

  const candidateBusAreas = networkData.areas
    .filter((area) => {
      if (!area.hasBus || area.id === destinationArea.id) {
        return false;
      }

      if (!areaMatchesBusLineHints(area, busLineHints, networkData)) {
        return false;
      }

      return sharesAnyRoute(
        areaRouteIds(area, networkData, isBusRoute),
        destinationBusRoutes
      );
    })
    .sort((left, right) => {
      if (left.hasTram !== right.hasTram) {
        return left.hasTram ? -1 : 1;
      }

      const leftDistance = distanceBetweenMeters(left.lat, left.lon, destinationArea.lat, destinationArea.lon);
      const rightDistance = distanceBetweenMeters(right.lat, right.lon, destinationArea.lat, destinationArea.lon);
      return leftDistance - rightDistance;
    })
    .slice(0, transferCandidateAreaLimit);

  const pairs = [];

  for (const busArea of candidateBusAreas) {
    if (busArea.hasTram) {
      pairs.push({
        busArea,
        transferWalkDistanceMeters: 0,
        transferWalkMinutes: 0,
        tramArea: busArea
      });
    }

    const nearbyTramAreas = findNearestAreas(
      networkData.areas,
      busArea.lat,
      busArea.lon,
      (area) => area.hasTram && area.id !== busArea.id,
      3,
      transferWalkMaxDistanceMeters
    );

    for (const nearbyTramArea of nearbyTramAreas) {
      pairs.push({
        busArea,
        transferWalkDistanceMeters: nearbyTramArea.distanceMeters,
        transferWalkMinutes: estimateWalkMinutes(nearbyTramArea.distanceMeters),
        tramArea: nearbyTramArea.area
      });
    }
  }

  return uniqueBy(
    pairs.sort((left, right) => {
      if (left.transferWalkMinutes !== right.transferWalkMinutes) {
        return left.transferWalkMinutes - right.transferWalkMinutes;
      }

      const leftDistance = distanceBetweenMeters(
        left.busArea.lat,
        left.busArea.lon,
        destinationArea.lat,
        destinationArea.lon
      );
      const rightDistance = distanceBetweenMeters(
        right.busArea.lat,
        right.busArea.lon,
        destinationArea.lat,
        destinationArea.lon
      );
      return leftDistance - rightDistance;
    }),
    (pair) => `${pair.tramArea.id}|${pair.busArea.id}`
  );
}

function firstBusSection(option) {
  return (option.sections || []).find((section) => {
    return section.kind === "public_transport" && transportModeKey(section.modeLabel) === "bus";
  }) || null;
}

function summarizeTramBusTransferOption({
  busArea,
  busOption,
  destinationArea,
  destinationLabel,
  fromLabel,
  requestedDepartureAt,
  sourceOrigin,
  tramArea,
  tramLeg,
  transferWalkDistanceMeters,
  transferWalkMinutes
}) {
  const busLeg = firstBusSection(busOption);
  if (!busLeg) {
    return null;
  }

  const busArrivalAt = new Date(busOption.arrivalAt);
  const busDepartureAt = new Date(busLeg.departureAt);
  if (Number.isNaN(busArrivalAt.getTime()) || Number.isNaN(busDepartureAt.getTime())) {
    return null;
  }

  const departureAt = addMinutes(tramLeg.departAt, -sourceOrigin.walkMinutes);
  const durationMinutes = Math.max(0, differenceInMinutes(busArrivalAt, departureAt));
  const leaveInMinutes = Math.max(0, differenceInMinutes(departureAt, requestedDepartureAt));
  const cleanedOriginLabel = cleanDisplayLabel(fromLabel || sourceOrigin.area.label || "Depart");
  const cleanedTramFrom = cleanDisplayLabel(sourceOrigin.area.label);
  const cleanedTramTo = cleanDisplayLabel(tramArea.label);
  const cleanedBusFrom = cleanDisplayLabel(busArea.label);
  const cleanedDestinationLabel = cleanDisplayLabel(destinationLabel || destinationArea.label);
  const sections = [];

  if (sourceOrigin.walkMinutes > 0) {
    const walkArrivalAt = addMinutes(departureAt, sourceOrigin.walkMinutes);
    sections.push({
      arrivalAt: walkArrivalAt.toISOString(),
      arrivalAtLabel: formatClock(walkArrivalAt),
      departureAt: departureAt.toISOString(),
      departureAtLabel: formatClock(departureAt),
      durationLabel: formatDurationMinutes(sourceOrigin.walkMinutes),
      durationMinutes: sourceOrigin.walkMinutes,
      from: cleanedOriginLabel,
      kind: "walking",
      label: "Marche",
      stopAreaIds: [sourceOrigin.area.id],
      to: cleanedTramFrom,
      type: "street_network"
    });
  }

  sections.push({
    arrivalAt: tramLeg.arrivalAt.toISOString(),
    arrivalAtLabel: formatClock(tramLeg.arrivalAt),
    badge: tramLeg.badge,
    departureAt: tramLeg.departAt.toISOString(),
    departureAtLabel: formatClock(tramLeg.departAt),
    direction: tramLeg.direction,
    durationLabel: formatDurationMinutes(tramLeg.travelMinutes),
    durationMinutes: tramLeg.travelMinutes,
    from: cleanedTramFrom,
    kind: "public_transport",
    lineCode: tramLeg.lineCode,
    lineId: tramLeg.lineId,
    lineName: tramLeg.lineName,
    modeLabel: "Tram",
    note: tramLeg.lineName || "",
    stopAreaIds: [sourceOrigin.area.id, tramArea.id],
    to: cleanedTramTo,
    type: "public_transport"
  });

  if (transferWalkMinutes > 0) {
    const transferDepartureAt = tramLeg.arrivalAt;
    const transferArrivalAt = addMinutes(transferDepartureAt, transferWalkMinutes);
    sections.push({
      arrivalAt: transferArrivalAt.toISOString(),
      arrivalAtLabel: formatClock(transferArrivalAt),
      departureAt: transferDepartureAt.toISOString(),
      departureAtLabel: formatClock(transferDepartureAt),
      durationLabel: formatDurationMinutes(transferWalkMinutes),
      durationMinutes: transferWalkMinutes,
      from: cleanedTramTo,
      kind: "walking",
      label: "Correspondance a pied",
      stopAreaIds: [tramArea.id, busArea.id],
      to: cleanedBusFrom,
      type: "transfer"
    });
  }

  sections.push({
    arrivalAt: busArrivalAt.toISOString(),
    arrivalAtLabel: formatClock(busArrivalAt),
    badge: busLeg.badge,
    departureAt: busDepartureAt.toISOString(),
    departureAtLabel: formatClock(busDepartureAt),
    direction: busLeg.direction,
    durationLabel: busLeg.durationLabel,
    durationMinutes: busLeg.durationMinutes,
    from: cleanedBusFrom,
    kind: "public_transport",
    lineCode: busLeg.lineCode,
    lineId: busLeg.lineId,
    lineName: busLeg.lineName,
    modeLabel: "Bus",
    note: busLeg.lineName || "",
    stopAreaIds: [busArea.id, destinationArea.id],
    to: cleanedDestinationLabel,
    type: "public_transport"
  });

  const waitingMinutes = Math.max(
    0,
    differenceInMinutes(
      busDepartureAt,
      addMinutes(tramLeg.arrivalAt, transferWalkMinutes)
    )
  );

  const lines = [{
    badge: tramLeg.badge,
    lineCode: tramLeg.lineCode,
    lineId: tramLeg.lineId,
    modeLabel: "Tram"
  }, {
    badge: busLeg.badge,
    lineCode: busLeg.lineCode,
    lineId: busLeg.lineId,
    modeLabel: "Bus"
  }];

  return {
    arrivalAt: busArrivalAt.toISOString(),
    arrivalAtLabel: formatClock(busArrivalAt),
    departureAt: departureAt.toISOString(),
    departureAtLabel: formatClock(departureAt),
    durationLabel: formatDurationMinutes(durationMinutes),
    durationMinutes,
    hasBus: true,
    hasTempo: false,
    hasTram: true,
    isBusOnly: false,
    isDirect: false,
    isTramOnly: false,
    leaveInMinutes,
    lines,
    modeKeys: ["tram", "bus"],
    routeLabel: `Tram ${tramLeg.lineCode} -> Bus ${busLeg.lineCode}`,
    sections,
    transferCount: 1,
    transportLabel: "Tram + bus",
    waitingMinutes,
    walkingMinutes: sourceOrigin.walkMinutes + transferWalkMinutes
  };
}

function summarizeBusTramTransferOption({
  busLeg,
  destinationArea,
  destinationLabel,
  fromLabel,
  requestedDepartureAt,
  sourceOrigin,
  tramArea,
  tramLeg
}) {
  const departureAt = addMinutes(busLeg.departAt, -sourceOrigin.walkMinutes);
  const durationMinutes = Math.max(0, differenceInMinutes(tramLeg.arrivalAt, departureAt));
  const leaveInMinutes = Math.max(0, differenceInMinutes(departureAt, requestedDepartureAt));
  const waitingMinutes = Math.max(
    0,
    differenceInMinutes(tramLeg.departAt, addMinutes(busLeg.arrivalAt, transferWindowMinutes))
  );
  const cleanedOriginLabel = cleanDisplayLabel(fromLabel || sourceOrigin.area.label || "Depart");
  const cleanedBusFrom = cleanDisplayLabel(sourceOrigin.area.label);
  const cleanedTramFrom = cleanDisplayLabel(tramArea.label);
  const cleanedDestinationLabel = cleanDisplayLabel(destinationLabel || destinationArea.label);
  const sections = [];

  if (sourceOrigin.walkMinutes > 0) {
    const walkArrivalAt = addMinutes(departureAt, sourceOrigin.walkMinutes);
    sections.push({
      arrivalAt: walkArrivalAt.toISOString(),
      arrivalAtLabel: formatClock(walkArrivalAt),
      departureAt: departureAt.toISOString(),
      departureAtLabel: formatClock(departureAt),
      durationLabel: formatDurationMinutes(sourceOrigin.walkMinutes),
      durationMinutes: sourceOrigin.walkMinutes,
      from: cleanedOriginLabel,
      kind: "walking",
      label: "Marche",
      stopAreaIds: [sourceOrigin.area.id],
      to: cleanedBusFrom,
      type: "street_network"
    });
  }

  sections.push({
    arrivalAt: busLeg.arrivalAt.toISOString(),
    arrivalAtLabel: formatClock(busLeg.arrivalAt),
    badge: busLeg.badge,
    departureAt: busLeg.departAt.toISOString(),
    departureAtLabel: formatClock(busLeg.departAt),
    direction: busLeg.direction,
    durationLabel: formatDurationMinutes(busLeg.travelMinutes),
    durationMinutes: busLeg.travelMinutes,
    from: cleanedBusFrom,
    kind: "public_transport",
    lineCode: busLeg.lineCode,
    lineId: busLeg.lineId,
    lineName: busLeg.lineName,
    modeLabel: "Bus",
    note: busLeg.lineName || "",
    stopAreaIds: [sourceOrigin.area.id, tramArea.id],
    to: cleanedTramFrom,
    type: "public_transport"
  });

  if (waitingMinutes > 0) {
    const waitStartAt = addMinutes(busLeg.arrivalAt, transferWindowMinutes);
    sections.push({
      arrivalAt: tramLeg.departAt.toISOString(),
      arrivalAtLabel: formatClock(tramLeg.departAt),
      departureAt: waitStartAt.toISOString(),
      departureAtLabel: formatClock(waitStartAt),
      durationLabel: formatDurationMinutes(waitingMinutes),
      durationMinutes: waitingMinutes,
      from: cleanedTramFrom,
      kind: "waiting",
      label: "Attente",
      stopAreaIds: [tramArea.id],
      to: cleanedTramFrom,
      type: "waiting"
    });
  }

  sections.push({
    arrivalAt: tramLeg.arrivalAt.toISOString(),
    arrivalAtLabel: formatClock(tramLeg.arrivalAt),
    badge: tramLeg.badge,
    departureAt: tramLeg.departAt.toISOString(),
    departureAtLabel: formatClock(tramLeg.departAt),
    direction: tramLeg.direction,
    durationLabel: formatDurationMinutes(tramLeg.travelMinutes),
    durationMinutes: tramLeg.travelMinutes,
    from: cleanedTramFrom,
    kind: "public_transport",
    lineCode: tramLeg.lineCode,
    lineId: tramLeg.lineId,
    lineName: tramLeg.lineName,
    modeLabel: "Tram",
    note: tramLeg.lineName || "",
    stopAreaIds: [tramArea.id, destinationArea.id],
    to: cleanedDestinationLabel,
    type: "public_transport"
  });

  return {
    arrivalAt: tramLeg.arrivalAt.toISOString(),
    arrivalAtLabel: formatClock(tramLeg.arrivalAt),
    departureAt: departureAt.toISOString(),
    departureAtLabel: formatClock(departureAt),
    durationLabel: formatDurationMinutes(durationMinutes),
    durationMinutes,
    hasBus: true,
    hasTempo: false,
    hasTram: true,
    isBusOnly: false,
    isDirect: false,
    isTramOnly: false,
    leaveInMinutes,
    lines: [{
      badge: busLeg.badge,
      lineCode: busLeg.lineCode,
      lineId: busLeg.lineId,
      modeLabel: "Bus"
    }, {
      badge: tramLeg.badge,
      lineCode: tramLeg.lineCode,
      lineId: tramLeg.lineId,
      modeLabel: "Tram"
    }],
    modeKeys: ["bus", "tram"],
    routeLabel: `Bus ${busLeg.lineCode} -> Tram ${tramLeg.lineCode}`,
    sections,
    transferCount: 1,
    transportLabel: "Bus + tram",
    waitingMinutes,
    walkingMinutes: sourceOrigin.walkMinutes
  };
}

async function buildNearbyTramBusOptions({
  busLineHints = [],
  departureAt,
  from,
  fromLabel,
  networkData,
  to,
  toLabel
}) {
  if (!String(to || "").startsWith("stop_area:")) {
    return [];
  }

  const destinationArea = networkData.areasById.get(to);
  if (!destinationArea?.hasBus) {
    return [];
  }

  const sourceOrigins = resolveSourceTramAreas({
    departureAt,
    from,
    networkData
  });
  if (sourceOrigins.length === 0) {
    return [];
  }

  const transferPairs = buildTransferPairs(networkData, destinationArea, busLineHints);
  if (transferPairs.length === 0) {
    return [];
  }

  const hintedLineKeys = new Set(
    busLineHints.flatMap((line) => [
      line.lineId || "",
      line.lineCode || ""
    ].filter(Boolean))
  );
  const busAreaOptionsEntries = await Promise.all(
    uniqueBy(
      transferPairs.map((pair) => pair.busArea),
      (area) => area.id
    ).map(async (busArea) => {
      const itinerary = await fetchItinerary({
        departureAt,
        from: busArea.id,
        params: busOnlyItineraryParams,
        to
      }).catch(() => ({ journeys: [] }));
      const options = (Array.isArray(itinerary.journeys) ? itinerary.journeys : [])
        .map((journey) => normalizeJourneyOption(
          journey,
          departureAt,
          networkData.lineMetaById
        ))
        .filter((option) => option && option.hasBus && !option.hasTram && !option.hasTempo)
        .filter((option) => option.walkingMinutes <= 2)
        .filter((option) => {
          const busSection = firstBusSection(option);
          if (!busSection) {
            return false;
          }

          if (hintedLineKeys.size === 0) {
            return true;
          }

          return hintedLineKeys.has(busSection.lineId) || hintedLineKeys.has(busSection.lineCode);
        });

      return [busArea.id, sortJourneyOptions(options)];
    })
  );
  const busOptionsByAreaId = new Map(busAreaOptionsEntries);

  const optionsByOrigin = await Promise.all(
    sourceOrigins.map(async (sourceOrigin) => {
      const pairs = transferPairs
        .filter((pair) => pair.tramArea.id !== sourceOrigin.area.id)
        .filter((pair) => (busOptionsByAreaId.get(pair.busArea.id) || []).length > 0)
        .sort((left, right) => {
          const leftBusOption = (busOptionsByAreaId.get(left.busArea.id) || [])[0] || null;
          const rightBusOption = (busOptionsByAreaId.get(right.busArea.id) || [])[0] || null;
          const leftArrivalAt = leftBusOption ? Date.parse(leftBusOption.arrivalAt) : Number.POSITIVE_INFINITY;
          const rightArrivalAt = rightBusOption ? Date.parse(rightBusOption.arrivalAt) : Number.POSITIVE_INFINITY;

          if (leftArrivalAt !== rightArrivalAt) {
            return leftArrivalAt - rightArrivalAt;
          }

          const leftDistanceFromSource = distanceBetweenMeters(
            sourceOrigin.area.lat,
            sourceOrigin.area.lon,
            left.tramArea.lat,
            left.tramArea.lon
          );
          const rightDistanceFromSource = distanceBetweenMeters(
            sourceOrigin.area.lat,
            sourceOrigin.area.lon,
            right.tramArea.lat,
            right.tramArea.lon
          );

          if (leftDistanceFromSource !== rightDistanceFromSource) {
            return leftDistanceFromSource - rightDistanceFromSource;
          }

          if (left.transferWalkMinutes !== right.transferWalkMinutes) {
            return left.transferWalkMinutes - right.transferWalkMinutes;
          }

          const leftDistanceToDestination = distanceBetweenMeters(
            left.busArea.lat,
            left.busArea.lon,
            destinationArea.lat,
            destinationArea.lon
          );
          const rightDistanceToDestination = distanceBetweenMeters(
            right.busArea.lat,
            right.busArea.lon,
            destinationArea.lat,
            destinationArea.lon
          );

          return leftDistanceToDestination - rightDistanceToDestination;
        })
        .slice(0, 10);

      const optionsByPair = await Promise.all(
        pairs.map(async (pair) => {
          const tramLegs = await buildLegOptions({
            maxTravelMinutes: 90,
            mode: "tram",
            networkData,
            selectedDate: sourceOrigin.readyAt,
            sourceArea: sourceOrigin.area,
            targetArea: pair.tramArea
          }).catch(() => []);
          const busOptions = busOptionsByAreaId.get(pair.busArea.id) || [];
          const options = [];
          for (const tramLeg of tramLegs.slice(0, 5)) {
            const earliestBusAt = addMinutes(
              tramLeg.arrivalAt,
              pair.transferWalkMinutes + transferWindowMinutes
            );
            const busOption = busOptions.find((candidate) => new Date(candidate.departureAt) >= earliestBusAt);
            if (!busOption) {
              continue;
            }

            const option = summarizeTramBusTransferOption({
              busArea: pair.busArea,
              busOption,
              destinationArea,
              destinationLabel: toLabel,
              fromLabel,
              requestedDepartureAt: departureAt,
              sourceOrigin,
              tramArea: pair.tramArea,
              tramLeg,
              transferWalkDistanceMeters: pair.transferWalkDistanceMeters,
              transferWalkMinutes: pair.transferWalkMinutes
            });

            if (!option || option.waitingMinutes > maxMixedConnectionWaitMinutes) {
              continue;
            }

            options.push(option);

            if (options.length >= 2) {
              break;
            }
          }

          return options;
        })
      );

      return optionsByPair.flat();
    })
  );

  return sortJourneyOptions(uniqueBy(
    optionsByOrigin.flat(),
    (option) => {
      const linesKey = option.lines
        .map((line) => `${line.modeLabel}:${line.lineCode}`)
        .join("|");
      return `${option.departureAt}|${option.arrivalAt}|${linesKey}`;
    }
  ));
}

async function buildNearbyBusTramOptions({
  departureAt,
  from,
  fromLabel,
  networkData,
  to,
  toLabel
}) {
  if (!String(to || "").startsWith("stop_area:")) {
    return [];
  }

  const destinationArea = networkData.areasById.get(to);
  if (!destinationArea?.hasTram) {
    return [];
  }

  const sourceOrigins = resolveSourceBusAreas({
    departureAt,
    from,
    networkData
  });
  if (sourceOrigins.length === 0) {
    return [];
  }

  const transferTramAreas = buildBusTramTransferAreas(destinationArea, networkData)
    .sort((left, right) => {
      const leftDistance = Math.min(
        ...sourceOrigins.map((origin) =>
          distanceBetweenMeters(origin.area.lat, origin.area.lon, left.lat, left.lon)
        )
      );
      const rightDistance = Math.min(
        ...sourceOrigins.map((origin) =>
          distanceBetweenMeters(origin.area.lat, origin.area.lon, right.lat, right.lon)
        )
      );

      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }

      const leftToDestination = distanceBetweenMeters(left.lat, left.lon, destinationArea.lat, destinationArea.lon);
      const rightToDestination = distanceBetweenMeters(right.lat, right.lon, destinationArea.lat, destinationArea.lon);
      return rightToDestination - leftToDestination;
    })
    .slice(0, busTramTransferAreaLimit);
  if (transferTramAreas.length === 0) {
    return [];
  }

  const tramLegsByArea = new Map();
  await Promise.all(
    transferTramAreas.map(async (tramArea) => {
      const tramLegs = await buildLegOptions({
        maxTravelMinutes: 90,
        mode: "tram",
        networkData,
        selectedDate: departureAt,
        sourceArea: tramArea,
        targetArea: destinationArea
      }).catch(() => []);
      tramLegsByArea.set(tramArea.id, tramLegs);
    })
  );

  const options = [];

  for (const sourceOrigin of sourceOrigins) {
    for (const tramArea of transferTramAreas) {
      const tramLegs = tramLegsByArea.get(tramArea.id) || [];
      if (tramLegs.length === 0) {
        continue;
      }

      const busLegs = await buildLegOptions({
        maxTravelMinutes: 120,
        mode: "bus",
        networkData,
        selectedDate: sourceOrigin.readyAt,
        sourceArea: sourceOrigin.area,
        targetArea: tramArea
      }).catch(() => []);
      if (busLegs.length === 0) {
        continue;
      }

      for (const busLeg of busLegs.slice(0, 6)) {
        const minTramDeparture = addMinutes(busLeg.arrivalAt, transferWindowMinutes);
        const tramLeg = tramLegs.find((candidate) => candidate.departAt >= minTramDeparture);
        if (!tramLeg) {
          continue;
        }

        options.push(summarizeBusTramTransferOption({
          busLeg,
          destinationArea,
          destinationLabel: toLabel,
          fromLabel,
          requestedDepartureAt: departureAt,
          sourceOrigin,
          tramArea,
          tramLeg
        }));
      }
    }
  }

  return sortJourneyOptions(uniqueBy(
    options.filter(Boolean),
    (option) => `${option.departureAt}|${option.arrivalAt}|${optionLinesKey(option)}`
  ));
}

async function buildNearbyTramOptions({
  departureAt,
  from,
  fromLabel,
  networkData,
  to,
  toLabel
}) {
  if (!String(to || "").startsWith("stop_area:")) {
    return [];
  }

  const destinationArea = networkData.areasById.get(to);
  if (!destinationArea?.hasTram) {
    return [];
  }

  let nearbyTramAreas = [];
  if (String(from || "").startsWith("stop_area:")) {
    const sourceArea = networkData.areasById.get(from);
    if (sourceArea?.hasTram && sourceArea.id !== destinationArea.id) {
      nearbyTramAreas = [{
        area: sourceArea,
        distanceMeters: 0
      }];
    }
  } else {
    const originPoint = parseLocationId(from);
    if (!originPoint) {
      return [];
    }

    nearbyTramAreas = findNearestAreas(
      networkData.areas,
      originPoint.lat,
      originPoint.lon,
      (area) => area.hasTram && area.id !== destinationArea.id,
      nearbyTramAreaLimit,
      nearestTramMaxDistanceMeters
    );
  }

  if (nearbyTramAreas.length === 0) {
    return [];
  }

  const optionsByArea = await Promise.all(
    nearbyTramAreas.map(async ({ area, distanceMeters }) => {
      const walkMinutes = estimateWalkMinutes(distanceMeters);
      const readyAt = addMinutes(departureAt, walkMinutes);
      const tramLegs = await buildLegOptions({
        maxTravelMinutes: 90,
        mode: "tram",
        networkData,
        selectedDate: readyAt,
        sourceArea: area,
        targetArea: destinationArea
      }).catch(() => []);

      return tramLegs
        .slice(0, 6)
        .map((tramLeg) => summarizeWalkToTramOption({
          destinationArea,
          destinationLabel: toLabel,
          originLabel: fromLabel,
          requestedDepartureAt: departureAt,
          tramArea: area,
          tramLeg,
          walkDistanceMeters: distanceMeters
        }));
    })
  );

  return dedupeNearbyTramOptions(uniqueBy(
    optionsByArea.flat(),
    (option) => {
      const linesKey = option.lines
        .map((line) => `${line.modeLabel}:${line.lineCode}`)
        .join("|");
      return `${option.departureAt}|${option.arrivalAt}|${linesKey}`;
    }
  ));
}

async function buildDirectPlan({
  departureAt,
  from,
  fromLabel,
  to,
  toLabel
}) {
  const [resolvedFrom, resolvedTo, disruptions, networkData] = await Promise.all([
    resolvePlanAutocompleteSelection({
      id: from,
      label: fromLabel,
      type: "from"
    }),
    resolvePlanAutocompleteSelection({
      id: to,
      label: toLabel,
      type: "to"
    }),
    getDisruptions().catch(() => []),
    getNetworkData().catch(() => ({ lineMetaById: new Map() }))
  ]);

  const effectiveFrom = resolvedFrom.id;
  const effectiveTo = resolvedTo.id;
  const effectiveFromLabel = resolvedFrom.label || cleanDisplayLabel(fromLabel);
  const effectiveToLabel = resolvedTo.label || cleanDisplayLabel(toLabel);

  const [itinerary, tramOnlyItinerary] = await Promise.all([
    fetchItinerary({ departureAt, from: effectiveFrom, to: effectiveTo }),
    fetchItinerary({
      departureAt,
      from: effectiveFrom,
      params: tramOnlyItineraryParams,
      to: effectiveTo
    }).catch(() => ({ journeys: [] }))
  ]);
  const nearbyTramOptions = await buildNearbyTramOptions({
    departureAt,
    from: effectiveFrom,
    fromLabel: effectiveFromLabel,
    networkData,
    to: effectiveTo,
    toLabel: effectiveToLabel
  }).catch(() => []);
  const nearbyBusTramOptions = await buildNearbyBusTramOptions({
    departureAt,
    from: effectiveFrom,
    fromLabel: effectiveFromLabel,
    networkData,
    to: effectiveTo,
    toLabel: effectiveToLabel
  }).catch(() => []);

  const mergedJourneys = [
    ...(Array.isArray(itinerary.journeys) ? itinerary.journeys : []),
    ...(Array.isArray(tramOnlyItinerary.journeys) ? tramOnlyItinerary.journeys : [])
  ];

  if (mergedJourneys.length === 0) {
    throw new Error("Aucun trajet Fil Bleu n'a ete trouve pour cet horaire.");
  }

  let journeys = mergedJourneys.filter((journey) => {
    return (Array.isArray(journey.sections) ? journey.sections : []).some(
      (section) => section.type === "public_transport"
    );
  });

  if (journeys.length === 0) {
    journeys = mergedJourneys;
  }

  const areaLabelOverrides = buildAreaLabelOverrides({
    from: effectiveFrom,
    fromLabel: effectiveFromLabel,
    to: effectiveTo,
    toLabel: effectiveToLabel
  });
  const normalizedJourneyOptions = journeys
    .map((journey) => normalizeJourneyOption(
      journey,
      departureAt,
      networkData.lineMetaById,
      areaLabelOverrides
    ))
    .filter(Boolean);
  const busLineHints = uniqueBy(
    normalizedJourneyOptions
      .filter((option) => option.hasBus && !option.hasTram && !option.hasTempo)
      .flatMap((option) => option.lines),
    (line) => line.lineId || `${line.modeLabel}|${line.lineCode}`
  );

  const effectiveBusLineHints = busLineHints.length > 0
    ? busLineHints
    : uniqueBy(
      normalizedJourneyOptions
        .flatMap((option) => option.lines)
        .filter((line) => transportModeKey(line.modeLabel) === "bus"),
      (line) => line.lineId || `${line.modeLabel}|${line.lineCode}`
    );
  const nearbyTramBusOptions = await buildNearbyTramBusOptions({
    busLineHints: effectiveBusLineHints,
    departureAt,
    from: effectiveFrom,
    fromLabel: effectiveFromLabel,
    networkData,
    to: effectiveTo,
    toLabel: effectiveToLabel
  }).catch(() => []);

  const normalizedOptions = pruneDominatedJourneyOptions(
    dedupeEquivalentJourneyOptions(
      dedupeNearbyTramOptions(uniqueBy(
        [
          ...normalizedJourneyOptions,
          ...nearbyTramOptions,
          ...nearbyBusTramOptions,
          ...nearbyTramBusOptions
        ],
        (option) => `${option.departureAt}|${option.arrivalAt}|${optionLinesKey(option)}`
      ))
    )
  )
    .filter((option) => optionDepartsSoonEnough(option, departureAt));

  const options = sortJourneyOptions(normalizedOptions).slice(0, 6);

  if (options.length === 0) {
    throw new Error("Aucun trajet exploitable n'a ete renvoye par Fil Bleu.");
  }

  const lineIds = uniqueBy(
    options.flatMap((option) => option.lines),
    (line) => line.lineId || `${line.modeLabel}|${line.lineCode}`
  )
    .map((line) => line.lineId)
    .filter(Boolean);
  const areaIds = uniqueBy(
    [
      ...options.flatMap((option) => option.sections.flatMap((section) => section.stopAreaIds || [])),
      effectiveFrom.startsWith("stop_area:") ? effectiveFrom : null,
      effectiveTo.startsWith("stop_area:") ? effectiveTo : null
    ].filter(Boolean),
    (value) => value
  );

  const matchingDisruptions = filterDisruptions(disruptions, departureAt, lineIds, areaIds)
    .slice(0, 8)
    .map((disruption) => ({
      id: disruption.id,
      isManifestation: disruption.isManifestation,
      message: disruption.message,
      reason: disruption.reason,
      severity: disruption.severity,
      severityLabel: disruption.severityLabel,
      title: disruption.title
    }));

  const manifestations = disruptions
    .filter((disruption) => {
      const periods = disruption.periods.length > 0
        ? disruption.periods
        : [{ begin: disruption.begin, end: disruption.end }];
      return disruption.isManifestation &&
        periods.some((period) => compactPeriodOverlapsDate(period, departureAt));
    })
    .slice(0, 6)
    .map((disruption) => ({
      id: disruption.id,
      message: disruption.message,
      title: disruption.title
    }));

  return {
    options,
    request: {
      departureAt: departureAt.toISOString(),
      departureAtLabel: formatClock(departureAt),
      from: effectiveFrom,
      fromLabel: effectiveFromLabel,
      to: effectiveTo,
      toLabel: effectiveToLabel
    },
    traffic: {
      disruptions: matchingDisruptions,
      manifestationToday: manifestations.length > 0,
      manifestations
    }
  };
}

async function getSchedules(params) {
  const pathname = "/api/schedules";
  const cacheKey = routeCacheKey(pathname, params);
  const ttl = params.timetable ? timetableCacheTtlMs : liveScheduleCacheTtlMs;
  const cached = scheduleCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      searchParams.set(key, String(value));
    }
  }

  const url = `${upstreamBaseUrl}${pathname}?${searchParams.toString()}`;
  const data = await fetchJson(url).catch((error) => {
    if (String(error.message).includes("no_departures")) {
      return [];
    }
    throw error;
  });

  scheduleCache.set(cacheKey, {
    expiresAt: Date.now() + ttl,
    value: data
  });

  return data;
}

function normalizeTimetableRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      dateTime: parseCompactDateTime(row.date_time),
      directions: Array.isArray(row.directions) ? row.directions : []
    }))
    .filter((row) => row.dateTime instanceof Date && !Number.isNaN(row.dateTime.getTime()))
    .sort((left, right) => left.dateTime - right.dateTime);
}

function normalizeLiveRows(rows, routeId) {
  const routeRow = (Array.isArray(rows) ? rows : []).find((row) => row.route_id === routeId);
  if (!routeRow || !Array.isArray(routeRow.date_times)) {
    return [];
  }

  return routeRow.date_times
    .map((entry) => ({
      dateTime: parseCompactDateTime(entry.date_time),
      dataFreshness: entry.data_freshness || "base_schedule"
    }))
    .filter((entry) => entry.dateTime instanceof Date && !Number.isNaN(entry.dateTime.getTime()))
    .sort((left, right) => left.dateTime - right.dateTime);
}

function pairTimetables(fromRows, toRows, maxTravelMinutes) {
  const pairs = [];
  let destinationIndex = 0;

  for (const fromRow of fromRows) {
    while (
      destinationIndex < toRows.length &&
      toRows[destinationIndex].dateTime <= fromRow.dateTime
    ) {
      destinationIndex += 1;
    }

    let matchIndex = destinationIndex;
    while (matchIndex < toRows.length) {
      const travelMinutes = differenceInMinutes(
        toRows[matchIndex].dateTime,
        fromRow.dateTime
      );

      if (travelMinutes < 1) {
        matchIndex += 1;
        continue;
      }

      if (travelMinutes > maxTravelMinutes) {
        break;
      }

      pairs.push({
        arrivalAt: toRows[matchIndex].dateTime,
        departAt: fromRow.dateTime,
        directions: fromRow.directions,
        travelMinutes
      });
      destinationIndex = matchIndex + 1;
      break;
    }
  }

  return pairs;
}

function buildEstimatedTerminalPairs(fromRows, sourceArea, targetArea, maxTravelMinutes) {
  const estimatedTravelMinutes = Math.max(
    2,
    Math.round(
      distanceBetweenMeters(
        sourceArea.lat,
        sourceArea.lon,
        targetArea.lat,
        targetArea.lon
      ) / estimatedTramMetersPerMinute
    )
  );

  if (estimatedTravelMinutes > maxTravelMinutes) {
    return [];
  }

  return fromRows.map((fromRow) => ({
    arrivalAt: addMinutes(fromRow.dateTime, estimatedTravelMinutes),
    departAt: fromRow.dateTime,
    directions: fromRow.directions,
    travelMinutes: estimatedTravelMinutes
  }));
}

function filterFastestLegsByLine(legs, slackMinutes = 8) {
  const minTravelByLine = new Map();

  for (const leg of legs) {
    const key = leg.lineId || leg.routeId || leg.lineCode;
    if (!key) {
      continue;
    }

    const currentMin = minTravelByLine.get(key) ?? Number.POSITIVE_INFINITY;
    if (leg.travelMinutes < currentMin) {
      minTravelByLine.set(key, leg.travelMinutes);
    }
  }

  return legs.filter((leg) => {
    const key = leg.lineId || leg.routeId || leg.lineCode;
    if (!key || !minTravelByLine.has(key)) {
      return true;
    }

    return leg.travelMinutes <= minTravelByLine.get(key) + slackMinutes;
  });
}

function withLiveDepartures(scheduledLegs, liveRows, selectedDate) {
  const canUseLiveData =
    sameServiceDay(selectedDate, new Date()) &&
    Math.abs(selectedDate.getTime() - Date.now()) <= 2 * 60 * 60 * 1000;

  if (!canUseLiveData || liveRows.length === 0) {
    return scheduledLegs
      .filter((leg) => leg.departAt >= selectedDate)
      .map((leg) => ({
        ...leg,
        delayMinutes: 0,
        freshness: "base_schedule",
        isLive: false
      }));
  }

  const remaining = scheduledLegs.map((leg) => ({ ...leg }));
  const liveLegs = [];

  for (const liveRow of liveRows) {
    if (liveRow.dateTime < selectedDate) {
      continue;
    }

    let bestIndex = -1;
    let bestDiff = Number.POSITIVE_INFINITY;

    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const diff = Math.abs(differenceInMinutes(liveRow.dateTime, candidate.departAt));
      if (diff <= 25 && diff < bestDiff) {
        bestDiff = diff;
        bestIndex = index;
      }
    }

    if (bestIndex === -1) {
      continue;
    }

    const scheduled = remaining.splice(bestIndex, 1)[0];
    const delayMinutes = differenceInMinutes(liveRow.dateTime, scheduled.departAt);
    liveLegs.push({
      ...scheduled,
      arrivalAt: addMinutes(scheduled.arrivalAt, delayMinutes),
      delayMinutes,
      departAt: liveRow.dateTime,
      freshness: liveRow.dataFreshness,
      isLive: true
    });
  }

  const scheduledFallbacks = remaining
    .filter((leg) => leg.departAt >= selectedDate)
    .map((leg) => ({
      ...leg,
      delayMinutes: 0,
      freshness: "base_schedule",
      isLive: false
    }));

  return [...liveLegs, ...scheduledFallbacks]
    .sort((left, right) => left.departAt - right.departAt);
}

async function buildLegOptions({
  maxTravelMinutes,
  mode,
  networkData,
  selectedDate,
  sourceArea,
  targetArea
}) {
  const routeMatcher = mode === "tram" ? isTramRoute : isBusRoute;
  const serviceDate = `${serviceDayKey(selectedDate)}T040000`;
  const pairPromises = [];

  for (const sourceStop of sourceArea.stopPoints) {
    for (const routeId of sourceStop.routeIds) {
      const meta = networkData.routeMetaById.get(routeId);
      if (!routeMatcher(meta)) {
        continue;
      }

      for (const targetStop of targetArea.stopPoints) {
        if (sourceStop.id === targetStop.id || !targetStop.routeIds.includes(routeId)) {
          continue;
        }

        pairPromises.push(
          Promise.all([
            getSchedules({
              count: 20,
              stop: sourceStop.id
            }),
            getSchedules({
              date: serviceDate,
              route: routeId,
              stop: sourceStop.id,
              timetable: "true"
            }),
            getSchedules({
              date: serviceDate,
              route: routeId,
              stop: targetStop.id,
              timetable: "true"
            })
          ]).then(([liveRows, fromTimetableRows, toTimetableRows]) => {
            const normalizedFromRows = normalizeTimetableRows(fromTimetableRows);
            const normalizedToRows = normalizeTimetableRows(toTimetableRows);
            let scheduledPairs = pairTimetables(
              normalizedFromRows,
              normalizedToRows,
              maxTravelMinutes
            );

            // Some tram termini do not expose arrival timetable rows. Fall back to a
            // distance-based travel estimate so we can still surface the useful tram.
            if (
              mode === "tram" &&
              scheduledPairs.length === 0 &&
              normalizedFromRows.length > 0 &&
              normalizedToRows.length === 0
            ) {
              scheduledPairs = buildEstimatedTerminalPairs(
                normalizedFromRows,
                sourceArea,
                targetArea,
                maxTravelMinutes
              );
            }

            return {
              liveRows,
              meta,
              routeId,
              sourceStop,
              scheduledPairs,
              targetStop
            };
          })
        );
      }
    }
  }

  const resolvedPairs = await Promise.all(pairPromises);
  const legs = [];

  for (const pair of resolvedPairs) {
    if (pair.scheduledPairs.length === 0) {
      continue;
    }

    const mergedPairs = withLiveDepartures(
      pair.scheduledPairs.map((scheduledPair) => ({
        ...scheduledPair,
        badge: normalizeLineBadge(pair.meta),
        direction: pair.meta.directionName,
        lineCode: pair.meta.lineCode,
        lineId: pair.meta.lineId,
        lineName: pair.meta.lineName,
        routeId: pair.routeId,
        sourceStop: pair.sourceStop.name,
        sourceStopId: pair.sourceStop.id,
        sourceStopLabel: pair.sourceStop.label,
        targetStop: pair.targetStop.name,
        targetStopId: pair.targetStop.id,
        targetStopLabel: pair.targetStop.label,
        targetStopPoint: pair.targetStop
      })),
      normalizeLiveRows(pair.liveRows, pair.routeId),
      selectedDate
    );

    legs.push(...mergedPairs);
  }

  const filteredLegs = mode === "tram"
    ? filterFastestLegsByLine(legs, 8)
    : legs;
  const uniqueLegs = new Map();
  for (const leg of filteredLegs) {
    const key = [
      leg.routeId,
      leg.sourceStopId,
      leg.targetStopId,
      compactDateTime(leg.departAt)
    ].join("|");
    if (!uniqueLegs.has(key)) {
      uniqueLegs.set(key, leg);
    }
  }

  return [...uniqueLegs.values()]
    .sort((left, right) => left.departAt - right.departAt)
    .slice(0, 16);
}

function formatClock(date) {
  return parisClockFormatter.format(date);
}

function freshnessLabel(freshness) {
  switch (freshness) {
    case "realtime":
      return "Temps reel";
    case "adapted_schedule":
      return "Horaire adapte";
    default:
      return "Horaire theoretique";
  }
}

function summarizeOption(busLeg, tramLeg, selectedDate, origin) {
  const connectionDelay = differenceInMinutes(tramLeg.departAt, busLeg.arrivalAt);
  const totalMinutes = differenceInMinutes(tramLeg.arrivalAt, selectedDate);
  const leaveFromOriginAt = addMinutes(busLeg.departAt, -origin.walkMinutes);
  const leaveInMinutes = Math.max(
    0,
    differenceInMinutes(leaveFromOriginAt, selectedDate)
  );

  return {
    bus: {
      badge: busLeg.badge,
      delayMinutes: busLeg.delayMinutes,
      departAt: busLeg.departAt.toISOString(),
      departAtLabel: formatClock(busLeg.departAt),
      direction: busLeg.direction,
      freshness: busLeg.freshness,
      freshnessLabel: freshnessLabel(busLeg.freshness),
      from: busLeg.sourceStopLabel,
      lineCode: busLeg.lineCode,
      lineId: busLeg.lineId,
      lineName: busLeg.lineName,
      notes: busLeg.directions || [],
      routeId: busLeg.routeId,
      target: busLeg.targetStopLabel,
      travelMinutes: busLeg.travelMinutes
    },
    origin: {
      departureAt: leaveFromOriginAt.toISOString(),
      departureAtLabel: formatClock(leaveFromOriginAt),
      kind: origin.kind,
      label: origin.label,
      pickupAreaLabel: origin.pickupAreaLabel,
      walkDistanceLabel: formatDistance(origin.walkDistanceMeters),
      walkDistanceMeters: origin.walkDistanceMeters,
      walkMinutes: origin.walkMinutes
    },
    leaveInMinutes,
    summary: {
      arrivalAt: tramLeg.arrivalAt.toISOString(),
      arrivalAtLabel: formatClock(tramLeg.arrivalAt),
      connectionMinutes: connectionDelay,
      totalMinutes
    },
    tram: {
      badge: tramLeg.badge,
      delayMinutes: tramLeg.delayMinutes,
      departAt: tramLeg.departAt.toISOString(),
      departAtLabel: formatClock(tramLeg.departAt),
      direction: tramLeg.direction,
      freshness: tramLeg.freshness,
      freshnessLabel: freshnessLabel(tramLeg.freshness),
      from: tramLeg.sourceStopLabel,
      lineCode: tramLeg.lineCode,
      lineId: tramLeg.lineId,
      lineName: tramLeg.lineName,
      notes: tramLeg.directions || [],
      routeId: tramLeg.routeId,
      target: tramLeg.targetStopLabel,
      travelMinutes: tramLeg.travelMinutes
    }
  };
}

function filterDisruptions(disruptions, selectedDate, lineIds, areaIds) {
  const normalizedLineIds = new Set(lineIds.filter(Boolean));
  const normalizedAreaIds = new Set(areaIds.filter(Boolean));

  return disruptions.filter((disruption) => {
    const periods = disruption.periods.length > 0
      ? disruption.periods
      : [{ begin: disruption.begin, end: disruption.end }];

    const appliesOnDate = periods.some((period) => compactPeriodOverlapsDate(period, selectedDate));
    if (!appliesOnDate) {
      return false;
    }

    return disruption.impactedLines.some((lineId) => normalizedLineIds.has(lineId)) ||
      disruption.impactedAreas.some((areaId) => normalizedAreaIds.has(areaId));
  });
}

function resolveOrigin({
  fromAreaId,
  fromLabel,
  fromLat,
  fromLon,
  networkData
}) {
  if (fromAreaId) {
    const sourceArea = networkData.areasById.get(fromAreaId);

    if (!sourceArea) {
      throw new Error("Arret de depart inconnu dans le reseau Fil Bleu.");
    }

    return {
      kind: "area",
      label: sourceArea.label,
      pickupAreaLabel: sourceArea.label,
      readyAtOffsetMinutes: 0,
      sourceArea,
      walkDistanceMeters: 0,
      walkMinutes: 0
    };
  }

  if (fromLat === null || fromLon === null) {
    throw new Error("Renseigne un depart via un arret, une adresse ou ta position.");
  }

  const nearestArea = findNearestArea(
    networkData.areas,
    fromLat,
    fromLon,
    (area) => area.hasBus
  );

  if (!nearestArea || nearestArea.distanceMeters > nearestBusMaxDistanceMeters) {
    throw new Error("Aucun arret bus Fil Bleu n'a ete trouve pres de ce point de depart.");
  }

  const walkMinutes = estimateWalkMinutes(nearestArea.distanceMeters);

  return {
    kind: "location",
    label: fromLabel || "Point de depart",
    pickupAreaLabel: nearestArea.area.label,
    readyAtOffsetMinutes: walkMinutes,
    sourceArea: nearestArea.area,
    walkDistanceMeters: Math.round(nearestArea.distanceMeters),
    walkMinutes
  };
}

async function buildPlan({
  departureAt,
  fromLabel,
  fromLat,
  fromLon,
  fromAreaId,
  networkData,
  toAreaId,
  tramAreaId
}) {
  const origin = resolveOrigin({
    fromAreaId,
    fromLabel,
    fromLat,
    fromLon,
    networkData
  });
  const sourceArea = origin.sourceArea;
  const tramArea = networkData.areasById.get(tramAreaId);
  const destinationArea = networkData.areasById.get(toAreaId);

  if (!sourceArea || !tramArea || !destinationArea) {
    throw new Error("Arret inconnu dans le reseau Fil Bleu.");
  }

  if (sourceArea.id === tramArea.id || tramArea.id === destinationArea.id) {
    throw new Error("Le depart, la correspondance tram et l'arrivee doivent etre differents.");
  }

  const earliestBusReadyAt = addMinutes(departureAt, origin.readyAtOffsetMinutes);

  const [busLegs, tramLegs, disruptions] = await Promise.all([
    buildLegOptions({
      maxTravelMinutes: 120,
      mode: "bus",
      networkData,
      selectedDate: earliestBusReadyAt,
      sourceArea,
      targetArea: tramArea
    }),
    buildLegOptions({
      maxTravelMinutes: 90,
      mode: "tram",
      networkData,
      selectedDate: departureAt,
      sourceArea: tramArea,
      targetArea: destinationArea
    }),
    getDisruptions()
  ]);

  if (busLegs.length === 0) {
    throw new Error("Aucun bus trouve entre votre depart et la correspondance tram.");
  }

  if (tramLegs.length === 0) {
    throw new Error("Aucun tram trouve entre la correspondance et la destination.");
  }

  const options = [];
  for (const busLeg of busLegs) {
    const minTramDeparture = addMinutes(busLeg.arrivalAt, transferWindowMinutes);
    const tramLeg = tramLegs.find((candidate) => candidate.departAt >= minTramDeparture);
    if (!tramLeg) {
      continue;
    }

    options.push(summarizeOption(busLeg, tramLeg, departureAt, origin));
    if (options.length === 2) {
      break;
    }
  }

  if (options.length === 0) {
    throw new Error("Aucune combinaison bus + tram n'a ete trouvee pour cet horaire.");
  }

  const freshOptions = options.filter((option) => optionDepartsSoonEnough(option, departureAt));
  if (freshOptions.length === 0) {
    throw new Error("Aucune combinaison bus + tram exploitable n'a ete trouvee pour cet horaire.");
  }

  const lineIds = freshOptions.flatMap((option) => [option.bus.lineId, option.tram.lineId]);
  const areaIds = [sourceArea.id, tramArea.id, destinationArea.id];
  const matchingDisruptions = filterDisruptions(disruptions, departureAt, lineIds, areaIds)
    .slice(0, 8)
    .map((disruption) => ({
      id: disruption.id,
      isManifestation: disruption.isManifestation,
      message: disruption.message,
      reason: disruption.reason,
      severity: disruption.severity,
      severityLabel: disruption.severityLabel,
      title: disruption.title
    }));

  const manifestations = disruptions
    .filter((disruption) => {
      const periods = disruption.periods.length > 0
        ? disruption.periods
        : [{ begin: disruption.begin, end: disruption.end }];
      return disruption.isManifestation &&
        periods.some((period) => compactPeriodOverlapsDate(period, departureAt));
    })
    .slice(0, 6)
    .map((disruption) => ({
      id: disruption.id,
      message: disruption.message,
      title: disruption.title
    }));

  return {
    departureAt: departureAt.toISOString(),
    departureAtLabel: formatClock(departureAt),
    destinationArea: destinationArea.label,
    fromArea: sourceArea.label,
    origin: {
      kind: origin.kind,
      label: origin.label,
      pickupAreaLabel: origin.pickupAreaLabel,
      walkDistanceLabel: formatDistance(origin.walkDistanceMeters),
      walkDistanceMeters: origin.walkDistanceMeters,
      walkMinutes: origin.walkMinutes
    },
    options: freshOptions,
    traffic: {
      disruptions: matchingDisruptions,
      manifestationToday: manifestations.length > 0,
      manifestations
    },
    tramArea: tramArea.label
  };
}

async function serveStaticFile(response, pathname) {
  const safePath = pathname === "/"
    ? "index.html"
    : normalize(pathname)
        .replace(/^\/+/, "")
        .replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(publicDir, safePath);

  try {
    const content = await readFile(filePath);
    const contentType = mimeTypes[extname(filePath)] || "application/octet-stream";
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentType
    });
    response.end(content);
  } catch {
    textResponse(response, 404, "Not found");
  }
}

const server = createServer(async (request, response) => {
  if (!request.url) {
    textResponse(response, 400, "Bad request");
    return;
  }

  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (requestUrl.pathname === "/api/locations") {
      const query = requestUrl.searchParams.get("q")?.trim() || "";
      const type = requestUrl.searchParams.get("type") === "to" ? "to" : "from";

      if (query.length < 2) {
        jsonResponse(response, 200, {
          suggestions: []
        });
        return;
      }

      const suggestions = await searchLocations(query, type);
      jsonResponse(response, 200, {
        suggestions
      });
      return;
    }

    if (requestUrl.pathname === "/api/reverse-geocode") {
      const lat = parseCoordinate(requestUrl.searchParams.get("lat"));
      const lon = parseCoordinate(requestUrl.searchParams.get("lon"));

      if (lat === null || lon === null) {
        jsonResponse(response, 400, {
          error: "Les coordonnees sont invalides."
        });
        return;
      }

      const feature = await reverseGeocodeCoordinates(lat, lon).catch(() => null);
      const label = feature?.properties?.label || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      const city = feature?.properties?.city || feature?.properties?.context || "";

      jsonResponse(response, 200, {
        suggestion: {
          details: city ? `Position actuelle · ${city}` : "Position actuelle",
          id: `${lon};${lat}`,
          kind: "location",
          label
        }
      });
      return;
    }

    if (requestUrl.pathname === "/api/origin-search") {
      const query = requestUrl.searchParams.get("q")?.trim() || "";
      if (query.length < 2) {
        jsonResponse(response, 200, {
          suggestions: []
        });
        return;
      }

      const networkData = await getNetworkData();
      const suggestions = await searchOriginSuggestions(query, networkData);
      jsonResponse(response, 200, {
        suggestions
      });
      return;
    }

    if (requestUrl.pathname === "/api/bootstrap") {
      const networkData = await getNetworkData();
      jsonResponse(response, 200, {
        areas: networkData.areas.map((area) => ({
          hasBus: area.hasBus,
          hasTram: area.hasTram,
          id: area.id,
          label: area.label,
          lat: area.lat,
          lineCodes: area.lineCodes,
          lon: area.lon,
          name: area.name,
          town: area.town
        })),
        defaultDepartureAt: toLocalInputValue(new Date())
      });
      return;
    }

    if (requestUrl.pathname === "/api/update-status") {
      const force = requestUrl.searchParams.get("force") === "1";
      const status = await getUpdateStatus({ force });
      jsonResponse(response, 200, status);
      return;
    }

    if (requestUrl.pathname === "/api/update-apply") {
      if (request.method !== "POST") {
        jsonResponse(response, 405, {
          error: "Methode non autorisee."
        });
        return;
      }

      if (autoUpdateEnabled) {
        jsonResponse(response, 409, {
          error: "La mise a jour se lance automatiquement sur cette installation."
        });
        return;
      }

      const status = await getUpdateStatus({ force: true });
      if (!status.enabled) {
        jsonResponse(response, 400, {
          error: status.error || "La mise a jour automatique n'est pas activee sur cette installation."
        });
        return;
      }

      if (updateInProgress) {
        jsonResponse(response, 202, {
          message: "Une mise a jour est deja en cours.",
          started: true
        });
        return;
      }

      if (!status.updateAvailable) {
        jsonResponse(response, 400, {
          error: "Aucune nouvelle mise a jour n'a ete detectee."
        });
        return;
      }

      if (!(await isExecutableFile(updateApplyScriptPath))) {
        jsonResponse(response, 500, {
          error: "Le script de mise a jour est introuvable."
        });
        return;
      }

      triggerUpdateProcess();
      jsonResponse(response, 202, {
        message: "Mise a jour lancee.",
        started: true
      });
      return;
    }

    if (requestUrl.pathname === "/api/plan") {
      const from = requestUrl.searchParams.get("from");
      const to = requestUrl.searchParams.get("to");
      const fromLabel = requestUrl.searchParams.get("fromLabel") || "Depart";
      const toLabel = requestUrl.searchParams.get("toLabel") || "Arrivee";
      const departureAtRaw = requestUrl.searchParams.get("departureAt");

      if (from && to) {
        if (!departureAtRaw) {
          jsonResponse(response, 400, {
            error: "Les champs depart, arrivee et heure sont obligatoires."
          });
          return;
        }

        const departureAt = new Date(departureAtRaw);
        if (Number.isNaN(departureAt.getTime())) {
          jsonResponse(response, 400, {
            error: "Le format de date est invalide."
          });
          return;
        }

        const plan = await buildDirectPlan({
          departureAt,
          from,
          fromLabel,
          to,
          toLabel
        });

        jsonResponse(response, 200, plan);
        return;
      }

      const fromAreaId = requestUrl.searchParams.get("fromAreaId");
      const legacyFromLabel = requestUrl.searchParams.get("fromLabel");
      const fromLat = parseCoordinate(requestUrl.searchParams.get("fromLat"));
      const fromLon = parseCoordinate(requestUrl.searchParams.get("fromLon"));
      const tramAreaId = requestUrl.searchParams.get("tramAreaId");
      const toAreaId = requestUrl.searchParams.get("toAreaId");

      if (
        (!fromAreaId && (fromLat === null || fromLon === null)) ||
        !tramAreaId ||
        !toAreaId ||
        !departureAtRaw
      ) {
        jsonResponse(response, 400, {
          error: "Les champs depart, correspondance tram, destination et heure sont obligatoires."
        });
        return;
      }

      const departureAt = new Date(departureAtRaw);
      if (Number.isNaN(departureAt.getTime())) {
        jsonResponse(response, 400, {
          error: "Le format de date est invalide."
        });
        return;
      }

      const networkData = await getNetworkData();
      const plan = await buildPlan({
        departureAt,
        fromLabel: legacyFromLabel,
        fromLat,
        fromLon,
        fromAreaId,
        networkData,
        toAreaId,
        tramAreaId
      });

      jsonResponse(response, 200, plan);
      return;
    }

    await serveStaticFile(response, requestUrl.pathname);
  } catch (error) {
    jsonResponse(response, 500, {
      error: error instanceof Error ? error.message : "Erreur interne."
    });
  }
});

function listenOnPort(serverInstance, candidatePort) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      serverInstance.off("listening", handleListening);
      reject(error);
    };

    const handleListening = () => {
      serverInstance.off("error", handleError);
      resolve(candidatePort);
    };

    serverInstance.once("error", handleError);
    serverInstance.once("listening", handleListening);
    serverInstance.listen(candidatePort, host);
  });
}

async function startServer() {
  const activePort = await listenOnPort(server, preferredPort);
  console.log(`Affiche Fil Bleu disponible sur http://${host}:${activePort}`);
  scheduleAutomaticUpdates();
}

startServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
