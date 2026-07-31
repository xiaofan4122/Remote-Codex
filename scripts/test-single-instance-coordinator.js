const assert = require('node:assert/strict');
const { configureSingleInstance } = require('../src/singleInstanceCoordinator');

function main() {
  testSecondaryProcessQuits();
  testSecondLaunchFocusesPrimaryWindow();
  testMissingWindowIsSafe();
  process.stdout.write('Single-instance coordinator tests passed.\n');
}

function testSecondaryProcessQuits() {
  let quitCalls = 0;
  let registered = false;
  const acquired = configureSingleInstance({
    app: {
      requestSingleInstanceLock: () => false,
      quit: () => { quitCalls += 1; },
      on: () => { registered = true; }
    },
    getMainWindow: () => null
  });

  assert.equal(acquired, false);
  assert.equal(quitCalls, 1);
  assert.equal(registered, false);
}

function testSecondLaunchFocusesPrimaryWindow() {
  let secondInstanceHandler;
  const calls = [];
  const events = [];
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus')
  };
  const acquired = configureSingleInstance({
    app: {
      requestSingleInstanceLock: () => true,
      quit: () => assert.fail('the primary process must not quit'),
      on(name, handler) {
        assert.equal(name, 'second-instance');
        secondInstanceHandler = handler;
      }
    },
    getMainWindow: () => window,
    logger: {
      event(name, meta) {
        events.push({ name, meta });
      }
    }
  });

  assert.equal(acquired, true);
  secondInstanceHandler({}, [], '/tmp/project');
  assert.deepEqual(calls, ['restore', 'show', 'focus']);
  assert.deepEqual(events, [{
    name: 'app.second_instance.focused',
    meta: { workingDirectory: '/tmp/project' }
  }]);
}

function testMissingWindowIsSafe() {
  let secondInstanceHandler;
  configureSingleInstance({
    app: {
      requestSingleInstanceLock: () => true,
      quit() {},
      on(_name, handler) {
        secondInstanceHandler = handler;
      }
    },
    getMainWindow: () => null,
    logger: { event() {} }
  });

  assert.doesNotThrow(() => secondInstanceHandler({}, [], ''));
}

main();
