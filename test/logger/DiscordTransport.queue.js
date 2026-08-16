const { assert } = require("chai");
const sinon = require("sinon");

const { DiscordTransport, DISCORD_MAX_QUEUE_SIZE } = require("../../dist/logger/DiscordTransport");

const WEBHOOK_URL = "https://discord.test/webhooks/default";

const logInfo = (overrides = {}) => ({ level: "info", at: "Test", message: "A message", mrkdwn: "Body", ...overrides });

const delivered = () => new Response(null, { status: 204 }); // What Discord answers a webhook post with.

const rateLimited = (retryAfter) =>
  new Response(JSON.stringify({ retry_after: retryAfter }), {
    status: 429,
    headers: { "content-type": "application/json" },
  });

const flush = async (transport) => {
  while (!transport.isFlushed) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("DiscordTransport: queued delivery", function () {
  let post;

  beforeEach(function () {
    post = sinon.stub(globalThis, "fetch"); // The transport posts through the global fetch.
  });

  afterEach(function () {
    sinon.restore();
  });

  const createTransport = () =>
    new DiscordTransport(
      { level: "info" },
      { defaultWebHookUrl: WEBHOOK_URL, escalationPathWebhookUrls: {}, postOnNonEscalationPaths: true },
    );

  const postedBody = (call) => JSON.parse(call.args[1].body);

  it("Acknowledges the log immediately when the webhook hangs", async function () {
    post.returns(new Promise(() => undefined));
    const transport = createTransport();

    let callbackCount = 0;
    for (let i = 0; i < 100; i++) transport.log(logInfo({ message: `Message ${i}` }), () => callbackCount++);

    assert.equal(callbackCount, 100);
    assert.equal(post.callCount, 1);
    assert.isFalse(transport.isFlushed);
  });

  it("Sheds the oldest messages once the queue is full", async function () {
    const blocked = new Promise((resolve) => setTimeout(resolve, 20));
    post.callsFake(() => blocked.then(delivered));
    const transport = createTransport();

    for (let i = 0; i < DISCORD_MAX_QUEUE_SIZE + 10; i++) transport.log(logInfo({ message: `Message ${i}` }), () => {});

    await flush(transport);

    assert.equal(post.callCount, DISCORD_MAX_QUEUE_SIZE + 2);
    assert.include(JSON.stringify(postedBody(post.lastCall)), "Dropped 9 log message(s)");
  });

  it("Backs off and retries when Discord rate limits", async function () {
    post.onFirstCall().resolves(rateLimited(0.01));
    post.onSecondCall().resolves(delivered());
    const transport = createTransport();

    transport.log(logInfo(), () => {});
    await flush(transport);

    assert.equal(post.callCount, 2);
    assert.deepEqual(postedBody(post.firstCall), postedBody(post.secondCall)); // Same message, redelivered.
  });

  it("Emits a transport error rather than retrying a permanent failure forever", async function () {
    post.resolves(new Response(JSON.stringify({ message: "Unknown Webhook" }), { status: 404 }));
    const transport = createTransport();
    const errors = [];
    transport.on("error", (error) => errors.push(error));

    transport.log(logInfo(), () => {});
    await flush(transport);

    assert.equal(post.callCount, 1); // A 404 is not a rate limit, so it is reported rather than retried.
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "Error occurred while logging to Discord transport");
    assert.equal(errors[0].originalError.message, "Request failed with status code 404");
  });

  it("Skips logs that are not addressed to Discord", async function () {
    post.resolves(delivered());
    const transport = createTransport();

    transport.log(logInfo({ discordPaths: null }), () => {});
    transport.log({ level: "info", at: "Test", message: "No mrkdwn" }, () => {});
    await flush(transport);

    assert.equal(post.callCount, 0);
  });
});
