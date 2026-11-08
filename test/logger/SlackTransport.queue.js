const { assert } = require("chai");
const sinon = require("sinon");
const { createSlackTransport, parseRetryAfterMs } = require("../../dist/logger/SlackTransport");

// A fresh Response per call: fetch bodies can only be read once.
const respond = (status, headers) => new Response(null, { status, headers });

describe("SlackTransport: rate-limited delivery", function () {
  let clock, post;

  beforeEach(function () {
    clock = sinon.useFakeTimers();
    post = sinon.stub(globalThis, "fetch").callsFake(async () => respond(200));
  });

  afterEach(function () {
    sinon.restore();
    clock.restore();
  });

  const transport = (overrides) =>
    createSlackTransport({ defaultWebHookUrl: "https://hooks.slack.com/x", minSendIntervalMs: 1000, ...overrides });
  const emit = (t, n) => t.log({ level: "warn", at: "Test", message: "m" + n }, () => {});

  it("parseRetryAfterMs parses integer seconds and rejects junk", function () {
    assert.equal(parseRetryAfterMs("3"), 3000);
    assert.equal(parseRetryAfterMs(undefined), null);
    assert.equal(parseRetryAfterMs("nope"), null);
    assert.equal(parseRetryAfterMs("-1"), null);
  });

  it("sends the first message immediately and spaces the rest by minSendIntervalMs", async function () {
    const t = transport();
    emit(t, 1);
    emit(t, 2);
    emit(t, 3);

    assert.equal(post.callCount, 1); // first send fires immediately
    await clock.tickAsync(0);
    assert.equal(post.callCount, 1, "no second send before the interval elapses");
    await clock.tickAsync(1000);
    assert.equal(post.callCount, 2);
    await clock.tickAsync(1000);
    assert.equal(post.callCount, 3);
  });

  it("enforces spacing across drain sessions (an emptied queue does not reset the rate limit)", async function () {
    const t = transport();
    emit(t, 1);
    assert.equal(post.callCount, 1);
    await clock.tickAsync(400); // queue fully drained; next message arrives shortly after
    emit(t, 2);
    assert.equal(post.callCount, 1, "second send must wait out the remainder of the interval");
    await clock.tickAsync(599);
    assert.equal(post.callCount, 1);
    await clock.tickAsync(1);
    assert.equal(post.callCount, 2, "second send fires one interval after the first");
  });

  it("reports isFlushed only once every queue has drained (waitForLogger relies on this)", async function () {
    const t = transport();
    assert.isTrue(t.isFlushed, "flushed before anything is queued");
    emit(t, 1);
    emit(t, 2);
    assert.isFalse(t.isFlushed, "not flushed while messages are queued or in flight");
    await clock.tickAsync(1000); // first sends immediately, second one interval later
    assert.equal(post.callCount, 2);
    assert.isTrue(t.isFlushed, "flushed after the queue drains");
  });

  it("waits the Retry-After duration on a 429 and then redelivers", async function () {
    post.onCall(0).callsFake(async () => respond(429, { "retry-after": "2" }));

    emit(transport(), 1);
    assert.equal(post.callCount, 1);
    await clock.tickAsync(1999);
    assert.equal(post.callCount, 1, "must not retry before Retry-After elapses");
    await clock.tickAsync(1);
    assert.equal(post.callCount, 2, "retries once Retry-After has elapsed");
  });

  for (const [name, response] of [
    ["5xx", () => respond(500)],
    ["429 without Retry-After", () => respond(429)],
  ]) {
    it(`backs off exponentially between retries on ${name}`, async function () {
      post.callsFake(async () => response());
      emit(transport(), 1);
      assert.equal(post.callCount, 1);

      for (const [i, waitMs] of [1000, 2000, 4000, 8000, 16000].entries()) {
        await clock.tickAsync(waitMs - 1);
        assert.equal(post.callCount, i + 1, `retry ${i + 1} must wait the full ${waitMs}ms`);
        await clock.tickAsync(1);
        assert.equal(post.callCount, i + 2, `retry ${i + 1} fires after ${waitMs}ms`);
      }
    });
  }

  it("drops a message after MAX_RETRIES of 5xx and stops retrying", async function () {
    post.callsFake(async () => respond(500));
    emit(transport(), 1);

    await clock.tickAsync(60_000); // far past all retry waits
    assert.equal(post.callCount, 6, "1 initial attempt + 5 retries, then dropped");
  });

  it("does not retry permanent 4xx failures", async function () {
    post.callsFake(async () => respond(400));
    emit(transport(), 1);

    await clock.tickAsync(60_000);
    assert.equal(post.callCount, 1, "a permanent failure is attempted once and dropped");
  });

  it("drops a log that fails to format without throwing, and keeps sending later logs", async function () {
    const t = transport();
    const circular = {}; // malformed + circular: the formatter's own fallback JSON.stringify throws
    circular.self = circular;
    const callback = sinon.spy();
    sinon.stub(console, "warn"); // keep the expected format warning out of test output

    assert.doesNotThrow(() => t.log(circular, callback));
    assert.isTrue(callback.calledOnce, "winston's callback still fires");
    assert.equal(post.callCount, 0, "nothing is queued for an unformattable log");
    assert.isTrue(t.isFlushed);

    emit(t, 1);
    assert.equal(post.callCount, 1, "the transport keeps working afterwards");
  });
});
