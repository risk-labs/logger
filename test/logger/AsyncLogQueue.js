const { assert } = require("chai");
const { AsyncLogQueue } = require("../../dist/logger/AsyncLogQueue");

// Blocks until the queue reports itself flushed. Mocha's timeout catches a queue that never drains.
const flush = async (queue) => {
  while (!queue.isFlushed) await new Promise((resolve) => setTimeout(resolve, 5));
};

// Returns a promise plus the function that resolves it, to hold a delivery open for as long as a test needs.
const pending = () => {
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  return { promise, release };
};

describe("AsyncLogQueue", function () {
  it("Accepts elements without waiting for delivery", async function () {
    const delivered = [];
    const blocked = pending();
    const queue = new AsyncLogQueue({
      maxQueueSize: 3,
      deliver: async (element) => {
        await blocked.promise;
        delivered.push(element);
      },
      onError: () => assert.fail("should not error"),
    });

    // A hung delivery must not block the caller: this is the whole point of the queue.
    queue.enqueue("first", "second");
    assert.isFalse(queue.isFlushed);
    assert.deepEqual(delivered, []);

    blocked.release();
    await flush(queue);
    assert.deepEqual(delivered, ["first", "second"]);
  });

  it("Delivers elements in order", async function () {
    const delivered = [];
    const queue = new AsyncLogQueue({
      maxQueueSize: 3,
      deliver: async (element) => {
        delivered.push(element);
      },
      onError: () => assert.fail("should not error"),
    });

    queue.enqueue("a");
    queue.enqueue("b", "c");
    await flush(queue);

    assert.deepEqual(delivered, ["a", "b", "c"]);
  });

  it("Drops the oldest elements once full and reports the count once drained", async function () {
    const delivered = [];
    const dropped = [];
    const blocked = pending();
    const queue = new AsyncLogQueue({
      maxQueueSize: 3,
      deliver: async (element) => {
        await blocked.promise;
        delivered.push(element);
      },
      onError: () => assert.fail("should not error"),
      onDropped: (droppedCount) => dropped.push(droppedCount),
    });

    // "a" is picked up by the drain loop and blocks there, leaving the remaining five to contend for three slots.
    for (const element of ["a", "b", "c", "d", "e", "f"]) queue.enqueue(element);
    assert.equal(queue.length, 3);

    blocked.release();
    await flush(queue);

    assert.deepEqual(delivered, ["a", "d", "e", "f"]); // "b" and "c" were shed to make room for the newer messages.
    assert.deepEqual(dropped, [2]);
  });

  it("Delivers whatever onDropped enqueues before reporting flushed", async function () {
    const delivered = [];
    const blocked = pending();
    const queue = new AsyncLogQueue({
      maxQueueSize: 1,
      deliver: async (element) => {
        if (element === "a") await blocked.promise;
        delivered.push(element);
      },
      onError: () => assert.fail("should not error"),
      onDropped: (droppedCount) => queue.enqueue(`dropped ${droppedCount}`),
    });

    for (const element of ["a", "b", "c"]) queue.enqueue(element);
    blocked.release();
    await flush(queue);

    assert.deepEqual(delivered, ["a", "c", "dropped 1"]);
  });

  it("Retries retryable failures and preserves ordering", async function () {
    const delivered = [];
    let attempts = 0;
    const queue = new AsyncLogQueue({
      maxQueueSize: 10,
      deliver: async (element) => {
        if (element === "a" && attempts++ < 2) throw new Error("rate limited");
        delivered.push(element);
      },
      onError: () => assert.fail("should not error"),
      retryDelaySeconds: () => 0.01,
    });

    queue.enqueue("a", "b");
    await flush(queue);

    assert.equal(attempts, 3);
    assert.deepEqual(delivered, ["a", "b"]);
  });

  it("Reports the failure and moves on once retries are exhausted", async function () {
    const delivered = [];
    const errors = [];
    const queue = new AsyncLogQueue({
      maxQueueSize: 10,
      deliver: async (element) => {
        if (element === "a") throw new Error("rate limited");
        delivered.push(element);
      },
      onError: (error, element) => errors.push({ error, element }),
      retryDelaySeconds: () => 0.01,
      maxRetries: 2,
    });

    queue.enqueue("a", "b");
    await flush(queue);

    assert.equal(errors.length, 1);
    assert.equal(errors[0].element, "a");
    assert.deepEqual(delivered, ["b"]);
  });

  it("Reports non-retryable failures immediately", async function () {
    const delivered = [];
    const errors = [];
    const queue = new AsyncLogQueue({
      maxQueueSize: 10,
      deliver: async (element) => {
        if (element === "a") throw new Error("bad webhook");
        delivered.push(element);
      },
      onError: (error, element) => errors.push({ error, element }),
      // No retryDelaySeconds: nothing is retryable.
    });

    queue.enqueue("a", "b");
    await flush(queue);

    assert.equal(errors.length, 1);
    assert.equal(errors[0].element, "a");
    assert.equal(errors[0].error.message, "bad webhook");
    assert.deepEqual(delivered, ["b"]);
  });

  it("Caps the retry delay", async function () {
    const startTime = Date.now();
    const errors = [];
    let attempts = 0;
    const queue = new AsyncLogQueue({
      maxQueueSize: 10,
      deliver: async () => {
        attempts++;
        throw new Error("rate limited");
      },
      onError: (error, element) => errors.push({ error, element }),
      retryDelaySeconds: () => 600, // Upstream asking us to back off for ten minutes.
      maxRetries: 1,
      maxRetryDelaySeconds: 0.05,
    });

    queue.enqueue("a");
    await flush(queue);

    assert.equal(attempts, 2);
    assert.equal(errors.length, 1);
    assert.isBelow(Date.now() - startTime, 1000);
  });

  it("Keeps draining when the callbacks throw", async function () {
    const delivered = [];
    const queue = new AsyncLogQueue({
      maxQueueSize: 1,
      deliver: async (element) => {
        if (element === "a") throw new Error("bad webhook");
        delivered.push(element);
      },
      onError: () => {
        throw new Error("error handler is broken");
      },
      onDropped: () => {
        throw new Error("dropped handler is broken");
      },
    });

    queue.enqueue("a");
    queue.enqueue("b");
    queue.enqueue("c");
    await flush(queue);

    assert.deepEqual(delivered, ["c"]); // "a" failed to deliver and "b" was dropped for "c".
    assert.isTrue(queue.isFlushed);
  });
});
