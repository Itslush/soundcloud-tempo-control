const assert = require('node:assert/strict');
const vm = require('node:vm');
const adapter = require('./module-fixture.cjs')(['tempo-dependency.js']);

async function check({
  reject = false,
  throws = false,
  supplied = false,
  inherited = false,
} = {}) {
  const revoked = [];
  const failure = new Error('worklet load failed');
  const url = supplied ? 'blob:caller-owned' : 'blob:library-owned';
  const options = { numberOfInputs: 1 };
  const methods = {
    addModule(value) {
      assert.equal(this, worklet);
      assert.equal(value, url);
      if (throws) throw failure;
      return reject ? Promise.reject(failure) : Promise.resolve('node');
    },
  };
  const worklet = inherited ? Object.create(methods) : methods;
  const original = worklet.addModule;
  const descriptor = Object.getOwnPropertyDescriptor(worklet, 'addModule');
  const library = (context, received) => {
    assert.equal(received, options);
    return context.audioWorklet.addModule(url);
  };
  if (supplied) library.moduleUrl = url;
  const create = vm.runInNewContext(
    adapter +
      ';(context, options) => createStretchNode(context, options, SignalsmithFixture)',
    {
      SignalsmithFixture: library,
      URL: { revokeObjectURL: (value) => revoked.push(value) },
    },
  );
  if (throws)
    assert.throws(() => create({ audioWorklet: worklet }, options), failure);
  else {
    const pending = create({ audioWorklet: worklet }, options);
    assert.equal(worklet.addModule, original);
    assert.deepEqual(revoked, []);
    if (reject) await assert.rejects(pending, failure);
    else assert.equal(await pending, 'node');
  }
  assert.equal(worklet.addModule, original);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(worklet, 'addModule'),
    descriptor,
  );
  assert.deepEqual(revoked, supplied ? [] : [url]);
}

async function main() {
  for (const supplied of [false, true]) {
    for (const inherited of [false, true]) {
      await check({ supplied, inherited });
      await check({ supplied, inherited, reject: true });
      await check({ supplied, inherited, throws: true });
    }
  }
  const missing = vm.runInNewContext(adapter + ';createStretchNode');
  assert.throws(() => missing({}, {}, null), /dependency is unavailable/);
  console.log(
    'Dependency adapter: URL ownership, success/failure cleanup, immediate method restoration and missing dependency passed.',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
