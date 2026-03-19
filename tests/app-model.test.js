import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ACTIVE_HOURS,
  getTramAlertAction,
  normalizeActiveHours,
  readPlanSnapshot,
  upsertPlanSnapshotMap
} from "../public/app-model.js";

const maxAgeMs = 20 * 60 * 1000;

test("plan snapshots are stored per route key and keep multiple favorites", () => {
  const nowMs = Date.parse("2026-03-19T08:00:00.000Z");
  const firstRouteSnapshots = upsertPlanSnapshotMap(
    {},
    "home->station",
    { options: [{ id: "first" }] },
    "2026-03-19T07:55:00.000Z",
    { maxAgeMs, nowMs }
  );
  const bothRoutesSnapshots = upsertPlanSnapshotMap(
    firstRouteSnapshots,
    "office->home",
    { options: [{ id: "second" }] },
    "2026-03-19T07:58:00.000Z",
    { maxAgeMs, nowMs }
  );

  assert.equal(readPlanSnapshot(bothRoutesSnapshots, "home->station", { maxAgeMs, nowMs })?.plan.options[0]?.id, "first");
  assert.equal(readPlanSnapshot(bothRoutesSnapshots, "office->home", { maxAgeMs, nowMs })?.plan.options[0]?.id, "second");
});

test("stale snapshots are discarded when a newer route is saved", () => {
  const nowMs = Date.parse("2026-03-19T08:00:00.000Z");
  const snapshots = upsertPlanSnapshotMap(
    {
      "stale->route": {
        plan: { options: [{ id: "stale" }] },
        savedAt: "2026-03-19T07:00:00.000Z"
      }
    },
    "fresh->route",
    { options: [{ id: "fresh" }] },
    "2026-03-19T07:59:00.000Z",
    { maxAgeMs, nowMs }
  );

  assert.equal(readPlanSnapshot(snapshots, "stale->route", { maxAgeMs, nowMs }), null);
  assert.equal(readPlanSnapshot(snapshots, "fresh->route", { maxAgeMs, nowMs })?.plan.options[0]?.id, "fresh");
});

test("mute mode swallows tram alerts without replaying them later", () => {
  const mutedAction = getTramAlertAction({
    alertKey: "tram-a|tram-b",
    audioEnabled: false,
    audioUnlocked: true,
    lastTramAlertKey: "",
    source: "live"
  });

  assert.equal(mutedAction.shouldPlay, false);
  assert.equal(mutedAction.nextAlertKey, "tram-a|tram-b");
});

test("invalid active-hour ranges fall back to defaults", () => {
  assert.deepEqual(
    normalizeActiveHours({
      endHour: 6,
      startHour: 22
    }),
    DEFAULT_ACTIVE_HOURS
  );
});
