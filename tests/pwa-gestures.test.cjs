const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('pinch is blocked while one-finger and normal wheel scrolling remain available', () => {
  const handlers = {};
  vm.runInNewContext(fs.readFileSync('public/pwa-gestures.js', 'utf8'), {
    document: {addEventListener(type, handler, options) {
      assert.equal(options.passive, false);
      handlers[type] = handler;
    }},
  });
  for (const type of ['touchstart', 'touchmove']) {
    for (const count of [1, 2, 3]) {
      let prevented = false;
      handlers[type]({touches: new Array(count), preventDefault() {prevented = true;}});
      assert.equal(prevented, count > 1);
    }
  }
  for (const type of ['gesturestart', 'gesturechange']) {
    let prevented = false;
    handlers[type]({preventDefault() {prevented = true;}});
    assert.equal(prevented, true);
  }
  for (const ctrlKey of [false, true]) {
    let prevented = false;
    handlers.wheel({ctrlKey, preventDefault() {prevented = true;}});
    assert.equal(prevented, ctrlKey);
  }
});
