const { assert } = require("chai");
const sinon = require("sinon");
const axios = require("axios");

const { DiscordTransport, DISCORD_MAX_QUEUE_SIZE } = require("../../dist/logger/DiscordTransport");

const WEBHOOK_URL = "https://discord.test/webhooks/default";

const logInfo = (overrides = {}) => ({ level: "info", at: "Test", message: "A message", mrkdwn: "Body", ...overrides });

const flush = async (transport) => {
  while (!transport.isFlushed) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("DiscordTransport: queued delivery", function () {
  let post;

  const createTransport = (postStub) => {
    post = postStub;
    sinon.stub(axios, "create").returns({ post });
    return new DiscordTransport(
      { level: "info" },
      { defaultWebHookUrl: WEBHOOK_URL, escalationPathWebhookUrls: {}, postOnNonEscalationPaths: true },
    );
  };

  afterEach(function () {
    sinon.restore();
  });

  it("Acknowledges the log immediately when the webhook hangs", async function () {
    const transport = createTransport(sinon.stub().returns(new Promise(() => undefined)));

    let callbackCount = 0;
    for (let i = 0; i < 100; i++) transport.log(logInfo({ message: `Message ${i}` }), () => callbackCount++);

    assert.equal(callbackCount, 100);
    assert.equal(post.callCount, 1);
    assert.isFalse(transport.isFlushed);
  });

  it("Sheds the oldest messages once the queue is full", async function () {
    const blocked = new Promise((resolve) => setTimeout(resolve, 20));
    const transport = createTransport(sinon.stub().returns(blocked));

    for (let i = 0; i < DISCORD_MAX_QUEUE_SIZE + 10; i++) transport.log(logInfo({ message: `Message ${i}` }), () => {});

    await flush(transport);

    assert.equal(post.callCount, DISCORD_MAX_QUEUE_SIZE + 2);
    assert.include(JSON.stringify(post.lastCall.args[1]), "Dropped 9 log message(s)");
  });

  it("Emits a transport error rather than retrying a permanent failure forever", async function () {
    const transport = createTransport(sinon.stub().rejects(new Error("unknown webhook")));
    const errors = [];
    transport.on("error", (error) => errors.push(error));

    transport.log(logInfo(), () => {});
    await flush(transport);

    assert.equal(post.callCount, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "Error occurred while logging to Discord transport");
    assert.equal(errors[0].originalError.message, "unknown webhook");
  });

  it("Skips logs that are not addressed to Discord", async function () {
    const transport = createTransport(sinon.stub().resolves());

    transport.log(logInfo({ discordPaths: null }), () => {});
    transport.log({ level: "info", at: "Test", message: "No mrkdwn" }, () => {});
    await flush(transport);

    assert.equal(post.callCount, 0);
  });
});
