import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildTrafficPayload,
  optionHasCatchableLeadTime
} from "../server.js";

const serverPath = fileURLToPath(new URL("../server.js", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("manifestations are filtered to the current route only", () => {
  const departureAt = new Date("2026-03-19T10:00:00+01:00");
  const disruptions = [
    {
      begin: "20260319T000000",
      end: "20260319T235959",
      id: "manifest-route",
      impactedAreas: [],
      impactedLines: ["line:tram:a"],
      isManifestation: true,
      message: "Manifestation sur la ligne A",
      periods: [{ begin: "20260319T000000", end: "20260319T235959" }],
      reason: "Manifestation",
      severity: "blocking",
      severityLabel: "Interruption",
      title: "Manifestation tram A"
    },
    {
      begin: "20260319T000000",
      end: "20260319T235959",
      id: "manifest-other",
      impactedAreas: [],
      impactedLines: ["line:bus:10"],
      isManifestation: true,
      message: "Manifestation sur une autre ligne",
      periods: [{ begin: "20260319T000000", end: "20260319T235959" }],
      reason: "Manifestation",
      severity: "blocking",
      severityLabel: "Interruption",
      title: "Manifestation bus 10"
    }
  ];

  const payload = buildTrafficPayload({
    areaIds: [],
    departureAt,
    disruptions,
    lineIds: ["line:tram:a"],
    lineMetaById: new Map([
      ["line:tram:a", { lineCode: "A", lineId: "line:tram:a", mode: "tram" }],
      ["line:bus:10", { lineCode: "10", lineId: "line:bus:10", mode: "bus" }]
    ])
  });

  assert.deepEqual(payload.manifestations.map((item) => item.id), ["manifest-route"]);
  assert.equal(payload.disruptions.length, 0);
  assert.equal(payload.manifestationToday, true);
});

test("uncatchable journeys are rejected when walking time exceeds the lead time", () => {
  const requestedDepartureAt = new Date("2026-03-19T10:00:00+01:00");
  const impossibleOption = {
    sections: [
      {
        durationMinutes: 6,
        kind: "walking"
      },
      {
        departureAt: "2026-03-19T10:06:00+01:00",
        kind: "public_transport"
      }
    ]
  };
  const catchableOption = {
    sections: [
      {
        durationMinutes: 6,
        kind: "walking"
      },
      {
        departureAt: "2026-03-19T10:08:00+01:00",
        kind: "public_transport"
      }
    ]
  };

  assert.equal(optionHasCatchableLeadTime(impossibleOption, requestedDepartureAt), false);
  assert.equal(optionHasCatchableLeadTime(catchableOption, requestedDepartureAt), true);
});

async function startServerProcess(envOverrides = {}) {
  const port = 43180 + Math.floor(Math.random() * 1000);
  const child = spawn(
    process.execPath,
    [serverPath],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        SELF_UPDATE_ENABLED: "0",
        ...envOverrides
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (stdout.includes(`http://127.0.0.1:${port}`)) {
      return {
        child,
        port
      };
    }

    if (child.exitCode !== null) {
      throw new Error(`Le serveur de test a quitte trop tot.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    }

    await delay(50);
  }

  child.kill("SIGTERM");
  throw new Error(`Le serveur de test n'a pas demarre a temps.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
}

async function stopServerProcess(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  const exitResult = await Promise.race([
    once(child, "exit"),
    delay(2_000).then(() => null)
  ]);

  if (!exitResult && child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

test("update-status can be protected with a token", async (t) => {
  const serverProcess = await startServerProcess({
    UPDATE_API_TOKEN: "secret-token",
    UPDATE_STATUS_REQUIRE_AUTH: "1"
  });
  t.after(async () => {
    await stopServerProcess(serverProcess.child);
  });

  const baseUrl = `http://127.0.0.1:${serverProcess.port}`;
  const forbiddenResponse = await fetch(`${baseUrl}/api/update-status`);
  assert.equal(forbiddenResponse.status, 200);

  const lanResponse = await fetch(`${baseUrl}/api/update-status`, {
    headers: {
      "X-Forwarded-For": "192.168.1.50"
    }
  });
  assert.equal(lanResponse.status, 403);

  const allowedResponse = await fetch(`${baseUrl}/api/update-status`, {
    headers: {
      Authorization: "Bearer secret-token",
      "X-Forwarded-For": "192.168.1.50"
    }
  });
  assert.equal(allowedResponse.status, 200);
});
