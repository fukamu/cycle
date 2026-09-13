import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  resolveLocalCandidateImageDigest,
  runCloudflareDrainEvidenceCLI,
} from "../check-cloudflare-drain-evidence.mjs";
import {
  CloudflareDrainFailure,
  cloudflareDrainPhases,
  cloudflareDrainReasons,
  cloudflareDrainSources,
  createCloudflareRawAdapter,
  formatCloudflareDrainDiagnostic,
  parseCloudflareDrainDiagnosticLine,
  proveCloudflareDrain as proveCloudflareDrainImplementation,
  serializeCloudflareDrainEvidence,
} from "../lib/cloudflare-drain-evidence.mjs";

const candidateSHA = "a".repeat(40);
const previousSHA = "b".repeat(40);
const accountID = "c".repeat(32);
const token = "cloudflare-private-token";
const workerName = "fukamu-cycle-staging";
const applicationName = "fukamu-cycle-staging-backend";

const ids = Object.freeze({
  oldDeployment: "00000000-0000-4000-8000-000000000001",
  oldWorkerVersion: "00000000-0000-4000-8000-000000000002",
  application: "00000000-0000-4000-8000-000000000003",
  oldInstance: "00000000-0000-4000-8000-000000000004",
  oldRollout: "00000000-0000-4000-8000-000000000005",
  newDeployment: "00000000-0000-4000-8000-000000000006",
  newWorkerVersion: "10000000-0000-4000-8000-000000000007",
  newRollout: "00000000-0000-4000-8000-000000000008",
  newInstance: "00000000-0000-4000-8000-000000000009",
  otherInstance: "00000000-0000-4000-8000-00000000000a",
  unrelatedRollout: "00000000-0000-4000-8000-00000000000d",
  ambiguousRollout: "00000000-0000-4000-8000-00000000000e",
  changedWorkerVersion: "00000000-0000-4000-8000-00000000000f",
});
const oldImage = `registry.cloudflare.com/${accountID}/cycle:${previousSHA}@sha256:${"1".repeat(64)}`;
const newImage = `registry.cloudflare.com/${accountID}/cycle:${candidateSHA}@sha256:${"2".repeat(64)}`;
const unrelatedImage = `registry.cloudflare.com/${accountID}/cycle:${"c".repeat(40)}@sha256:${"3".repeat(64)}`;
const candidateImageDigest = `sha256:${"2".repeat(64)}`;

function proveCloudflareDrain(options) {
  return proveCloudflareDrainImplementation({
    resolveCandidateImageDigest: async () => candidateImageDigest,
    ...options,
  });
}

function rollout({
  id = ids.oldRollout,
  status = "completed",
  currentVersion = 1,
  targetVersion = 1,
  targetImage = oldImage,
} = {}) {
  return {
    id,
    createdAt: "2026-09-07T00:00:00.000Z",
    status,
    currentVersion,
    targetVersion,
    targetImage,
  };
}

function instance({
  id = ids.oldInstance,
  status = "running",
  version = 1,
  image = oldImage,
} = {}) {
  return { id, status, version, image };
}

function observation({
  candidate = false,
  workerTag = candidate ? candidateSHA : previousSHA,
  activeRolloutId = null,
  rolloutStatus = "completed",
  baselineVersion = 1,
  candidateVersion = 2,
  rollouts,
  instances,
} = {}) {
  const currentInstances =
    instances ??
    (candidate
      ? [
          instance({
            id: ids.newInstance,
            version: candidateVersion,
            image: newImage,
          }),
        ]
      : [instance({ version: baselineVersion })]);
  return {
    worker: {
      deploymentId: candidate ? ids.newDeployment : ids.oldDeployment,
      versionId: candidate ? ids.newWorkerVersion : ids.oldWorkerVersion,
      trafficPercentage: 100,
      tag: workerTag,
    },
    container: {
      applicationId: ids.application,
      version: candidate ? candidateVersion : baselineVersion,
      image: candidate ? newImage : oldImage,
      activeRolloutId,
      rollouts:
        rollouts ??
        (candidate
          ? [
              rollout({
                id: ids.newRollout,
                status: rolloutStatus,
                currentVersion: baselineVersion,
                targetVersion: candidateVersion,
                targetImage: newImage,
              }),
              rollout({
                currentVersion: baselineVersion,
                targetVersion: baselineVersion,
              }),
            ]
          : [
              rollout({
                currentVersion: baselineVersion,
                targetVersion: baselineVersion,
              }),
            ]),
      instances: currentInstances,
    },
  };
}

function sequenceAdapter(values) {
  const calls = [];
  return {
    calls,
    async readObservation(input) {
      calls.push(input);
      assert.notEqual(values.length, 0);
      return structuredClone(values.shift());
    },
  };
}

function stableBaseline(value = observation()) {
  return [value, structuredClone(value)];
}

function tickingClock(step = 10_000) {
  let value = -step;
  return () => {
    value += step;
    return value;
  };
}

test("requires two identical authoritative observations after waking the deploy", async () => {
  const transitioning = observation({
    candidate: true,
    activeRolloutId: ids.newRollout,
    rolloutStatus: "progressing",
    instances: [],
  });
  const adapter = sequenceAdapter([
    ...stableBaseline(),
    transitioning,
    observation({ candidate: true }),
    observation({ candidate: true }),
  ]);
  const wakeInputs = [];
  const sleeps = [];
  const evidence = await proveCloudflareDrain({
    candidateCommitSHA: candidateSHA,
    rawAdapter: adapter,
    now: tickingClock(),
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    wake: async (baseline) => wakeInputs.push(baseline),
  });

  assert.deepEqual(adapter.calls, [
    {
      phase: "baseline",
      attempt: 0,
      timeoutMilliseconds: 290_000,
    },
    {
      phase: "baseline",
      attempt: 1,
      timeoutMilliseconds: 270_000,
    },
    { phase: "drain", attempt: 0, timeoutMilliseconds: 1_190_000 },
    { phase: "drain", attempt: 1, timeoutMilliseconds: 1_160_000 },
    { phase: "drain", attempt: 2, timeoutMilliseconds: 1_140_000 },
  ]);
  assert.equal(wakeInputs.length, 1);
  assert.equal(wakeInputs[0].workerVersionId, ids.oldWorkerVersion);
  assert.equal(wakeInputs[0].containerImageDigest, `sha256:${"1".repeat(64)}`);
  assert.deepEqual(sleeps, [10_000, 10_000, 10_000]);
  assert.deepEqual(evidence, {
    result: "drained",
    commitSHA: candidateSHA,
    workerDeploymentId: ids.newDeployment,
    workerVersionId: ids.newWorkerVersion,
    drainedWorkerVersionId: ids.oldWorkerVersion,
    containerApplicationId: ids.application,
    containerRolloutId: ids.newRollout,
    containerVersion: 2,
    containerImageDigest: `sha256:${"2".repeat(64)}`,
    drainedContainerVersion: 1,
    drainedContainerImageDigest: `sha256:${"1".repeat(64)}`,
    observedAt: "1970-01-01T00:02:00.000Z",
  });
  assert.equal(
    JSON.parse(serializeCloudflareDrainEvidence(evidence)).result,
    "drained",
  );
});

test("binds an untagged legacy baseline by identity and drains to the exact tagged candidate", async () => {
  const baseline = observation({ workerTag: null });
  const candidate = observation({ candidate: true });
  const wakeInputs = [];
  const evidence = await proveCloudflareDrain({
    candidateCommitSHA: candidateSHA,
    rawAdapter: sequenceAdapter([
      baseline,
      structuredClone(baseline),
      candidate,
      structuredClone(candidate),
    ]),
    now: tickingClock(),
    sleep: async () => undefined,
    wake: async (value) => wakeInputs.push(value),
  });

  assert.equal(wakeInputs[0].workerTag, null);
  assert.equal(wakeInputs[0].workerDeploymentId, ids.oldDeployment);
  assert.equal(wakeInputs[0].workerVersionId, ids.oldWorkerVersion);
  assert.equal(evidence.workerDeploymentId, ids.newDeployment);
  assert.equal(evidence.workerVersionId, ids.newWorkerVersion);
  assert.equal(evidence.commitSHA, candidateSHA);
});

test("does not treat a changed untagged worker as the candidate", async () => {
  await assert.rejects(
    proveCloudflareDrain({
      candidateCommitSHA: candidateSHA,
      rawAdapter: sequenceAdapter([
        ...stableBaseline(observation({ workerTag: null })),
        observation({ candidate: true, workerTag: null }),
      ]),
      now: tickingClock(),
      sleep: async () => undefined,
      wake: async () => undefined,
    }),
    (error) =>
      error instanceof CloudflareDrainFailure &&
      error.phase === "drain" &&
      error.reason === "evidence_changed",
  );
});

test("accepts idle zero-instance inventories across an exact rollout", async () => {
  const cases = [
    {
      baseline: observation({ instances: [] }),
      candidate: observation({ candidate: true, instances: [] }),
    },
    {
      baseline: observation(),
      candidate: observation({ candidate: true, instances: [] }),
    },
    {
      baseline: observation({ instances: [] }),
      candidate: observation({ candidate: true }),
    },
  ];

  for (const { baseline, candidate } of cases) {
    const wakeInputs = [];
    const evidence = await proveCloudflareDrain({
      candidateCommitSHA: candidateSHA,
      rawAdapter: sequenceAdapter([
        ...stableBaseline(baseline),
        candidate,
        structuredClone(candidate),
      ]),
      now: tickingClock(),
      sleep: async () => undefined,
      wake: async (value) => wakeInputs.push(value),
    });

    assert.equal(wakeInputs.length, 1);
    assert.equal(wakeInputs[0].containerVersion, 1);
    assert.equal(evidence.result, "drained");
    assert.equal(
      evidence.drainedContainerImageDigest,
      `sha256:${"1".repeat(64)}`,
    );
    assert.equal(evidence.containerImageDigest, candidateImageDigest);
  }
});

test("reports the highest-priority closed baseline reason without waking", async () => {
  const cases = [
    {
      reason: "baseline_active_rollout",
      value: observation({
        activeRolloutId: ids.oldRollout,
        instances: [
          instance({ status: "placed", version: 0, image: unrelatedImage }),
        ],
      }),
    },
    {
      reason: "baseline_instance_not_running",
      value: observation({
        instances: [
          instance({ status: "placed", version: 0, image: unrelatedImage }),
        ],
      }),
    },
    ...["stopping", "stopped", "failed", "unhealthy"].map((status) => ({
      reason: "baseline_instance_not_running",
      value: observation({ instances: [instance({ status })] }),
    })),
    {
      reason: "baseline_instance_version_mismatch",
      value: observation({
        instances: [instance({ version: 0, image: unrelatedImage })],
      }),
    },
    {
      reason: "baseline_instance_image_reference_mismatch",
      value: observation({ instances: [instance({ image: unrelatedImage })] }),
    },
  ];

  for (const { reason, value } of cases) {
    let woke = false;
    const adapter = sequenceAdapter([value, structuredClone(value)]);
    await assert.rejects(
      proveCloudflareDrain({
        candidateCommitSHA: candidateSHA,
        rawAdapter: adapter,
        now: tickingClock(1),
        sleep: async () => undefined,
        wake: async () => {
          woke = true;
        },
        pollIntervalMilliseconds: 1,
        timeoutMilliseconds: 5,
      }),
      (error) =>
        error instanceof CloudflareDrainFailure &&
        error.phase === "baseline" &&
        error.reason === reason &&
        error.source === "none" &&
        !error.message.includes(token),
    );
    assert.equal(woke, false);
    assert.equal(adapter.calls.length, 2);
  }
});

test("waits for transient baseline rollout and placement states before waking", async () => {
  const pendingValues = [
    observation({ activeRolloutId: ids.oldRollout }),
    observation({ instances: [instance({ status: "placed" })] }),
  ];

  for (const pending of pendingValues) {
    const adapter = sequenceAdapter([
      pending,
      ...stableBaseline(),
      observation({ candidate: true }),
      observation({ candidate: true }),
    ]);
    const callsAtWake = [];
    const evidence = await proveCloudflareDrain({
      candidateCommitSHA: candidateSHA,
      rawAdapter: adapter,
      now: tickingClock(1),
      sleep: async () => undefined,
      wake: async () => callsAtWake.push(structuredClone(adapter.calls)),
      pollIntervalMilliseconds: 1,
      timeoutMilliseconds: 20,
    });

    assert.equal(evidence.result, "drained");
    assert.equal(callsAtWake.length, 1);
    assert.deepEqual(
      callsAtWake[0].map(({ phase, attempt }) => ({ phase, attempt })),
      [
        { phase: "baseline", attempt: 0 },
        { phase: "baseline", attempt: 1 },
        { phase: "baseline", attempt: 2 },
      ],
    );
  }
});

test("fails closed when stable baseline identity changes between samples", async () => {
  for (const intermediate of [
    [],
    [observation({ activeRolloutId: ids.oldRollout })],
  ]) {
    const changed = observation();
    changed.worker.deploymentId = ids.changedWorkerVersion;
    let woke = false;
    await assert.rejects(
      proveCloudflareDrain({
        candidateCommitSHA: candidateSHA,
        rawAdapter: sequenceAdapter([observation(), ...intermediate, changed]),
        now: tickingClock(1),
        sleep: async () => undefined,
        wake: async () => {
          woke = true;
        },
        pollIntervalMilliseconds: 1,
        timeoutMilliseconds: 10,
      }),
      (error) =>
        error instanceof CloudflareDrainFailure &&
        error.phase === "baseline" &&
        error.reason === "evidence_changed",
    );
    assert.equal(woke, false);
  }
});

test("does not accept mixed old instances or one candidate observation", async () => {
  const mixed = observation({
    candidate: true,
    instances: [
      instance({ id: ids.newInstance, version: 2, image: newImage }),
      instance(),
    ],
  });
  const adapter = sequenceAdapter([
    ...stableBaseline(),
    observation({ candidate: true }),
    mixed,
  ]);
  await assert.rejects(
    proveCloudflareDrain({
      candidateCommitSHA: candidateSHA,
      rawAdapter: adapter,
      now: tickingClock(1),
      sleep: async () => undefined,
      wake: async () => undefined,
      pollIntervalMilliseconds: 1,
      timeoutMilliseconds: 10,
    }),
    (error) =>
      error instanceof CloudflareDrainFailure &&
      error.phase === "stability" &&
      error.reason === "evidence_changed",
  );
});

test("rejects an already-active candidate and never wakes deployment", async () => {
  let woke = false;
  await assert.rejects(
    proveCloudflareDrain({
      candidateCommitSHA: candidateSHA,
      rawAdapter: sequenceAdapter([
        observation({
          candidate: true,
          activeRolloutId: ids.newRollout,
          rolloutStatus: "completed",
          instances: [
            instance({ status: "placed", version: 0, image: unrelatedImage }),
          ],
        }),
      ]),
      wake: async () => {
        woke = true;
      },
    }),
    (error) =>
      error instanceof CloudflareDrainFailure &&
      error.phase === "baseline" &&
      error.reason === "candidate_already_active",
  );
  assert.equal(woke, false);
});

test("keeps invalid and provider baseline failures immediate", async () => {
  for (const { adapter, reason, source } of [
    {
      adapter: sequenceAdapter([{ ...observation(), private: token }]),
      reason: "invalid_evidence",
      source: "observation",
    },
    {
      adapter: {
        calls: [],
        async readObservation(input) {
          this.calls.push(input);
          throw new CloudflareDrainFailure("baseline", "provider_rejected");
        },
      },
      reason: "provider_rejected",
      source: "none",
    },
  ]) {
    let woke = false;
    let slept = false;
    await assert.rejects(
      proveCloudflareDrain({
        candidateCommitSHA: candidateSHA,
        rawAdapter: adapter,
        now: tickingClock(1),
        sleep: async () => {
          slept = true;
        },
        wake: async () => {
          woke = true;
        },
        pollIntervalMilliseconds: 1,
        timeoutMilliseconds: 10,
      }),
      (error) =>
        error instanceof CloudflareDrainFailure &&
        error.phase === "baseline" &&
        error.reason === reason &&
        error.source === source &&
        !error.message.includes(token),
    );
    assert.equal(adapter.calls.length, 1);
    assert.equal(slept, false);
    assert.equal(woke, false);
  }
});

test("fails closed when a stable semantic projection changes or rollout reverts", async () => {
  const changed = observation({ candidate: true });
  changed.worker.versionId = ids.changedWorkerVersion;
  await assert.rejects(
    proveCloudflareDrain({
      candidateCommitSHA: candidateSHA,
      rawAdapter: sequenceAdapter([
        ...stableBaseline(),
        observation({ candidate: true }),
        changed,
      ]),
      now: tickingClock(),
      sleep: async () => undefined,
      wake: async () => undefined,
    }),
    (error) =>
      error instanceof CloudflareDrainFailure &&
      error.phase === "stability" &&
      error.reason === "evidence_changed",
  );

  for (const rolloutStatus of ["reverted", "replaced"]) {
    await assert.rejects(
      proveCloudflareDrain({
        candidateCommitSHA: candidateSHA,
        rawAdapter: sequenceAdapter([
          ...stableBaseline(),
          observation({
            candidate: true,
            activeRolloutId: ids.newRollout,
            rolloutStatus,
          }),
        ]),
        now: tickingClock(),
        sleep: async () => undefined,
        wake: async () => undefined,
      }),
      (error) =>
        error instanceof CloudflareDrainFailure &&
        error.phase === "drain" &&
        error.reason === "rollout_failed",
    );
  }
});

test("accepts version gaps, unrelated rollouts, and reordered candidate instances", async () => {
  const unrelated = rollout({
    id: ids.unrelatedRollout,
    currentVersion: 1,
    targetVersion: 2,
    targetImage: unrelatedImage,
  });
  const candidateRollout = rollout({
    id: ids.newRollout,
    currentVersion: 1,
    targetVersion: 4,
    targetImage: newImage,
  });
  const first = observation({
    candidate: true,
    candidateVersion: 4,
    rollouts: [unrelated, candidateRollout, rollout()],
    instances: [
      instance({ id: ids.newInstance, version: 4, image: newImage }),
      instance({ id: ids.otherInstance, version: 4, image: newImage }),
    ],
  });
  const second = structuredClone(first);
  second.container.instances.reverse();
  second.container.instances[0].id = ids.changedWorkerVersion;

  const evidence = await proveCloudflareDrain({
    candidateCommitSHA: candidateSHA,
    rawAdapter: sequenceAdapter([...stableBaseline(), first, second]),
    now: tickingClock(),
    sleep: async () => undefined,
    wake: async () => undefined,
  });
  assert.equal(evidence.containerVersion, 4);
  assert.equal(evidence.containerRolloutId, ids.newRollout);
  assert.equal(Object.hasOwn(evidence, "containerInstanceId"), false);
});

test("accepts omitted instance images through exact application and rollout version binding", async () => {
  const baseline = observation({
    instances: [instance({ image: null })],
  });
  const candidate = observation({
    candidate: true,
    instances: [instance({ id: ids.newInstance, version: 2, image: null })],
  });
  assert.equal(
    (
      await proveCloudflareDrain({
        candidateCommitSHA: candidateSHA,
        rawAdapter: sequenceAdapter([
          ...stableBaseline(baseline),
          candidate,
          structuredClone(candidate),
        ]),
        now: tickingClock(),
        sleep: async () => undefined,
        wake: async () => undefined,
      })
    ).result,
    "drained",
  );
});

test("accepts an initial application version of zero and drains it to the candidate", async () => {
  const baseline = observation({
    baselineVersion: 0,
    instances: [instance({ version: 0, image: null })],
  });
  const candidate = observation({
    candidate: true,
    baselineVersion: 0,
    candidateVersion: 1,
    instances: [instance({ id: ids.newInstance, version: 1, image: null })],
  });
  const evidence = await proveCloudflareDrain({
    candidateCommitSHA: candidateSHA,
    rawAdapter: sequenceAdapter([
      ...stableBaseline(baseline),
      candidate,
      structuredClone(candidate),
    ]),
    now: tickingClock(),
    sleep: async () => undefined,
    wake: async () => undefined,
  });
  assert.equal(evidence.drainedContainerVersion, 0);
  assert.equal(evidence.containerVersion, 1);
  assert.equal(
    JSON.parse(serializeCloudflareDrainEvidence(evidence))
      .drainedContainerVersion,
    0,
  );
});

test("rejects mixed images and ambiguous candidate rollouts", async () => {
  const invalidCandidates = [
    observation({
      candidate: true,
      activeRolloutId: ids.newRollout,
      rolloutStatus: "progressing",
      instances: [],
    }),
    observation({
      candidate: true,
      instances: [
        instance({ id: ids.newInstance, version: 2, image: newImage }),
        instance(),
      ],
    }),
    observation({
      candidate: true,
      instances: [
        instance({ id: ids.newInstance, version: 2, image: unrelatedImage }),
      ],
    }),
    observation({
      candidate: true,
      rollouts: [
        rollout({
          id: ids.newRollout,
          currentVersion: 1,
          targetVersion: 2,
          targetImage: null,
        }),
        rollout(),
      ],
    }),
    observation({
      candidate: true,
      rollouts: [
        rollout({
          id: ids.newRollout,
          currentVersion: 1,
          targetVersion: 2,
          targetImage: newImage,
        }),
        rollout({
          id: ids.ambiguousRollout,
          currentVersion: 1,
          targetVersion: 2,
          targetImage: newImage,
        }),
        rollout(),
      ],
    }),
    observation({
      candidate: true,
      activeRolloutId: ids.unrelatedRollout,
      rollouts: [
        rollout({
          id: ids.unrelatedRollout,
          status: "progressing",
          currentVersion: 1,
          targetVersion: 3,
          targetImage: unrelatedImage,
        }),
        rollout({
          id: ids.newRollout,
          currentVersion: 1,
          targetVersion: 2,
          targetImage: newImage,
        }),
        rollout(),
      ],
    }),
  ];

  for (const invalid of invalidCandidates) {
    await assert.rejects(
      proveCloudflareDrain({
        candidateCommitSHA: candidateSHA,
        rawAdapter: sequenceAdapter([
          ...stableBaseline(),
          invalid,
          structuredClone(invalid),
          structuredClone(invalid),
        ]),
        now: tickingClock(1),
        sleep: async () => undefined,
        wake: async () => undefined,
        pollIntervalMilliseconds: 1,
        timeoutMilliseconds: 6,
      }),
      (error) =>
        error instanceof CloudflareDrainFailure &&
        ["evidence_changed", "evidence_timeout"].includes(error.reason),
    );
  }
});

test("does not accept an idle candidate while its rollout remains active", async () => {
  for (const rolloutStatus of ["pending", "progressing"]) {
    const active = observation({
      candidate: true,
      activeRolloutId: ids.newRollout,
      rolloutStatus,
      instances: [],
    });
    await assert.rejects(
      proveCloudflareDrain({
        candidateCommitSHA: candidateSHA,
        rawAdapter: sequenceAdapter([
          ...stableBaseline(observation({ instances: [] })),
          active,
          structuredClone(active),
          structuredClone(active),
        ]),
        now: tickingClock(1),
        sleep: async () => undefined,
        wake: async () => undefined,
        pollIntervalMilliseconds: 1,
        timeoutMilliseconds: 8,
      }),
      (error) =>
        error instanceof CloudflareDrainFailure &&
        error.phase === "drain" &&
        error.reason === "evidence_timeout",
    );
  }
});

test("polls a placed candidate but rejects known terminal instance states", async () => {
  const placed = observation({
    candidate: true,
    activeRolloutId: ids.newRollout,
    rolloutStatus: "progressing",
    instances: [
      instance({
        id: ids.newInstance,
        status: "placed",
        version: 2,
        image: newImage,
      }),
    ],
  });
  const adapter = sequenceAdapter([
    ...stableBaseline(),
    placed,
    observation({ candidate: true }),
    observation({ candidate: true }),
  ]);
  assert.equal(
    (
      await proveCloudflareDrain({
        candidateCommitSHA: candidateSHA,
        rawAdapter: adapter,
        now: tickingClock(),
        sleep: async () => undefined,
        wake: async () => undefined,
      })
    ).result,
    "drained",
  );

  for (const status of ["failed", "stopped", "stopping", "unhealthy"]) {
    const terminal = observation({
      candidate: true,
      activeRolloutId: ids.newRollout,
      rolloutStatus: "progressing",
      instances: [
        instance({ id: ids.newInstance, status, version: 2, image: newImage }),
      ],
    });
    await assert.rejects(
      proveCloudflareDrain({
        candidateCommitSHA: candidateSHA,
        rawAdapter: sequenceAdapter([...stableBaseline(), terminal]),
        now: tickingClock(),
        sleep: async () => undefined,
        wake: async () => undefined,
      }),
      (error) =>
        error instanceof CloudflareDrainFailure &&
        error.phase === "drain" &&
        error.reason === "rollout_failed",
    );
  }
});

test("starts the drain deadline after wake and rejects a late final read", async () => {
  const wakeExcludedClock = [
    0, 1, 2, 3, 4, 1_000_000, 1_000_001, 1_000_002, 1_000_003, 1_000_004,
    1_000_005,
  ];
  const evidence = await proveCloudflareDrain({
    candidateCommitSHA: candidateSHA,
    rawAdapter: sequenceAdapter([
      ...stableBaseline(),
      observation({ candidate: true }),
      observation({ candidate: true }),
    ]),
    now: () => wakeExcludedClock.shift(),
    sleep: async () => undefined,
    wake: async () => undefined,
    pollIntervalMilliseconds: 1,
    timeoutMilliseconds: 10,
  });
  assert.equal(evidence.observedAt, "1970-01-01T00:16:40.005Z");

  const lateReadClock = [0, 1, 2, 3, 4, 100, 101, 102, 103, 109, 110];
  await assert.rejects(
    proveCloudflareDrain({
      candidateCommitSHA: candidateSHA,
      rawAdapter: sequenceAdapter([
        ...stableBaseline(),
        observation({ candidate: true }),
        observation({ candidate: true }),
      ]),
      now: () => lateReadClock.shift(),
      sleep: async () => undefined,
      wake: async () => undefined,
      pollIntervalMilliseconds: 1,
      timeoutMilliseconds: 10,
    }),
    (error) =>
      error instanceof CloudflareDrainFailure &&
      error.phase === "stability" &&
      error.reason === "evidence_timeout",
  );
});

test("rejects unknown schemas, enums, oversized raw input, and clock regression", async () => {
  const cases = [
    { ...observation(), extra: true },
    (() => {
      const value = observation();
      value.container.instances[0].status = "mystery";
      return value;
    })(),
    `${JSON.stringify(observation())}${" ".repeat(4 * 64 * 1024)}`,
  ];
  for (const invalidVersion of [-1, 0.5]) {
    for (const selectVersion of [
      (value) => {
        value.container.version = invalidVersion;
      },
      (value) => {
        value.container.rollouts[0].currentVersion = invalidVersion;
      },
      (value) => {
        value.container.rollouts[0].targetVersion = invalidVersion;
      },
      (value) => {
        value.container.instances[0].version = invalidVersion;
      },
    ]) {
      const value = observation();
      selectVersion(value);
      cases.push(value);
    }
  }
  for (const invalid of cases) {
    await assert.rejects(
      proveCloudflareDrain({
        candidateCommitSHA: candidateSHA,
        rawAdapter: sequenceAdapter([invalid]),
        wake: async () => undefined,
      }),
      (error) =>
        error instanceof CloudflareDrainFailure &&
        error.reason === "invalid_evidence" &&
        error.source === "observation" &&
        !error.message.includes(token),
    );
  }

  const clock = [10, 9];
  await assert.rejects(
    proveCloudflareDrain({
      candidateCommitSHA: candidateSHA,
      rawAdapter: sequenceAdapter([observation()]),
      now: () => clock.shift(),
      sleep: async () => undefined,
      wake: async () => undefined,
    }),
    (error) =>
      error instanceof CloudflareDrainFailure &&
      error.phase === "configuration" &&
      error.reason === "invalid_configuration",
  );
});

test("binds the rollout to the locally pushed candidate image digest", async () => {
  for (const digest of [
    `sha256:${"1".repeat(64)}`,
    `sha256:${"3".repeat(64)}`,
  ]) {
    await assert.rejects(
      proveCloudflareDrainImplementation({
        candidateCommitSHA: candidateSHA,
        rawAdapter: sequenceAdapter([
          ...stableBaseline(),
          observation({ candidate: true }),
        ]),
        resolveCandidateImageDigest: async () => digest,
        now: tickingClock(),
        sleep: async () => undefined,
        wake: async () => undefined,
      }),
      (error) =>
        error instanceof CloudflareDrainFailure &&
        error.phase === "drain" &&
        ["evidence_changed", "invalid_evidence"].includes(error.reason) &&
        (error.reason !== "invalid_evidence" ||
          error.source === "candidate_image"),
    );
  }
});

function response(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function envelope(result, resultInfo = undefined) {
  return {
    success: true,
    result,
    ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
  };
}

test("resolves one exact candidate RepoDigest without inheriting secrets", async () => {
  const calls = [];
  const digest = await resolveLocalCandidateImageDigest({
    accountId: accountID,
    applicationName,
    workerVersionId: ids.newWorkerVersion,
    execFileImpl: (...values) => {
      calls.push(values.slice(0, 3));
      values[3](
        null,
        `${JSON.stringify([
          `registry.cloudflare.com/${accountID}/${applicationName}@${candidateImageDigest}`,
          `example.invalid/other@sha256:${"4".repeat(64)}`,
        ])}\n`,
        "ignored bounded warning",
      );
    },
  });
  assert.equal(digest, candidateImageDigest);
  assert.deepEqual(calls[0][0], "docker");
  assert.deepEqual(calls[0][1], [
    "image",
    "inspect",
    "--format",
    "{{json .RepoDigests}}",
    `${applicationName}:10000000`,
  ]);
  assert.deepEqual(Object.keys(calls[0][2].env), ["PATH"]);
  assert.equal(calls[0][2].maxBuffer, 64 * 1024);
  assert.equal(calls[0][2].timeout, 30_000);
});

test("rejects missing, ambiguous, malformed, or failed local image evidence", async () => {
  const outputs = [
    [],
    [
      `registry.cloudflare.com/${accountID}/${applicationName}@${candidateImageDigest}`,
      `registry.cloudflare.com/${accountID}/${applicationName}@sha256:${"4".repeat(64)}`,
    ],
    [
      `registry.cloudflare.com/${accountID}/${applicationName}@${candidateImageDigest}`,
      `registry.cloudflare.com/${accountID}/${applicationName}@${candidateImageDigest}`,
    ],
    [`registry.cloudflare.com/${accountID}/${applicationName}@not-a-digest`],
    "not-an-array",
  ];
  for (const output of outputs) {
    await assert.rejects(
      resolveLocalCandidateImageDigest({
        accountId: accountID,
        applicationName,
        workerVersionId: ids.newWorkerVersion,
        execFileImpl: (_file, _args, _options, callback) =>
          callback(null, JSON.stringify(output), ""),
      }),
      /local candidate image evidence is invalid/,
    );
  }
  await assert.rejects(
    resolveLocalCandidateImageDigest({
      accountId: accountID,
      applicationName,
      workerVersionId: ids.newWorkerVersion,
      execFileImpl: (_file, _args, _options, callback) =>
        callback(new Error(token), token, token),
    }),
    (error) => error instanceof Error,
  );
});

function workerDeploymentEnvelope(candidate = false) {
  return envelope({
    deployments: [
      {
        id: candidate ? ids.newDeployment : ids.oldDeployment,
        created_on: "2026-09-07T00:00:00.000Z",
        source: "api",
        strategy: "percentage",
        versions: [
          {
            percentage: 100,
            version_id: candidate ? ids.newWorkerVersion : ids.oldWorkerVersion,
          },
        ],
      },
    ],
  });
}

function workerVersionEnvelope(candidate = false) {
  return envelope({
    id: candidate ? ids.newWorkerVersion : ids.oldWorkerVersion,
    annotations: {
      "workers/tag": candidate ? candidateSHA : previousSHA,
      "workers/triggered_by": "upload",
    },
  });
}

function applicationEnvelope(
  candidate = false,
  {
    includeDeprecatedInstances = true,
    applicationVersion = candidate ? 2 : 1,
  } = {},
) {
  return envelope({
    id: ids.application,
    created_at: "2026-09-07T00:00:00.000Z",
    account_id: accountID,
    name: applicationName,
    version: applicationVersion,
    ...(includeDeprecatedInstances ? { instances: 1 } : {}),
    max_instances: 1,
    scheduling_policy: "default",
    configuration: { image: candidate ? newImage : oldImage },
    health: {
      instances: {
        active: 1,
        healthy: 1,
        failed: 0,
        starting: 0,
        scheduling: 0,
      },
    },
  });
}

function rolloutEnvelope(candidate = false) {
  const values = candidate
    ? [
        {
          id: ids.newRollout,
          description: "Progressive update",
          created_at: "2026-09-07T00:10:00.000Z",
          last_updated_at: "2026-09-07T00:11:00.000Z",
          kind: "full_auto",
          strategy: "rolling",
          current_version: 1,
          target_version: 2,
          current_configuration: { image: oldImage },
          target_configuration: { image: newImage },
          status: "completed",
          health: {},
          steps: [],
          progress: {
            total_steps: 1,
            current_step: 1,
            updated_instances: 1,
            total_instances: 1,
          },
        },
      ]
    : [];
  return envelope(values);
}

function historicalRolloutWithoutImageEnvelope() {
  const value = structuredClone(rolloutEnvelope(true).result[0]);
  value.id = ids.oldRollout;
  value.created_at = "2026-09-07T00:00:00.000Z";
  value.current_version = 1;
  value.target_version = 1;
  value.current_configuration = {};
  value.target_configuration = {};
  return envelope([value]);
}

function rawRollout(index) {
  const value = structuredClone(rolloutEnvelope(true).result[0]);
  value.id = `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
  value.created_at = `2026-09-07T00:${String(index % 60).padStart(2, "0")}:00.000Z`;
  return value;
}

function instanceEnvelope(
  candidate = false,
  resultInfo = { per_page: 50, next_page_token: null },
  {
    healthOnly = false,
    includeImage = true,
    applicationVersion = candidate ? 2 : 1,
  } = {},
) {
  return envelope(
    {
      instances: [
        {
          id: candidate ? ids.newInstance : ids.oldInstance,
          created_at: "2026-09-07T00:00:00.000Z",
          location: "nrt",
          app_version: applicationVersion,
          ...(includeImage ? { image: candidate ? newImage : oldImage } : {}),
          current_placement: {
            id: "00000000-0000-4000-8000-00000000000b",
            created_at: "2026-09-07T00:00:00.000Z",
            deployment_id: "00000000-0000-4000-8000-00000000000c",
            deployment_version: 1,
            terminate: false,
            status: {
              health: healthOnly ? "running" : "healthy",
              ready: true,
              ...(healthOnly ? {} : { container_status: "running" }),
            },
          },
        },
      ],
    },
    resultInfo,
  );
}

function productionFetch({
  candidate = false,
  currentSchema = false,
  historicalRolloutWithoutImage = false,
  applicationVersion = candidate ? 2 : 1,
} = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/deployments")) {
      return response(workerDeploymentEnvelope(candidate));
    }
    if (
      parsed.pathname.includes("/workers/scripts/") &&
      parsed.pathname.includes("/versions/")
    ) {
      return response(workerVersionEnvelope(candidate));
    }
    if (parsed.pathname.endsWith("/containers/dash/applications")) {
      return response(
        envelope([{ id: ids.application, name: applicationName }], {
          per_page: 50,
          next_page_token: null,
        }),
      );
    }
    if (
      parsed.pathname.endsWith(`/containers/applications/${ids.application}`)
    ) {
      return response(
        applicationEnvelope(candidate, {
          includeDeprecatedInstances: !currentSchema,
          applicationVersion,
        }),
      );
    }
    if (
      parsed.pathname.endsWith(
        `/containers/applications/${ids.application}/rollouts`,
      )
    ) {
      return response(
        historicalRolloutWithoutImage
          ? historicalRolloutWithoutImageEnvelope()
          : rolloutEnvelope(candidate),
      );
    }
    if (
      parsed.pathname.endsWith(
        `/containers/dash/applications/${ids.application}/instances`,
      )
    ) {
      return response(
        instanceEnvelope(candidate, undefined, {
          healthOnly: currentSchema,
          includeImage: !currentSchema,
          applicationVersion,
        }),
      );
    }
    throw new Error("unexpected test URL");
  };
  return { requests, fetchImpl };
}

test("production adapter uses fixed GET endpoints and returns only normalized evidence", async () => {
  const fake = productionFetch();
  const adapter = createCloudflareRawAdapter({
    accountId: accountID,
    apiToken: token,
    workerName,
    containerApplicationName: applicationName,
    fetchImpl: fake.fetchImpl,
  });
  const expected = observation();
  expected.container.rollouts = [];
  assert.deepEqual(
    await adapter.readObservation({ phase: "baseline" }),
    expected,
  );
  assert.equal(fake.requests.length, 9);
  for (const request of fake.requests) {
    const parsed = new URL(request.url);
    assert.equal(parsed.origin, "https://api.cloudflare.com");
    assert.ok(parsed.pathname.startsWith(`/client/v4/accounts/${accountID}/`));
    assert.equal(request.options.method, "GET");
    assert.equal(request.options.redirect, "error");
    assert.equal(request.options.headers.Authorization, `Bearer ${token}`);
    assert.doesNotMatch(request.url, new RegExp(token));
  }
});

test("production adapter maps only absent legacy Worker annotations or tag to null", async () => {
  for (const absent of ["annotations", "tag"]) {
    const fake = productionFetch();
    const adapter = createCloudflareRawAdapter({
      accountId: accountID,
      apiToken: token,
      workerName,
      containerApplicationName: applicationName,
      fetchImpl: async (url, options) => {
        if (new URL(url).pathname.includes("/versions/")) {
          const value = workerVersionEnvelope();
          if (absent === "annotations") {
            delete value.result.annotations;
          } else {
            delete value.result.annotations["workers/tag"];
          }
          return response(value);
        }
        return fake.fetchImpl(url, options);
      },
    });
    const expected = observation({ workerTag: null });
    expected.container.rollouts = [];

    assert.deepEqual(
      await adapter.readObservation({ phase: "baseline" }),
      expected,
    );
  }
});

test("production adapter rejects a present malformed Worker tag without echo", async () => {
  for (const malformedTag of ["", token, null, "A".repeat(40)]) {
    const fake = productionFetch();
    const adapter = createCloudflareRawAdapter({
      accountId: accountID,
      apiToken: token,
      workerName,
      containerApplicationName: applicationName,
      fetchImpl: async (url, options) => {
        if (new URL(url).pathname.includes("/versions/")) {
          const value = workerVersionEnvelope();
          value.result.annotations["workers/tag"] = malformedTag;
          return response(value);
        }
        return fake.fetchImpl(url, options);
      },
    });

    await assert.rejects(
      adapter.readObservation({ phase: "baseline" }),
      (error) =>
        error instanceof CloudflareDrainFailure &&
        error.reason === "invalid_evidence" &&
        error.source === "worker_version" &&
        !error.message.includes(token),
    );
  }
});

test("production adapter accepts the current Containers application and placement schema", async () => {
  const fake = productionFetch({
    currentSchema: true,
    historicalRolloutWithoutImage: true,
  });
  const adapter = createCloudflareRawAdapter({
    accountId: accountID,
    apiToken: token,
    workerName,
    containerApplicationName: applicationName,
    fetchImpl: fake.fetchImpl,
  });
  const expected = observation();
  expected.container.rollouts = [
    rollout({
      targetImage: null,
    }),
  ];
  expected.container.instances[0].image = null;
  assert.deepEqual(
    await adapter.readObservation({ phase: "baseline" }),
    expected,
  );
});

test("production adapter preserves a complete idle instance inventory", async () => {
  const fake = productionFetch();
  const adapter = createCloudflareRawAdapter({
    accountId: accountID,
    apiToken: token,
    workerName,
    containerApplicationName: applicationName,
    fetchImpl: async (url, options) => {
      if (
        new URL(url).pathname.endsWith(
          `/containers/dash/applications/${ids.application}/instances`,
        )
      ) {
        return response(
          envelope({ instances: [] }, { per_page: 50, next_page_token: null }),
        );
      }
      return fake.fetchImpl(url, options);
    },
  });
  const expected = observation({ instances: [] });
  expected.container.rollouts = [];
  assert.deepEqual(
    await adapter.readObservation({ phase: "baseline" }),
    expected,
  );
});

test("production adapter rejects a missing or non-array instance inventory", async () => {
  for (const invalidResult of [{}, { instances: null }]) {
    const fake = productionFetch();
    const adapter = createCloudflareRawAdapter({
      accountId: accountID,
      apiToken: token,
      workerName,
      containerApplicationName: applicationName,
      fetchImpl: async (url, options) => {
        if (
          new URL(url).pathname.endsWith(
            `/containers/dash/applications/${ids.application}/instances`,
          )
        ) {
          return response(envelope(invalidResult));
        }
        return fake.fetchImpl(url, options);
      },
    });
    await assert.rejects(
      adapter.readObservation({ phase: "baseline" }),
      (error) =>
        error instanceof CloudflareDrainFailure &&
        error.reason === "invalid_evidence" &&
        error.source === "instance_inventory",
    );
  }
});

test("production adapter classifies an invalid application without exposing it", async () => {
  const fake = productionFetch();
  const adapter = createCloudflareRawAdapter({
    accountId: accountID,
    apiToken: token,
    workerName,
    containerApplicationName: applicationName,
    fetchImpl: async (url, options) => {
      if (
        new URL(url).pathname.endsWith(
          `/containers/applications/${ids.application}`,
        )
      ) {
        const value = applicationEnvelope();
        value.result.max_instances = token;
        return response(value);
      }
      return fake.fetchImpl(url, options);
    },
  });

  await assert.rejects(
    adapter.readObservation({ phase: "baseline" }),
    (error) =>
      error instanceof CloudflareDrainFailure &&
      error.reason === "invalid_evidence" &&
      error.source === "application" &&
      !error.message.includes(token),
  );
});

test("production adapter accepts the initial Containers application version zero", async () => {
  const baseline = productionFetch({
    currentSchema: true,
    applicationVersion: 0,
  });
  const adapter = createCloudflareRawAdapter({
    accountId: accountID,
    apiToken: token,
    workerName,
    containerApplicationName: applicationName,
    fetchImpl: async (url, options) => {
      if (
        new URL(url).pathname.endsWith(
          `/containers/applications/${ids.application}/rollouts`,
        )
      ) {
        const value = rawRollout(1);
        value.id = ids.oldRollout;
        value.created_at = "2026-09-07T00:00:00.000Z";
        value.current_version = 0;
        value.target_version = 0;
        value.current_configuration = {};
        value.target_configuration = {};
        return response(envelope([value]));
      }
      return baseline.fetchImpl(url, options);
    },
  });
  const expected = observation({
    baselineVersion: 0,
    instances: [instance({ version: 0, image: null })],
  });
  expected.container.rollouts = [
    rollout({ currentVersion: 0, targetVersion: 0, targetImage: null }),
  ];
  assert.deepEqual(
    await adapter.readObservation({ phase: "baseline" }),
    expected,
  );
});

test("production adapter rejects a malformed optional instance image without exposing it", async () => {
  const fake = productionFetch({ currentSchema: true });
  const adapter = createCloudflareRawAdapter({
    accountId: accountID,
    apiToken: token,
    workerName,
    containerApplicationName: applicationName,
    fetchImpl: async (url, options) => {
      if (
        new URL(url).pathname.endsWith(
          `/containers/dash/applications/${ids.application}/instances`,
        )
      ) {
        const invalid = instanceEnvelope(false, undefined, {
          healthOnly: true,
        });
        invalid.result.instances[0].image = token;
        return response(invalid);
      }
      return fake.fetchImpl(url, options);
    },
  });
  await assert.rejects(
    adapter.readObservation({ phase: "baseline" }),
    (error) =>
      error instanceof CloudflareDrainFailure &&
      error.reason === "invalid_evidence" &&
      error.source === "instance_inventory" &&
      !error.message.includes(token),
  );
});

test("production adapter follows bounded cursor pagination and rejects cycles", async () => {
  const fake = productionFetch();
  let applicationPage = 0;
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/containers/dash/applications")) {
      applicationPage += 1;
      if (applicationPage === 1) {
        return response(
          envelope([], { per_page: 50, next_page_token: "next-safe-page" }),
        );
      }
      assert.equal(parsed.searchParams.get("page_token"), "next-safe-page");
      return response(
        envelope([{ id: ids.application, name: applicationName }], {
          page_token: "next-safe-page",
          per_page: 50,
        }),
      );
    }
    return fake.fetchImpl(url, options);
  };
  const adapter = createCloudflareRawAdapter({
    accountId: accountID,
    apiToken: token,
    workerName,
    containerApplicationName: applicationName,
    fetchImpl,
  });
  assert.equal(
    (await adapter.readObservation({ phase: "baseline" })).container
      .applicationId,
    ids.application,
  );
  assert.equal(applicationPage, 2);

  const cyclicFetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/containers/dash/applications")) {
      const requested = parsed.searchParams.get("page_token");
      return response(
        envelope([], {
          ...(requested === null ? {} : { page_token: requested }),
          per_page: 50,
          next_page_token: "same-page",
        }),
      );
    }
    return fake.fetchImpl(url, options);
  };
  const cyclicAdapter = createCloudflareRawAdapter({
    accountId: accountID,
    apiToken: token,
    workerName,
    containerApplicationName: applicationName,
    fetchImpl: cyclicFetch,
  });
  await assert.rejects(
    cyclicAdapter.readObservation({ phase: "baseline" }),
    (error) =>
      error instanceof CloudflareDrainFailure &&
      error.reason === "invalid_evidence" &&
      error.source === "application_inventory",
  );
});

test("production adapter accepts exactly 50 rollouts and follows rollout pagination", async () => {
  for (const extraRollouts of [0, 1]) {
    const fake = productionFetch();
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      rawRollout(index + 1),
    );
    const secondPage = Array.from({ length: extraRollouts }, (_, index) =>
      rawRollout(index + 51),
    );
    let rolloutPage = 0;
    const adapter = createCloudflareRawAdapter({
      accountId: accountID,
      apiToken: token,
      workerName,
      containerApplicationName: applicationName,
      fetchImpl: async (url, options) => {
        const parsed = new URL(url);
        if (
          parsed.pathname.endsWith(
            `/containers/applications/${ids.application}/rollouts`,
          )
        ) {
          rolloutPage += 1;
          assert.equal(parsed.searchParams.get("limit"), "50");
          if (rolloutPage === 1) {
            assert.equal(parsed.searchParams.has("last"), false);
            return response(envelope(firstPage));
          }
          assert.equal(parsed.searchParams.get("last"), firstPage.at(-1).id);
          return response(envelope(secondPage));
        }
        return fake.fetchImpl(url, options);
      },
    });

    const value = await adapter.readObservation({ phase: "baseline" });
    assert.equal(value.container.rollouts.length, 50 + extraRollouts);
    assert.equal(rolloutPage, 2);
  }
});

test("production adapter rejects repeated and unbounded rollout pages", async () => {
  for (const mode of ["duplicate", "unbounded"]) {
    const fake = productionFetch();
    let rolloutPage = 0;
    const adapter = createCloudflareRawAdapter({
      accountId: accountID,
      apiToken: token,
      workerName,
      containerApplicationName: applicationName,
      fetchImpl: async (url, options) => {
        const parsed = new URL(url);
        if (
          parsed.pathname.endsWith(
            `/containers/applications/${ids.application}/rollouts`,
          )
        ) {
          rolloutPage += 1;
          const start = (rolloutPage - 1) * 50 + 1;
          const page = Array.from({ length: 50 }, (_, index) =>
            rawRollout(start + index),
          );
          if (mode === "duplicate" && rolloutPage === 2) {
            page[0] = rawRollout(50);
          }
          return response(envelope(page));
        }
        return fake.fetchImpl(url, options);
      },
    });

    await assert.rejects(
      adapter.readObservation({ phase: "baseline" }),
      (error) =>
        error instanceof CloudflareDrainFailure &&
        error.reason === "invalid_evidence" &&
        error.source === "rollout_inventory",
    );
    assert.equal(rolloutPage, mode === "duplicate" ? 2 : 4);
  }
});

test("production adapter rejects worker or container changes inside one observation", async () => {
  for (const changedResource of ["worker", "worker-tag", "container"]) {
    const baseline = productionFetch();
    const candidate = productionFetch({ candidate: true });
    let deploymentReads = 0;
    let versionReads = 0;
    let applicationReads = 0;
    const adapter = createCloudflareRawAdapter({
      accountId: accountID,
      apiToken: token,
      workerName,
      containerApplicationName: applicationName,
      fetchImpl: async (url, options) => {
        const pathname = new URL(url).pathname;
        if (pathname.endsWith("/deployments")) {
          deploymentReads += 1;
          if (changedResource === "worker" && deploymentReads === 2) {
            return candidate.fetchImpl(url, options);
          }
        }
        if (pathname.includes("/versions/")) {
          versionReads += 1;
          if (changedResource === "worker-tag" && versionReads === 2) {
            const changed = workerVersionEnvelope();
            changed.result.annotations["workers/tag"] = candidateSHA;
            return response(changed);
          }
        }
        if (pathname.endsWith(`/containers/applications/${ids.application}`)) {
          applicationReads += 1;
          if (changedResource === "container" && applicationReads === 2) {
            return candidate.fetchImpl(url, options);
          }
        }
        return baseline.fetchImpl(url, options);
      },
    });
    await assert.rejects(
      adapter.readObservation({ phase: "drain" }),
      (error) =>
        error instanceof CloudflareDrainFailure &&
        error.phase === "drain" &&
        error.reason === "evidence_changed",
    );
  }
});

test("production adapter rejects a tag appearing during an untagged observation", async () => {
  const fake = productionFetch();
  let versionReads = 0;
  const adapter = createCloudflareRawAdapter({
    accountId: accountID,
    apiToken: token,
    workerName,
    containerApplicationName: applicationName,
    fetchImpl: async (url, options) => {
      if (new URL(url).pathname.includes("/versions/")) {
        versionReads += 1;
        const value = workerVersionEnvelope();
        if (versionReads === 1) {
          delete value.result.annotations["workers/tag"];
        }
        return response(value);
      }
      return fake.fetchImpl(url, options);
    },
  });

  await assert.rejects(
    adapter.readObservation({ phase: "baseline" }),
    (error) =>
      error instanceof CloudflareDrainFailure &&
      error.phase === "baseline" &&
      error.reason === "evidence_changed",
  );
});

test("production adapter applies the remaining drain deadline to every API request", async () => {
  const fake = productionFetch();
  let currentTime = 0;
  const adapter = createCloudflareRawAdapter({
    accountId: accountID,
    apiToken: token,
    workerName,
    containerApplicationName: applicationName,
    requestNow: () => currentTime,
    fetchImpl: async (url, options) => {
      currentTime += 3;
      return fake.fetchImpl(url, options);
    },
  });
  await assert.rejects(
    adapter.readObservation({
      phase: "drain",
      timeoutMilliseconds: 10,
    }),
    (error) =>
      error instanceof CloudflareDrainFailure &&
      error.phase === "drain" &&
      error.reason === "evidence_timeout",
  );
  assert.ok(fake.requests.length < 9);
});

test("production adapter rejects auth, unknown status, oversized and unknown envelopes without echo", async () => {
  for (const [fetchImpl, reason, source] of [
    [
      async () => response({ private: token }, 401),
      "authorization_rejected",
      "none",
    ],
    [
      async () => response({ private: token }, 403),
      "authorization_rejected",
      "none",
    ],
    [
      async () => response({ private: token }, 429),
      "provider_rejected",
      "none",
    ],
    [
      async () =>
        response(workerDeploymentEnvelope(), 200, {
          "content-length": String(64 * 1024 + 1),
        }),
      "invalid_evidence",
      "provider_response",
    ],
    [
      async () => response({ ...workerDeploymentEnvelope(), unknown: token }),
      "invalid_evidence",
      "worker_deployment",
    ],
  ]) {
    const adapter = createCloudflareRawAdapter({
      accountId: accountID,
      apiToken: token,
      workerName,
      containerApplicationName: applicationName,
      fetchImpl,
      requestSleep: async () => undefined,
    });
    await assert.rejects(
      adapter.readObservation({ phase: "baseline" }),
      (error) =>
        error instanceof CloudflareDrainFailure &&
        error.reason === reason &&
        error.source === source &&
        error.message === "cloudflare drain evidence failed" &&
        !error.message.includes(token),
    );
  }
});

test("production adapter retries only transient request failures with fixed delays", async () => {
  const fake = productionFetch();
  const transient = [
    new Error("private network detail"),
    response({ private: token }, 503, { "retry-after": "9999" }),
    response({ private: token }, 429, { "retry-after": "9999" }),
  ];
  let workerAttempts = 0;
  const sleeps = [];
  const adapter = createCloudflareRawAdapter({
    accountId: accountID,
    apiToken: token,
    workerName,
    containerApplicationName: applicationName,
    requestSleep: async (milliseconds) => sleeps.push(milliseconds),
    fetchImpl: async (url, options) => {
      if (new URL(url).pathname.endsWith("/deployments")) {
        workerAttempts += 1;
        const next = transient.shift();
        if (next instanceof Error) throw next;
        if (next !== undefined) return next;
      }
      return fake.fetchImpl(url, options);
    },
  });
  const value = await adapter.readObservation({ phase: "baseline" });
  assert.equal(value.worker.versionId, ids.oldWorkerVersion);
  assert.equal(workerAttempts, 5);
  assert.deepEqual(sleeps, [250, 1_000, 2_000]);

  let exhaustedAttempts = 0;
  const exhaustedSleeps = [];
  const exhausted = createCloudflareRawAdapter({
    accountId: accountID,
    apiToken: token,
    workerName,
    containerApplicationName: applicationName,
    requestSleep: async (milliseconds) => exhaustedSleeps.push(milliseconds),
    fetchImpl: async () => {
      exhaustedAttempts += 1;
      return response({ private: token }, 500);
    },
  });
  await assert.rejects(
    exhausted.readObservation({ phase: "baseline" }),
    (error) =>
      error instanceof CloudflareDrainFailure &&
      error.reason === "provider_rejected" &&
      !error.message.includes(token),
  );
  assert.equal(exhaustedAttempts, 4);
  assert.deepEqual(exhaustedSleeps, [250, 1_000, 2_000]);
});

test("diagnostics expose only closed enums and validated run metadata", () => {
  assert.deepEqual(cloudflareDrainPhases, [
    "configuration",
    "baseline",
    "deployment",
    "drain",
    "stability",
  ]);
  assert.ok(cloudflareDrainReasons.includes("authorization_rejected"));
  for (const reason of [
    "baseline_active_rollout",
    "baseline_instance_not_running",
    "baseline_instance_version_mismatch",
    "baseline_instance_image_reference_mismatch",
  ]) {
    assert.ok(cloudflareDrainReasons.includes(reason));
    const baselineDiagnostic = formatCloudflareDrainDiagnostic(
      new CloudflareDrainFailure("baseline", reason),
      { runID: "123", runAttempt: "2", commitSHA: candidateSHA },
    );
    assert.equal(
      parseCloudflareDrainDiagnosticLine(baselineDiagnostic),
      baselineDiagnostic,
    );
    assert.doesNotMatch(baselineDiagnostic, new RegExp(token));
  }
  assert.deepEqual(cloudflareDrainSources, [
    "none",
    "provider_response",
    "worker_deployment",
    "worker_version",
    "application_inventory",
    "application",
    "rollout_inventory",
    "instance_inventory",
    "observation",
    "candidate_image",
  ]);
  const failure = new CloudflareDrainFailure("drain", "evidence_timeout");
  const diagnostic = formatCloudflareDrainDiagnostic(failure, {
    runID: "123",
    runAttempt: "2",
    commitSHA: candidateSHA,
  });
  assert.equal(
    diagnostic,
    `::error::Cloudflare drain evidence failed; phase=drain; reason=evidence_timeout; source=none; run_id=123; run_attempt=2; commit_sha=${candidateSHA}.`,
  );
  assert.equal(parseCloudflareDrainDiagnosticLine(diagnostic), diagnostic);
  for (const invalid of [
    `${diagnostic}\nprivate`,
    diagnostic.replace("phase=drain", "phase=private"),
    diagnostic.replace("reason=evidence_timeout", "reason=private"),
    diagnostic.replace("source=none", "source=private"),
    diagnostic.replace("source=none", "source=worker_version"),
    diagnostic.replace("run_id=123", `run_id=${token}`),
    "x".repeat(513),
  ]) {
    assert.equal(parseCloudflareDrainDiagnosticLine(invalid), undefined);
  }
  assert.doesNotMatch(diagnostic, /private|token|response|account_id/i);
  assert.throws(
    () => new CloudflareDrainFailure("secret-phase", "evidence_timeout"),
  );
  assert.throws(
    () => new CloudflareDrainFailure("baseline", "invalid_evidence"),
  );
  assert.throws(
    () => new CloudflareDrainFailure("baseline", "invalid_evidence", "private"),
  );
  const workerVersionFailure = new CloudflareDrainFailure(
    "baseline",
    "invalid_evidence",
    "worker_version",
  );
  const workerVersionDiagnostic = formatCloudflareDrainDiagnostic(
    workerVersionFailure,
    { runID: "123", runAttempt: "2", commitSHA: candidateSHA },
  );
  assert.equal(
    parseCloudflareDrainDiagnosticLine(workerVersionDiagnostic),
    workerVersionDiagnostic,
  );
  assert.doesNotMatch(workerVersionDiagnostic, new RegExp(token));
  assert.throws(() =>
    formatCloudflareDrainDiagnostic(failure, {
      runID: token,
      runAttempt: "2",
      commitSHA: candidateSHA,
    }),
  );
});

function outputBuffer() {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString("utf8");
        callback();
      },
    }),
    value: () => value,
  };
}

test("argumentless CLI keeps the wake protocol and result free of raw payloads", async () => {
  const input = new PassThrough();
  input.end("candidate_deploy_completed\n");
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  let requestCount = 0;
  const fetchImpl = async (url, options) => {
    const candidate = requestCount >= 18;
    requestCount += 1;
    return productionFetch({ candidate }).fetchImpl(url, options);
  };
  const status = await runCloudflareDrainEvidenceCLI({
    argv: [],
    env: {
      COMMIT_SHA: candidateSHA,
      CLOUDFLARE_ACCOUNT_ID: accountID,
      CLOUDFLARE_API_TOKEN: token,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
    },
    input,
    output: stdout.stream,
    errorOutput: stderr.stream,
    fetchImpl,
    resolveCandidateImageDigest: async ({ workerVersionId }) => {
      assert.equal(workerVersionId, ids.newWorkerVersion);
      return candidateImageDigest;
    },
    now: tickingClock(),
    sleep: async () => undefined,
  });
  assert.equal(status, 0);
  const lines = stdout.value().trim().split("\n");
  assert.equal(lines[0], "cloudflare_drain_baseline_ready");
  const evidence = JSON.parse(lines[1]);
  assert.equal(evidence.result, "drained");
  assert.equal(evidence.commitSHA, candidateSHA);
  assert.equal(evidence.containerRolloutId, ids.newRollout);
  assert.equal(stderr.value(), "");
  assert.doesNotMatch(stdout.value(), new RegExp(token));
});

test("CLI reports a secret-safe closed reason for a nonconverging baseline", async () => {
  const fake = productionFetch();
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const fetchImpl = async (url, options) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith(`/containers/applications/${ids.application}`)) {
      const value = applicationEnvelope();
      value.result.active_rollout_id = ids.oldRollout;
      return response(value);
    }
    if (
      pathname.endsWith(`/containers/applications/${ids.application}/rollouts`)
    ) {
      return response(historicalRolloutWithoutImageEnvelope());
    }
    return fake.fetchImpl(url, options);
  };

  const status = await runCloudflareDrainEvidenceCLI({
    argv: [],
    env: {
      COMMIT_SHA: candidateSHA,
      CLOUDFLARE_ACCOUNT_ID: accountID,
      CLOUDFLARE_API_TOKEN: token,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
    },
    input: new PassThrough(),
    output: stdout.stream,
    errorOutput: stderr.stream,
    fetchImpl,
    now: tickingClock(100_000),
    sleep: async () => undefined,
  });

  assert.equal(status, 1);
  assert.equal(stdout.value(), "");
  assert.equal(
    stderr.value(),
    `::error::Cloudflare drain evidence failed; phase=baseline; reason=baseline_active_rollout; source=none; run_id=123; run_attempt=1; commit_sha=${candidateSHA}.\n`,
  );
  assert.doesNotMatch(stderr.value(), new RegExp(token));
  assert.doesNotMatch(stderr.value(), /rollout_id|status|version|image/i);
});

test("CLI rejects arguments and reports only a closed diagnostic", async () => {
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const status = await runCloudflareDrainEvidenceCLI({
    argv: [token],
    env: { COMMIT_SHA: candidateSHA },
    input: new PassThrough(),
    output: stdout.stream,
    errorOutput: stderr.stream,
    fetchImpl: async () => {
      throw new Error("fetch must not run");
    },
  });
  assert.equal(status, 1);
  assert.equal(stdout.value(), "");
  assert.equal(
    stderr.value(),
    `::error::Cloudflare drain evidence failed; phase=configuration; reason=invalid_configuration; source=none; run_id=local; run_attempt=local; commit_sha=${candidateSHA}.\n`,
  );
  assert.doesNotMatch(stderr.value(), new RegExp(token));
});
