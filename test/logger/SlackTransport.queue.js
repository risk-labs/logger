const { assert } = require("chai");
const sinon = require("sinon");
const axios = require("axios");

const { createSlackTransport, SLACK_MAX_QUEUE_SIZE } = require("../../dist/logger/SlackTransport");

const WEBHOOK_URL = "https://hooks.slack.test/default";

const logInfo = (overrides = {}) => ({ level: "info", at: "Test", message: "A message", ...overrides });

// Builds an axios error that satisfies axios.isAxiosError, as thrown by the transport's validateStatus on a 429.
const rateLimitError = (retryAfter) =>
  Object.assign(new Error("Request failed with status code 429"), {
    isAxiosError: true,
    response: { status: 429, headers: { "retry-after": String(retryAfter) } },
  });

const flush = async (transport) => {
  while (!transport.isFlushed) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("SlackTransport: queued delivery", function () {
  let post;

  const createTransport = (postStub, transportConfig = {}) => {
    post = postStub;
    sinon.stub(axios, "create").returns({ post });
    return createSlackTransport({ defaultWebHookUrl: WEBHOOK_URL, ...transportConfig });
  };

  afterEach(function () {
    sinon.restore();
  });

  it("Acknowledges the log immediately when the webhook hangs", async function () {
    // A webhook post that never settles: previously this held the winston callback forever, and 16 buffered writes
    // later the whole logger (console transport included) stopped emitting.
    const transport = createTransport(sinon.stub().returns(new Promise(() => undefined)));

    let callbackCount = 0;
    for (let i = 0; i < 100; i++) transport.log(logInfo({ message: `Message ${i}` }), () => callbackCount++);

    assert.equal(callbackCount, 100); // Every write acknowledged synchronously, despite nothing being delivered.
    assert.equal(post.callCount, 1);
    assert.isFalse(transport.isFlushed);
  });

  it("Sheds the oldest messages once the queue is full", async function () {
    const blocked = new Promise((resolve) => setTimeout(resolve, 20));
    const transport = createTransport(sinon.stub().returns(blocked));

    for (let i = 0; i < SLACK_MAX_QUEUE_SIZE + 10; i++) transport.log(logInfo({ message: `Message ${i}` }), () => {});

    await flush(transport);

    // One in-flight message, a full queue, and a final summary message reporting what was shed.
    assert.equal(post.callCount, SLACK_MAX_QUEUE_SIZE + 2);
    const summary = JSON.stringify(post.lastCall.args[1]);
    assert.include(summary, "Dropped 9 log message(s)");
  });

  it("Backs off and retries when Slack rate limits", async function () {
    const rateLimitedPost = sinon.stub();
    rateLimitedPost.onFirstCall().rejects(rateLimitError(0.01));
    rateLimitedPost.onSecondCall().resolves();
    const transport = createTransport(rateLimitedPost);

    transport.log(logInfo(), () => {});
    await flush(transport);

    assert.equal(post.callCount, 2);
    assert.deepEqual(post.firstCall.args[1], post.secondCall.args[1]); // Same message, not a dropped one.
  });

  it("Emits a transport error when delivery fails", async function () {
    const transport = createTransport(sinon.stub().rejects(new Error("no such webhook")));
    const errors = [];
    transport.on("error", (error) => errors.push(error));

    // The winston callback fires before delivery is attempted, so failures cannot be reported through it.
    let callbackError = "unset";
    transport.log(logInfo(), (error) => (callbackError = error));
    assert.isUndefined(callbackError);

    await flush(transport);

    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "Error occurred while logging to Slack transport");
    assert.equal(errors[0].originalError.message, "no such webhook");
    assert.equal(errors[0].originalInfo.message, "A message");
  });

  it("Queues one payload per message when splitting an oversized log", async function () {
    const transport = createTransport(sinon.stub().resolves());

    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    transport.log(logInfo({ lines }), () => {});
    await flush(transport);

    // Each split message must carry its own payload: they are queued rather than posted one at a time, so a shared
    // payload object would see every post send the last set of blocks.
    assert.isAbove(post.callCount, 1);
    const payloads = post.getCalls().map((call) => JSON.stringify(call.args[1]));
    assert.equal(new Set(payloads).size, payloads.length);
  });

  it("Routes to the escalation path webhook", async function () {
    const escalationUrl = "https://hooks.slack.test/escalation";
    const transport = createTransport(sinon.stub().resolves(), {
      escalationPathWebhookUrls: { "across-error": escalationUrl },
    });

    transport.log(logInfo({ notificationPath: "across-error" }), () => {});
    transport.log(logInfo(), () => {});
    await flush(transport);

    assert.deepEqual(
      post.getCalls().map((call) => call.args[0]),
      [escalationUrl, WEBHOOK_URL],
    );
  });
});
