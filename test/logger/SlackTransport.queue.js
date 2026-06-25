const { assert } = require("chai");
const sinon = require("sinon");
const axios = require("axios");
const { createSlackTransport, parseRetryAfterMs } = require("../../dist/logger/SlackTransport");

describe("SlackTransport: rate-limited delivery", function () {
  let clock, post;

  beforeEach(function () {
    clock = sinon.useFakeTimers();
    post = sinon.stub().resolves({ status: 200, headers: {} });
    sinon.stub(axios, "create").returns({ post });
  });

  afterEach(function () {
    sinon.restore();
    clock.restore();
  });

  // createSlackTransport calls axios.create(), so the stub above is what the transport POSTs through.
  const transport = (overrides) =>
    createSlackTransport({ defaultWebHookUrl: "https://hooks.slack.com/x", minSendIntervalMs: 1000, ...overrides });
  const emit = (t, n) => t.log({ level: "warn", at: "Test", message: "m" + n }, () => {});

  it("parseRetryAfterMs parses integer seconds and rejects junk", function () {
    assert.equal(parseRetryAfterMs("3"), 3000);
    assert.equal(parseRetryAfterMs(["5"]), 5000); // header may arrive as an array
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

  it("waits the Retry-After duration on a 429 and then redelivers", async function () {
    post.onCall(0).resolves({ status: 429, headers: { "retry-after": "2" } });
    post.onCall(1).resolves({ status: 200, headers: {} });

    emit(transport(), 1);
    assert.equal(post.callCount, 1);
    await clock.tickAsync(1999);
    assert.equal(post.callCount, 1, "must not retry before Retry-After elapses");
    await clock.tickAsync(1);
    assert.equal(post.callCount, 2, "retries once Retry-After has elapsed");
  });

  it("drops a message after MAX_RETRIES of 5xx and stops retrying", async function () {
    post.resolves({ status: 500, headers: {} });
    emit(transport(), 1);

    await clock.tickAsync(60_000); // far past all retry waits
    assert.equal(post.callCount, 6, "1 initial attempt + 5 retries, then dropped");
  });

  it("does not retry permanent 4xx failures", async function () {
    post.resolves({ status: 400, headers: {} });
    emit(transport(), 1);

    await clock.tickAsync(60_000);
    assert.equal(post.callCount, 1, "a permanent failure is attempted once and dropped");
  });
});
