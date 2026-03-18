const STORAGE_CONFIG_KEY = "filbleu-display-config-v3";
const STORAGE_FAVORITES_KEY = "filbleu-display-favorites-v2";
const STORAGE_ACTIVE_FAVORITE_KEY = "filbleu-display-active-favorite-v2";
const STORAGE_THEME_KEY = "filbleu-display-theme-v1";
const STORAGE_WAKE_KEY = "filbleu-display-wake-until-v3";
const ACTIVE_START_HOUR = 7;
const ACTIVE_END_HOUR = 18;
const AUTO_REFRESH_MINUTES = 1;
const MANUAL_WAKE_MINUTES = 15;
const FAVORITE_SLOTS = 3;
const INITIAL_VISIBLE_RESULTS = 2;
const RESULTS_BATCH_SIZE = 2;
const MAX_VISIBLE_RESULTS = 6;
const UPDATE_STATUS_REFRESH_INTERVAL_MS = 30_000;

const state = {
  currentNow: new Date(),
  currentPlan: null,
  favorites: [],
  formSelection: {
    from: null,
    to: null
  },
  activeFavoriteIndex: 0,
  editingFavoriteIndex: 0,
  isEditing: false,
  lastError: "",
  lastRefreshAt: null,
  manualWakeUntil: null,
  refreshTimerId: 0,
  refreshing: false,
  savedConfig: null,
  infoOpen: false,
  tickTimerId: 0,
  theme: "light",
  toastTimerId: 0,
  updateStatusTimerId: 0,
  updateStatus: null,
  visibleResultsCount: INITIAL_VISIBLE_RESULTS
};

const elements = {
  awakeView: document.querySelector("#awake-view"),
  boardFeedback: document.querySelector("#board-feedback"),
  cancelSetupButton: document.querySelector("#cancel-setup-button"),
  closeSetupButton: document.querySelector("#close-setup-button"),
  dashboard: document.querySelector("#dashboard"),
  feedback: document.querySelector("#form-feedback"),
  favoriteSlot: document.querySelector("#favorite-slot"),
  favoritesBar: document.querySelector("#favorites-bar"),
  form: document.querySelector("#planner-form"),
  geolocateButton: document.querySelector("#geolocate-button"),
  infoBubble: document.querySelector("#info-bubble"),
  infoButton: document.querySelector("#info-button"),
  infoPrimary: document.querySelector("#info-primary"),
  infoSecondary: document.querySelector("#info-secondary"),
  moreResultsButton: document.querySelector("#more-results-button"),
  originInput: document.querySelector("#from-input"),
  originSuggestions: document.querySelector("#from-suggestions"),
  results: document.querySelector("#results"),
  routeChip: document.querySelector("#route-chip"),
  settingsButton: document.querySelector("#settings-button"),
  setupCopy: document.querySelector("#setup-copy"),
  setupShell: document.querySelector("#setup-shell"),
  setupTitle: document.querySelector("#setup-title"),
  sleepMessage: document.querySelector("#sleep-message"),
  sleepView: document.querySelector("#sleep-view"),
  submitButton: document.querySelector("#submit-button"),
  themeToggleButton: document.querySelector("#theme-toggle-button"),
  topbar: document.querySelector("#topbar"),
  swapButton: document.querySelector("#swap-button"),
  toast: document.querySelector("#toast"),
  toInput: document.querySelector("#to-input"),
  toSuggestions: document.querySelector("#to-suggestions"),
  traffic: document.querySelector("#traffic"),
  wallClock: document.querySelector("#wall-clock"),
  wakeButton: document.querySelector("#wake-button")
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function safeHexColor(value, fallback) {
  return /^[0-9a-f]{3,8}$/i.test(String(value || "")) ? value : fallback;
}

function cleanDisplayLabel(value) {
  const normalized = String(value || "")
    .replace(/\s+\(Tours\)$/i, "")
    .trim();
  return normalized || String(value || "");
}

function copySelection(item) {
  if (!item?.id || !item?.label) {
    return null;
  }

  return {
    details: item.details || "",
    id: item.id,
    kind: item.kind || "place",
    label: cleanDisplayLabel(item.label)
  };
}

function emptyFavorites() {
  return Array.from({ length: FAVORITE_SLOTS }, () => null);
}

function normalizeFavoriteIndex(value) {
  const index = Number.parseInt(String(value ?? "0"), 10);
  if (!Number.isInteger(index) || index < 0 || index >= FAVORITE_SLOTS) {
    return 0;
  }
  return index;
}

function hasFavoriteConfigs(favorites) {
  return favorites.some((config) => Boolean(config?.from?.id && config?.to?.id));
}

function normalizeTheme(value) {
  return value === "dark" ? "dark" : "light";
}

function preferredTheme() {
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

function formatClock(date) {
  return date.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDateTime(date) {
  return date.toLocaleString("fr-FR", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit"
  });
}

function formatInfoMoment(date) {
  return date.toLocaleString("fr-FR", {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatRelativeMinutes(value) {
  if (value <= 0) {
    return "Maintenant";
  }

  if (value === 1) {
    return "Dans 1 min";
  }

  return `Dans ${value} min`;
}

function formatTransferCount(value) {
  if (value <= 0) {
    return "Direct";
  }

  if (value === 1) {
    return "1 correspondance";
  }

  return `${value} correspondances`;
}

function detailSummaryLabel(option) {
  const parts = [];

  if (option.walkingMinutes > 0) {
    parts.push(`${option.walkingMinutes} min a pied`);
  }

  if (option.waitingMinutes > 0) {
    parts.push(`${option.waitingMinutes} min d'attente`);
  }

  return parts.length > 0
    ? `Voir le detail · ${parts.join(" · ")}`
    : "Voir le detail";
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function clearSuggestions(container) {
  container.hidden = true;
  container.innerHTML = "";
}

function setFeedback(message, tone = "muted") {
  elements.feedback.textContent = message;
  elements.feedback.dataset.tone = tone;
}

function setBoardFeedback(message, tone = "muted") {
  elements.boardFeedback.textContent = message;
  elements.boardFeedback.dataset.tone = tone;
}

function setInfoOpen(isOpen) {
  state.infoOpen = isOpen;
  elements.infoBubble.dataset.open = isOpen ? "true" : "false";
  elements.infoButton.setAttribute("aria-expanded", String(isOpen));
}

function hideToast() {
  window.clearTimeout(state.toastTimerId);
  elements.toast.hidden = true;
  elements.toast.textContent = "";
  delete elements.toast.dataset.tone;
}

function showToast(message, tone = "success", durationMs = 8_000) {
  window.clearTimeout(state.toastTimerId);
  elements.toast.textContent = message;
  elements.toast.dataset.tone = tone;
  elements.toast.hidden = false;
  state.toastTimerId = window.setTimeout(() => {
    hideToast();
  }, durationMs);
}

function resetVisibleResults() {
  state.visibleResultsCount = INITIAL_VISIBLE_RESULTS;
}

function setFormLoading(isLoading) {
  elements.submitButton.disabled = isLoading;
  elements.submitButton.textContent = isLoading
    ? "Enregistrement..."
    : "Enregistrer ce trajet";
}

function suggestionKindLabel(kind) {
  switch (kind) {
    case "stop":
      return "Arret";
    case "address":
      return "Adresse";
    case "location":
      return "Position";
    default:
      return "Lieu";
  }
}

function renderSuggestion(item) {
  return `
    <span class="suggestion-kind">${escapeHtml(suggestionKindLabel(item.kind))}</span>
    <strong class="suggestion-title">${escapeHtml(item.label)}</strong>
    <span class="suggestion-meta">${escapeHtml(item.details || "")}</span>
  `;
}

async function requestSuggestions(query, type, signal) {
  const url = new URL("/api/locations", window.location.origin);
  url.searchParams.set("q", query);
  url.searchParams.set("type", type);

  const response = await fetch(url, { signal });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Recherche indisponible.");
  }

  return payload.suggestions || [];
}

function attachAutocomplete({
  emptyLabel,
  input,
  key,
  suggestions,
  type
}) {
  let activeController = null;
  let debounceId = 0;
  let lastRendered = [];

  function setSelection(item) {
    const selection = copySelection(item);
    state.formSelection[key] = selection;
    input.value = selection?.label || "";
    clearSuggestions(suggestions);
  }

  function renderItems(items) {
    lastRendered = items;

    if (items.length === 0) {
      suggestions.hidden = false;
      suggestions.innerHTML = `
        <div class="suggestion">
          <strong class="suggestion-title">Aucun resultat</strong>
          <span class="suggestion-meta">${escapeHtml(emptyLabel)}</span>
        </div>
      `;
      return;
    }

    suggestions.hidden = false;
    suggestions.innerHTML = items
      .map((item, index) => {
        return `
          <button class="suggestion" type="button" data-index="${index}">
            ${renderSuggestion(item)}
          </button>
        `;
      })
      .join("");
  }

  async function renderMatches(query) {
    if (activeController) {
      activeController.abort();
    }

    activeController = new AbortController();
    suggestions.hidden = false;
    suggestions.innerHTML = `
      <div class="suggestion">
        <strong class="suggestion-title">Recherche en cours</strong>
        <span class="suggestion-meta">Je cherche dans les lieux et arrets Fil Bleu</span>
      </div>
    `;

    try {
      const items = await requestSuggestions(query, type, activeController.signal);
      renderItems(items);
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }

      suggestions.hidden = false;
      suggestions.innerHTML = `
        <div class="suggestion">
          <strong class="suggestion-title">Recherche indisponible</strong>
          <span class="suggestion-meta">Impossible de remonter les suggestions pour le moment</span>
        </div>
      `;
    }
  }

  async function ensureSelection() {
    const rawValue = input.value.trim();
    const current = state.formSelection[key];

    if (current && current.label === rawValue) {
      return current;
    }

    if (rawValue.length < 2) {
      throw new Error(type === "from" ? "Renseigne un depart." : "Renseigne une arrivee.");
    }

    const items = await requestSuggestions(rawValue, type);
    if (items.length === 0) {
      throw new Error(
        type === "from"
          ? "Je n'ai pas trouve ce depart."
          : "Je n'ai pas trouve cette arrivee."
      );
    }

    setSelection(items[0]);
    return state.formSelection[key];
  }

  function clearSelection() {
    state.formSelection[key] = null;
    input.value = "";
    clearSuggestions(suggestions);
  }

  input.addEventListener("input", () => {
    state.formSelection[key] = null;
    const query = input.value.trim();

    window.clearTimeout(debounceId);
    if (query.length < 2) {
      clearSuggestions(suggestions);
      return;
    }

    debounceId = window.setTimeout(() => {
      renderMatches(query);
    }, 180);
  });

  input.addEventListener("focus", () => {
    const query = input.value.trim();
    if (query.length >= 2) {
      renderMatches(query);
    }
  });

  input.addEventListener("blur", () => {
    window.setTimeout(() => clearSuggestions(suggestions), 120);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !suggestions.hidden && lastRendered.length > 0) {
      event.preventDefault();
      setSelection(lastRendered[0]);
    }
  });

  suggestions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-index]");
    if (!button) {
      return;
    }

    const item = lastRendered[Number.parseInt(button.dataset.index, 10)];
    if (item) {
      setSelection(item);
    }
  });

  return {
    clearSelection,
    ensureSelection,
    setSelection
  };
}

function parseStoredDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function loadLegacyConfig() {
  try {
    const raw = window.localStorage.getItem(STORAGE_CONFIG_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (!parsed?.from?.id || !parsed?.to?.id) {
      return null;
    }

    return {
      from: copySelection(parsed.from),
      to: copySelection(parsed.to)
    };
  } catch {
    return null;
  }
}

function loadStoredFavorites() {
  try {
    const raw = window.localStorage.getItem(STORAGE_FAVORITES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const slots = emptyFavorites();
      for (let index = 0; index < FAVORITE_SLOTS; index += 1) {
        const entry = parsed?.[index];
        slots[index] = entry?.from?.id && entry?.to?.id
          ? {
              from: copySelection(entry.from),
              to: copySelection(entry.to)
            }
          : null;
      }
      return slots;
    }
  } catch {
    // Ignore invalid local storage entries.
  }

  const legacyConfig = loadLegacyConfig();
  const slots = emptyFavorites();
  if (legacyConfig) {
    slots[0] = legacyConfig;
  }
  return slots;
}

function persistConfig(config) {
  try {
    if (!config) {
      window.localStorage.removeItem(STORAGE_CONFIG_KEY);
      return;
    }

    window.localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Ignore local storage failures and keep the session config in memory.
  }
}

function persistFavorites(favorites) {
  try {
    window.localStorage.setItem(STORAGE_FAVORITES_KEY, JSON.stringify(favorites));
  } catch {
    // Ignore local storage failures and keep the session favorites in memory.
  }
}

function loadActiveFavoriteIndex() {
  try {
    return normalizeFavoriteIndex(window.localStorage.getItem(STORAGE_ACTIVE_FAVORITE_KEY));
  } catch {
    return 0;
  }
}

function persistActiveFavoriteIndex(index) {
  try {
    window.localStorage.setItem(
      STORAGE_ACTIVE_FAVORITE_KEY,
      String(normalizeFavoriteIndex(index))
    );
  } catch {
    // Ignore local storage failures and keep the session state in memory.
  }
}

function loadStoredTheme() {
  try {
    const raw = window.localStorage.getItem(STORAGE_THEME_KEY);
    return raw ? normalizeTheme(raw) : null;
  } catch {
    return null;
  }
}

function persistTheme(theme) {
  try {
    window.localStorage.setItem(STORAGE_THEME_KEY, normalizeTheme(theme));
  } catch {
    // Ignore local storage failures and keep the session theme in memory.
  }
}

function loadStoredWakeUntil() {
  try {
    return parseStoredDate(window.localStorage.getItem(STORAGE_WAKE_KEY));
  } catch {
    return null;
  }
}

function persistWakeUntil(date) {
  try {
    if (!date) {
      window.localStorage.removeItem(STORAGE_WAKE_KEY);
      return;
    }

    window.localStorage.setItem(STORAGE_WAKE_KEY, date.toISOString());
  } catch {
    // Ignore local storage failures and keep the session state in memory.
  }
}

function clearManualWake() {
  state.manualWakeUntil = null;
  persistWakeUntil(null);
}

function syncResolvedConfigFromPlan(plan, fallbackConfig) {
  const resolvedFromId = plan?.request?.from;
  const resolvedToId = plan?.request?.to;
  if (!resolvedFromId || !resolvedToId || !fallbackConfig?.from || !fallbackConfig?.to) {
    return;
  }

  const nextConfig = {
    from: {
      ...fallbackConfig.from,
      id: resolvedFromId,
      kind: String(resolvedFromId).startsWith("stop_area:") ? "stop" : fallbackConfig.from.kind,
      label: cleanDisplayLabel(plan.request?.fromLabel || fallbackConfig.from.label)
    },
    to: {
      ...fallbackConfig.to,
      id: resolvedToId,
      kind: String(resolvedToId).startsWith("stop_area:") ? "stop" : fallbackConfig.to.kind,
      label: cleanDisplayLabel(plan.request?.toLabel || fallbackConfig.to.label)
    }
  };

  if (configKey(nextConfig) === configKey(state.savedConfig)) {
    return;
  }

  state.savedConfig = nextConfig;
  state.favorites[state.activeFavoriteIndex] = {
    from: copySelection(nextConfig.from),
    to: copySelection(nextConfig.to)
  };
  persistFavorites(state.favorites);
  persistConfig(state.savedConfig);
  populateFormFromConfig(state.savedConfig);
  renderFavorites();
}

function routeSummary(config) {
  return `${cleanDisplayLabel(config.from.label)} -> ${cleanDisplayLabel(config.to.label)}`;
}

function configKey(config) {
  return config?.from?.id && config?.to?.id
    ? `${config.from.id}->${config.to.id}`
    : "";
}

function favoriteLabel(index) {
  return `Favori ${index + 1}`;
}

function renderFavorites() {
  const hasAny = hasFavoriteConfigs(state.favorites);
  elements.favoritesBar.hidden = !hasAny;

  if (!hasAny) {
    elements.favoritesBar.innerHTML = "";
    return;
  }

  elements.favoritesBar.innerHTML = state.favorites
    .map((config, index) => {
      const isActive = index === state.activeFavoriteIndex;
      const label = config ? routeSummary(config) : "Libre";
      return `
        <button
          class="favorite-chip"
          type="button"
          data-favorite-index="${index}"
          data-active="${isActive ? "true" : "false"}"
          data-empty="${config ? "false" : "true"}"
        >
          <span class="favorite-chip-index">${favoriteLabel(index)}</span>
          <span class="favorite-chip-route">${escapeHtml(label)}</span>
        </button>
      `;
    })
    .join("");
}

function isWithinAutoHours(date) {
  return date.getHours() >= ACTIVE_START_HOUR && date.getHours() < ACTIVE_END_HOUR;
}

function isManualWakeActive(date) {
  return state.manualWakeUntil instanceof Date && state.manualWakeUntil > date;
}

function isAwake(date) {
  return isWithinAutoHours(date) || isManualWakeActive(date);
}

function getNextAutoWakeAt(date) {
  const nextWake = new Date(date);
  nextWake.setSeconds(0, 0);

  if (nextWake.getHours() < ACTIVE_START_HOUR) {
    nextWake.setHours(ACTIVE_START_HOUR, 0, 0, 0);
    return nextWake;
  }

  nextWake.setDate(nextWake.getDate() + 1);
  nextWake.setHours(ACTIVE_START_HOUR, 0, 0, 0);
  return nextWake;
}

function getTodaySleepAt(date) {
  const sleepAt = new Date(date);
  sleepAt.setHours(ACTIVE_END_HOUR, 0, 0, 0);
  return sleepAt;
}

function getNextRefreshBoundary(date) {
  const next = new Date(date);
  next.setSeconds(0, 0);

  const minutes = next.getMinutes();
  const remainder = minutes % AUTO_REFRESH_MINUTES;
  const delta = remainder === 0 ? AUTO_REFRESH_MINUTES : AUTO_REFRESH_MINUTES - remainder;
  next.setMinutes(minutes + delta);
  return next;
}

function syncWakeState(now = new Date()) {
  if (state.manualWakeUntil && state.manualWakeUntil <= now) {
    clearManualWake();
  }
}

function computeNextEvent(now = new Date()) {
  syncWakeState(now);

  if (!state.savedConfig) {
    return null;
  }

  if (isWithinAutoHours(now)) {
    const sleepAt = getTodaySleepAt(now);
    const nextRefreshAt = getNextRefreshBoundary(now);
    if (nextRefreshAt < sleepAt) {
      return {
        at: nextRefreshAt,
        type: "refresh"
      };
    }

    return {
      at: sleepAt,
      type: "sleep"
    };
  }

  if (isManualWakeActive(now)) {
    const nextRefreshAt = getNextRefreshBoundary(now);
    if (nextRefreshAt < state.manualWakeUntil) {
      return {
        at: nextRefreshAt,
        type: "refresh"
      };
    }

    return {
      at: state.manualWakeUntil,
      type: "sleep"
    };
  }

  return {
    at: getNextAutoWakeAt(now),
    type: "wake"
  };
}

function modeChipData(now) {
  if (isWithinAutoHours(now)) {
    return {
      label: "Actif maintenant",
      tone: "live"
    };
  }

  if (isManualWakeActive(now)) {
    return {
      label: `Reveillee jusqu'a ${formatClock(state.manualWakeUntil)}`,
      tone: "manual"
    };
  }

  return {
    label: "En veille",
    tone: "sleep"
  };
}

function describeInfoSecondary(nextEvent) {
  if (state.lastError) {
    return `Derniere erreur : ${state.lastError}`;
  }

  if (!nextEvent) {
    return "L'affiche se mettra a jour automatiquement.";
  }

  switch (nextEvent.type) {
    case "refresh":
      return `Prochaine actualisation vers ${formatClock(nextEvent.at)}.`;
    case "sleep":
      return `Veille automatique a ${formatClock(nextEvent.at)}.`;
    case "wake":
      return `Reveil auto ${formatInfoMoment(nextEvent.at)}.`;
    default:
      return "L'affiche se mettra a jour automatiquement.";
  }
}

function renderLinePills(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return '<span class="summary-chip">Marche</span>';
  }

  return lines
    .map((line) => {
      const background = safeHexColor(line.badge?.color, "103c63");
      const textColor = safeHexColor(line.badge?.textColor, "ffffff");

      return `
        <span class="route-pill">
          <span
            class="line-pill"
            style="background:#${background};color:#${textColor};"
          >
            ${escapeHtml(line.lineCode)}
          </span>
          <span>${escapeHtml(line.modeLabel)}</span>
        </span>
      `;
    })
    .join("");
}

function sectionMeta(section) {
  if (section.from && section.to && section.from !== section.to) {
    return `${section.departureAtLabel} ${section.from} -> ${section.arrivalAtLabel} ${section.to}`;
  }

  if (section.from) {
    return `${section.departureAtLabel} ${section.from}`;
  }

  return `${section.departureAtLabel} -> ${section.arrivalAtLabel}`;
}

function renderStep(section) {
  if (section.kind === "public_transport") {
    const background = safeHexColor(section.badge?.color, "103c63");
    const textColor = safeHexColor(section.badge?.textColor, "ffffff");

    return `
      <article class="step-card step-card-public">
        <div class="step-top">
          <div class="step-heading">
            <span
              class="line-pill"
              style="background:#${background};color:#${textColor};"
            >
              ${escapeHtml(section.lineCode)}
            </span>
            <strong>${escapeHtml(section.modeLabel)} vers ${escapeHtml(section.direction)}</strong>
          </div>
          <span class="summary-chip">${escapeHtml(section.durationLabel)}</span>
        </div>
        <p class="step-meta">${escapeHtml(sectionMeta(section))}</p>
        ${section.note ? `<p class="step-note">${escapeHtml(section.note)}</p>` : ""}
      </article>
    `;
  }

  return `
    <article class="step-card">
      <div class="step-top">
        <strong>${escapeHtml(section.label)}</strong>
        <span class="summary-chip">${escapeHtml(section.durationLabel)}</span>
      </div>
      <p class="step-meta">${escapeHtml(sectionMeta(section))}</p>
    </article>
  `;
}

function displayResults(plan) {
  if (!Array.isArray(plan.options) || plan.options.length === 0) {
    elements.results.innerHTML = `
      <article class="placeholder-card">
        <p>Aucun trajet n'a ete trouve pour cette recherche.</p>
      </article>
    `;
    elements.moreResultsButton.hidden = true;
    return;
  }

  const totalOptions = Math.min(plan.options.length, MAX_VISIBLE_RESULTS);
  const visibleCount = Math.min(state.visibleResultsCount, totalOptions);
  elements.results.innerHTML = plan.options
    .slice(0, visibleCount)
    .map((option, index) => {
      const extraChips = [
        `<span class="summary-chip">${escapeHtml(`Temps total ${option.durationLabel}`)}</span>`,
        `<span class="summary-chip">${escapeHtml(formatTransferCount(option.transferCount))}</span>`
      ];

      return `
        <article class="result-card" style="animation-delay:${index * 90}ms;">
          <div class="result-topline">
            <span class="mode-pill">${escapeHtml(option.transportLabel || "Transport")}</span>
          </div>

          <div class="result-head">
            <div>
              <div class="result-status">${escapeHtml(formatRelativeMinutes(option.leaveInMinutes))}</div>
              <p class="route-caption">${escapeHtml(option.routeLabel || "")}</p>
            </div>
            <div class="result-arrival">
              <strong>${escapeHtml(option.arrivalAtLabel)}</strong>
              <span>Arrivee finale</span>
            </div>
          </div>

          <div class="result-times">
            <div class="time-box">
              <span>Depart</span>
              <strong>${escapeHtml(option.departureAtLabel)}</strong>
            </div>
            <div class="time-box">
              <span>Trajet</span>
              <strong>${escapeHtml(option.durationLabel)}</strong>
            </div>
          </div>

          <div class="result-summary">
            ${extraChips.join("")}
          </div>

          <div class="result-lines">
            <span class="result-lines-label">Lignes</span>
            <div class="route-pills">
              ${renderLinePills(option.lines)}
            </div>
          </div>

          <details class="result-details">
            <summary class="result-details-toggle">${escapeHtml(detailSummaryLabel(option))}</summary>
            <div class="steps-list">
              ${option.sections.map(renderStep).join("")}
            </div>
          </details>
        </article>
      `;
    })
    .join("");
  elements.moreResultsButton.hidden = visibleCount >= totalOptions || totalOptions <= INITIAL_VISIBLE_RESULTS;
}

function displayTraffic(plan) {
  const fromLabel = escapeHtml(plan.request?.fromLabel || state.savedConfig?.from?.label || "Depart");
  const toLabel = escapeHtml(plan.request?.toLabel || state.savedConfig?.to?.label || "Arrivee");

  const manifestationsMarkup = plan.traffic.manifestations.length > 0
    ? plan.traffic.manifestations
        .map((manifestation) => {
          return `
            <article class="traffic-item">
              <span class="traffic-chip danger">Manifestation</span>
              <strong>${escapeHtml(manifestation.title)}</strong>
              <p>${escapeHtml(manifestation.message)}</p>
            </article>
          `;
        })
        .join("")
    : "";

  const disruptionsMarkup = plan.traffic.disruptions.length > 0
    ? plan.traffic.disruptions
        .map((disruption) => {
          const chipClass = disruption.severity === "blocking" ? "danger" : "";
          return `
            <article class="traffic-item">
              <span class="traffic-chip ${chipClass}">${escapeHtml(disruption.severityLabel)}</span>
              <strong>${escapeHtml(disruption.title)}</strong>
              <p>${escapeHtml(disruption.message)}</p>
            </article>
          `;
        })
        .join("")
    : `
      <article class="traffic-item">
        <strong>Pas d'alerte ciblee sur ce trajet.</strong>
        <p>Aucune interruption ou retard majeur n'a ete relie aux lignes proposees.</p>
      </article>
    `;

  elements.traffic.innerHTML = `
    <div class="traffic-head">
      <div>
        <strong>${fromLabel} -> ${toLabel}</strong>
      </div>
      <span class="traffic-chip ${plan.traffic.manifestationToday ? "danger" : ""}">
        ${plan.traffic.manifestationToday ? "Manifestations detectees" : "Reseau surveille"}
      </span>
    </div>
    <div class="traffic-list">
      ${manifestationsMarkup}
      ${disruptionsMarkup}
    </div>
  `;
}

function showResultsPlaceholder(message) {
  elements.results.innerHTML = `
    <article class="placeholder-card">
      <p>${escapeHtml(message)}</p>
    </article>
  `;
  elements.moreResultsButton.hidden = true;
}

function showTrafficPlaceholder(message) {
  elements.traffic.innerHTML = `
    <article class="placeholder-card">
      <p>${escapeHtml(message)}</p>
    </article>
  `;
}

function populateFormFromConfig(config) {
  originAutocomplete.setSelection(config?.from || null);
  destinationAutocomplete.setSelection(config?.to || null);
}

function clearFormSelections() {
  originAutocomplete.clearSelection();
  destinationAutocomplete.clearSelection();
}

function openSetup(targetIndex = state.activeFavoriteIndex) {
  state.editingFavoriteIndex = normalizeFavoriteIndex(targetIndex);
  const config = state.favorites[state.editingFavoriteIndex] || state.savedConfig;
  if (config) {
    populateFormFromConfig(config);
  } else {
    clearFormSelections();
  }

  elements.favoriteSlot.value = String(state.editingFavoriteIndex);
  state.isEditing = true;
  setFeedback("");
  renderApp();
}

function closeSetup() {
  if (!state.savedConfig) {
    return;
  }

  populateFormFromConfig(state.savedConfig);
  elements.favoriteSlot.value = String(state.activeFavoriteIndex);
  setFeedback("");
  state.isEditing = false;
  clearSuggestions(elements.originSuggestions);
  clearSuggestions(elements.toSuggestions);
  renderApp();
}

async function activateFavorite(index) {
  const favoriteIndex = normalizeFavoriteIndex(index);
  const config = state.favorites[favoriteIndex];

  if (!config) {
    openSetup(favoriteIndex);
    return;
  }

  state.activeFavoriteIndex = favoriteIndex;
  state.editingFavoriteIndex = favoriteIndex;
  persistActiveFavoriteIndex(favoriteIndex);
  state.savedConfig = {
    from: copySelection(config.from),
    to: copySelection(config.to)
  };
  persistConfig(state.savedConfig);
  populateFormFromConfig(state.savedConfig);
  state.isEditing = false;
  state.currentPlan = null;
  resetVisibleResults();
  state.lastError = "";
  renderFavorites();
  renderApp();
  showToast(`${favoriteLabel(favoriteIndex)} charge.`, "success", 4000);

  if (isAwake(new Date())) {
    await refreshPlan();
  }
  scheduleRefreshLoop();
}

async function requestReverseGeocode(lat, lon) {
  const url = new URL("/api/reverse-geocode", window.location.origin);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));

  const response = await fetch(url);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Impossible de retrouver l'adresse.");
  }

  return payload.suggestion || null;
}

async function requestUpdateStatus({ force = false } = {}) {
  const url = new URL("/api/update-status", window.location.origin);
  if (force) {
    url.searchParams.set("force", "1");
  }

  const response = await fetch(url, {
    cache: "no-store"
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Verification de mise a jour indisponible.");
  }

  return payload;
}

async function refreshUpdateStatus({ force = false } = {}) {
  const previousStatus = state.updateStatus
    ? { ...state.updateStatus }
    : null;

  try {
    const status = await requestUpdateStatus({ force });
    state.updateStatus = status;
    if (
      previousStatus &&
      previousStatus.currentVersion &&
      status.enabled &&
      status.currentVersion &&
      status.currentVersion !== previousStatus.currentVersion
    ) {
      window.location.reload();
      return;
    }
  } catch {
    state.updateStatus = null;
  } finally {
    renderApp();
  }
}

function armManualWake() {
  state.manualWakeUntil = addMinutes(new Date(), MANUAL_WAKE_MINUTES);
  persistWakeUntil(state.manualWakeUntil);
}

async function refreshPlan() {
  if (!state.savedConfig) {
    return;
  }

  if (state.refreshing) {
    return;
  }

  state.refreshing = true;
  state.lastError = "";
  renderApp();

  try {
    const requestedAt = new Date();
    const requestConfig = {
      from: copySelection(state.savedConfig.from),
      to: copySelection(state.savedConfig.to)
    };
    const requestKey = configKey(requestConfig);
    const url = new URL("/api/plan", window.location.origin);
    url.searchParams.set("from", requestConfig.from.id);
    url.searchParams.set("fromLabel", requestConfig.from.label);
    url.searchParams.set("to", requestConfig.to.id);
    url.searchParams.set("toLabel", requestConfig.to.label);
    url.searchParams.set("departureAt", requestedAt.toISOString());

    const response = await fetch(url);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Le calcul n'a pas abouti.");
    }

    if (requestKey !== configKey(state.savedConfig)) {
      return;
    }

    syncResolvedConfigFromPlan(payload, requestConfig);
    state.currentPlan = payload;
    resetVisibleResults();
    state.lastRefreshAt = parseStoredDate(payload.request?.departureAt) || requestedAt;
    displayResults(payload);
    displayTraffic(payload);
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : "Erreur inconnue.";

    if (!state.currentPlan) {
      showResultsPlaceholder(state.lastError);
      showTrafficPlaceholder("Aucune alerte reseau exploitable pour cette recherche.");
    }
  } finally {
    state.refreshing = false;
    renderApp();
  }
}

function scheduleRefreshLoop() {
  window.clearTimeout(state.refreshTimerId);

  if (!state.savedConfig) {
    return;
  }

  const now = new Date();
  syncWakeState(now);
  const nextEvent = computeNextEvent(now);
  if (!nextEvent) {
    return;
  }

  const delay = Math.max(1000, nextEvent.at.getTime() - now.getTime());
  state.refreshTimerId = window.setTimeout(async () => {
    const current = new Date();
    syncWakeState(current);

    if (nextEvent.type === "refresh" || nextEvent.type === "wake") {
      if (isAwake(current)) {
        await refreshPlan();
      }
    } else {
      renderApp();
    }

    scheduleRefreshLoop();
  }, delay);
}

function startTickLoop() {
  window.clearInterval(state.tickTimerId);
  state.tickTimerId = window.setInterval(() => {
    const wasAwake = isAwake(state.currentNow);
    state.currentNow = new Date();
    syncWakeState(state.currentNow);
    renderApp();

    if (wasAwake !== isAwake(state.currentNow)) {
      scheduleRefreshLoop();
    }
  }, 30_000);
}

function startUpdateStatusLoop() {
  window.clearInterval(state.updateStatusTimerId);
  state.updateStatusTimerId = window.setInterval(() => {
    void refreshUpdateStatus({ force: true });
  }, UPDATE_STATUS_REFRESH_INTERVAL_MS);
}

function updateInfoPrimary() {
  if (state.updateStatus?.inProgress) {
    return "Mise a jour auto en cours";
  }

  return state.lastRefreshAt
    ? `Derniere mise a jour : ${formatInfoMoment(state.lastRefreshAt)}`
    : "Pas encore de mise a jour";
}

function updateInfoSecondary(nextEvent) {
  if (state.updateStatus?.inProgress) {
    return "Le serveur redemarre et l'affiche se rechargera automatiquement.";
  }

  if (state.updateStatus?.error) {
    return `Maj auto indisponible : ${state.updateStatus.error}`;
  }

  if (state.updateStatus?.updateAvailable) {
    return "Nouvelle version detectee. Installation automatique en cours.";
  }

  const scheduleInfo = describeInfoSecondary(nextEvent);
  if (state.updateStatus?.enabled && state.updateStatus?.automatic) {
    return scheduleInfo
      ? `${scheduleInfo} Mises a jour auto actives.`
      : "Mises a jour auto actives.";
  }

  return scheduleInfo;
}

function renderApp() {
  state.currentNow = new Date();
  syncWakeState(state.currentNow);
  renderFavorites();
  document.body.dataset.theme = state.theme;
  elements.wallClock.textContent = formatClock(state.currentNow);
  elements.themeToggleButton.dataset.theme = state.theme;
  elements.themeToggleButton.textContent = state.theme === "dark" ? "Mode clair" : "Mode sombre";
  elements.themeToggleButton.setAttribute(
    "aria-label",
    state.theme === "dark" ? "Activer le mode clair" : "Activer le mode sombre"
  );
  elements.themeToggleButton.title =
    state.theme === "dark" ? "Activer le mode clair" : "Activer le mode sombre";

  const hasConfig = Boolean(state.savedConfig);
  const awake = hasConfig && isAwake(state.currentNow);
  const showSleepScreen = hasConfig && !awake;
  const nextEvent = computeNextEvent(state.currentNow);
  const mode = !hasConfig ? "setup" : awake ? "awake" : "sleep";

  if (showSleepScreen && state.isEditing) {
    state.isEditing = false;
  }

  document.body.dataset.boardMode = mode;
  document.body.dataset.setupOpen = !hasConfig || state.isEditing ? "true" : "false";

  elements.topbar.hidden = showSleepScreen;
  elements.favoritesBar.hidden = showSleepScreen || !hasFavoriteConfigs(state.favorites);
  elements.settingsButton.hidden = !hasConfig || showSleepScreen;
  elements.routeChip.hidden = !hasConfig || showSleepScreen;
  elements.dashboard.hidden = !hasConfig;
  elements.boardFeedback.hidden = true;
  elements.infoBubble.hidden = !hasConfig || showSleepScreen;
  elements.setupShell.hidden = hasConfig ? (!state.isEditing || showSleepScreen) : false;
  elements.setupShell.dataset.overlay = hasConfig ? "true" : "false";
  elements.awakeView.hidden = !awake;
  elements.sleepView.hidden = !showSleepScreen;
  elements.wakeButton.disabled = state.refreshing;

  if (!hasConfig) {
    elements.setupTitle.textContent = "Choisis le premier trajet a afficher";
    elements.setupCopy.textContent =
      "Enregistre-le dans un favori. Ensuite l'affiche se met a jour toute seule chaque minute entre 07:00 et 18:00, puis passe en veille.";
    elements.closeSetupButton.hidden = true;
    elements.cancelSetupButton.hidden = true;
    setInfoOpen(false);
    setBoardFeedback("");
    return;
  }

  elements.routeChip.textContent = routeSummary(state.savedConfig);

  elements.setupTitle.textContent = `Modifier ${favoriteLabel(state.editingFavoriteIndex)}`;
  elements.setupCopy.textContent =
    "Change le depart ou l'arrivee, puis reenregistre dans le favori voulu. Un clic sur un favori recharge aussitot son trajet.";
  elements.closeSetupButton.hidden = !state.isEditing;
  elements.cancelSetupButton.hidden = !state.isEditing;

  elements.infoPrimary.textContent = updateInfoPrimary();
  elements.infoSecondary.textContent = updateInfoSecondary(nextEvent);
  elements.sleepMessage.textContent =
    "Hors horaire automatique, l'affiche se met en veille entre 18:00 et 07:00.";

  if (showSleepScreen) {
    setInfoOpen(false);
    return;
  }

  if (state.refreshing) {
    setBoardFeedback("Actualisation en cours...");
    elements.boardFeedback.hidden = false;
  } else if (state.lastError) {
    setBoardFeedback(`Derniere erreur: ${state.lastError}`, "error");
    elements.boardFeedback.hidden = false;
  } else {
    setBoardFeedback("");
  }

  if (!awake) {
    return;
  }

  if (state.currentPlan) {
    displayResults(state.currentPlan);
    displayTraffic(state.currentPlan);
    return;
  }

  if (state.refreshing) {
    showResultsPlaceholder("Je cherche les prochains trajets Fil Bleu.");
    showTrafficPlaceholder("Je mets aussi les alertes reseau a jour.");
    return;
  }

  if (state.lastError) {
    showResultsPlaceholder(state.lastError);
    showTrafficPlaceholder("Aucune alerte reseau exploitable pour cette recherche.");
    return;
  }

  showResultsPlaceholder("L'affiche attend la premiere actualisation.");
  showTrafficPlaceholder("Les alertes reseau apparaitront ici.");
}

async function saveRoute(event) {
  event.preventDefault();

  try {
    setFormLoading(true);
    setFeedback("J'enregistre ce trajet...");

    const [from, to] = await Promise.all([
      originAutocomplete.ensureSelection(),
      destinationAutocomplete.ensureSelection()
    ]);

    const favoriteIndex = normalizeFavoriteIndex(elements.favoriteSlot.value);
    const config = {
      from: copySelection(from),
      to: copySelection(to)
    };
    state.favorites[favoriteIndex] = config;
    state.activeFavoriteIndex = favoriteIndex;
    state.editingFavoriteIndex = favoriteIndex;
    state.savedConfig = config;
    persistFavorites(state.favorites);
    persistActiveFavoriteIndex(favoriteIndex);
    persistConfig(state.savedConfig);

    state.isEditing = false;
    state.currentPlan = null;
    resetVisibleResults();
    state.lastError = "";
    setFeedback("");
    clearSuggestions(elements.originSuggestions);
    clearSuggestions(elements.toSuggestions);
    document.activeElement?.blur?.();
    renderApp();
    showToast(`${favoriteLabel(favoriteIndex)} enregistre.`, "success");
    if (isAwake(new Date())) {
      await refreshPlan();
    }
    scheduleRefreshLoop();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue.";
    setFeedback(message, "error");
  } finally {
    setFormLoading(false);
    renderApp();
  }
}

async function wakeBoard() {
  if (!state.savedConfig) {
    return;
  }

  armManualWake();
  state.currentPlan = null;
  resetVisibleResults();
  state.lastError = "";
  renderApp();
  await refreshPlan();
  scheduleRefreshLoop();
}

async function refreshNow() {
  if (!state.savedConfig) {
    return;
  }

  if (!isAwake(new Date())) {
    armManualWake();
  }

  await refreshPlan();
  scheduleRefreshLoop();
}

const originAutocomplete = attachAutocomplete({
  emptyLabel: "Essaie une autre adresse, un autre lieu ou un autre arret",
  input: elements.originInput,
  key: "from",
  suggestions: elements.originSuggestions,
  type: "from"
});

const destinationAutocomplete = attachAutocomplete({
  emptyLabel: "Essaie une autre arrivee ou un autre arret Fil Bleu",
  input: elements.toInput,
  key: "to",
  suggestions: elements.toSuggestions,
  type: "to"
});

elements.form.addEventListener("submit", saveRoute);

elements.geolocateButton.addEventListener("click", () => {
  if (!navigator.geolocation) {
    setFeedback("La geolocalisation n'est pas disponible ici.", "error");
    return;
  }

  elements.geolocateButton.disabled = true;
  setFeedback("Localisation en cours...");
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;

      try {
        const suggestion = await requestReverseGeocode(latitude, longitude).catch(() => {
          return {
            details: "Position actuelle",
            id: `${longitude};${latitude}`,
            kind: "location",
            label: `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
          };
        });

        originAutocomplete.setSelection(suggestion);
        elements.originInput.focus();
        setFeedback(`Position detectee : ${suggestion.label}`);
      } finally {
        elements.geolocateButton.disabled = false;
      }
    },
    () => {
      elements.geolocateButton.disabled = false;
      setFeedback("Acces a la position refuse ou indisponible.", "error");
    },
    {
      enableHighAccuracy: true,
      timeout: 8000
    }
  );
});

elements.swapButton.addEventListener("click", () => {
  const fromSelection = copySelection(state.formSelection.from);
  const toSelection = copySelection(state.formSelection.to);

  originAutocomplete.setSelection(toSelection);
  destinationAutocomplete.setSelection(fromSelection);
  setFeedback("Depart et arrivee inverses.");
});

elements.favoritesBar.addEventListener("click", (event) => {
  const button = event.target.closest("[data-favorite-index]");
  if (!button) {
    return;
  }

  activateFavorite(button.dataset.favoriteIndex);
});

elements.moreResultsButton.addEventListener("click", () => {
  if (!state.currentPlan?.options?.length) {
    return;
  }

  state.visibleResultsCount = Math.min(
    MAX_VISIBLE_RESULTS,
    state.visibleResultsCount + RESULTS_BATCH_SIZE
  );
  displayResults(state.currentPlan);
});

elements.themeToggleButton.addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  persistTheme(state.theme);
  renderApp();
});

elements.settingsButton.addEventListener("click", () => openSetup(state.activeFavoriteIndex));
elements.closeSetupButton.addEventListener("click", closeSetup);
elements.cancelSetupButton.addEventListener("click", closeSetup);
elements.wakeButton.addEventListener("click", wakeBoard);
elements.infoButton.addEventListener("click", (event) => {
  event.stopPropagation();
  setInfoOpen(!state.infoOpen);
});

document.addEventListener("click", (event) => {
  if (state.infoOpen && !elements.infoBubble.contains(event.target)) {
    setInfoOpen(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.infoOpen) {
    setInfoOpen(false);
  }
});

function initialize() {
  state.theme = loadStoredTheme() || preferredTheme();
  state.favorites = loadStoredFavorites();
  persistFavorites(state.favorites);
  state.activeFavoriteIndex = loadActiveFavoriteIndex();
  if (!state.favorites[state.activeFavoriteIndex] && hasFavoriteConfigs(state.favorites)) {
    state.activeFavoriteIndex = state.favorites.findIndex((config) => Boolean(config)) || 0;
  }
  state.editingFavoriteIndex = state.activeFavoriteIndex;
  state.savedConfig = state.favorites[state.activeFavoriteIndex]
    ? {
        from: copySelection(state.favorites[state.activeFavoriteIndex].from),
        to: copySelection(state.favorites[state.activeFavoriteIndex].to)
      }
    : null;
  state.manualWakeUntil = loadStoredWakeUntil();
  syncWakeState(new Date());
  state.isEditing = !state.savedConfig;
  persistActiveFavoriteIndex(state.activeFavoriteIndex);
  elements.favoriteSlot.value = String(state.activeFavoriteIndex);

  if (state.savedConfig) {
    populateFormFromConfig(state.savedConfig);
  } else {
    clearFormSelections();
  }

  renderApp();
  refreshUpdateStatus({
    force: true
  });
  startUpdateStatusLoop();
  startTickLoop();

  if (state.savedConfig) {
    if (isAwake(new Date())) {
      refreshPlan().finally(() => {
        scheduleRefreshLoop();
      });
    } else {
      scheduleRefreshLoop();
    }
  }
}

initialize();
