#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  FeishuInstanceCoordinator
} = require('../src/feishuInstanceCoordinator');

const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'remote-codex-instances-')
);
const livePids = new Set([41001, 41002]);
const states = [];
const options = {
  directory,
  pollIntervalMs: 0,
  isProcessAlive: (pid) => livePids.has(pid),
  logger: { warn() {} }
};

try {
  const first = new FeishuInstanceCoordinator({
    ...options,
    instanceId: 'first',
    pid: 41001,
    startedAt: 100,
    onState: (state) => states.push({ source: 'first', ...state })
  });
  assert.deepEqual(first.start(), {
    instanceId: 'first',
    instanceCount: 1,
    multiple: false,
    selected: true,
    ownerId: 'first'
  });
  assert.equal(first.tryAcquireConnectionLease(), true);

  const second = new FeishuInstanceCoordinator({
    ...options,
    instanceId: 'second',
    pid: 41002,
    startedAt: 200,
    onState: (state) => states.push({ source: 'second', ...state })
  });
  const secondState = second.start();
  assert.equal(secondState.multiple, true);
  assert.equal(secondState.selected, true, 'the newest window must become the default');

  const firstAfterSecondLaunch = first.refresh();
  assert.equal(firstAfterSecondLaunch.multiple, true);
  assert.equal(firstAfterSecondLaunch.selected, false);
  assert.equal(
    second.tryAcquireConnectionLease(),
    false,
    'the new window must wait until the old Feishu connection is closed'
  );
  assert.equal(first.releaseConnectionLease(), true);
  assert.equal(second.tryAcquireConnectionLease(), true);

  const firstSelected = first.setSelected(true);
  assert.equal(firstSelected.selected, true);
  assert.equal(second.refresh().selected, false);
  assert.equal(first.tryAcquireConnectionLease(), false);
  assert.equal(second.releaseConnectionLease(), true);
  assert.equal(first.tryAcquireConnectionLease(), true);

  assert.equal(first.setSelected(false).selected, false);
  assert.equal(second.refresh().selected, false, 'clearing the checkbox may disconnect all windows');
  assert.equal(first.releaseConnectionLease(), true);

  second.stop({ releaseLease: true });
  const remainingState = first.refresh();
  assert.equal(remainingState.multiple, false);
  assert.equal(remainingState.selected, true, 'a sole remaining window reconnects automatically');

  fs.writeFileSync(
    path.join(directory, 'instance-stale.json'),
    JSON.stringify({
      instanceId: 'stale',
      pid: 49999,
      startedAt: 999,
      heartbeatAt: Date.now()
    })
  );
  first.refresh();
  assert.equal(fs.existsSync(path.join(directory, 'instance-stale.json')), false);
  assert.ok(states.some((state) => state.instanceCount === 2));

  first.stop({ releaseLease: true });
  process.stdout.write('Feishu multi-instance coordinator tests passed.\n');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
