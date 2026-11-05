const { assert } = require("chai");
const http = require("http");
const sinon = require("sinon");
const { createSlackTransport } = require("../../dist/logger/SlackTransport");
const { TransportError } = require("../../dist/logger/TransportError");
const { createNewLogger } = require("../../dist/logger/Logger");
const { SpyTransport } = require("../../dist/logger/SpyTransport");

describe("SlackTransport: post timeout", async function () {
  let server;
  beforeEach(async function () {
    // Accept requests but never respond.
    server = http.createServer(() => {});
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  });
  afterEach(async function () {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  function createTransport() {
    return createSlackTransport({ defaultWebHookUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 100 });
  }

  it("Fails an unanswered post", async function () {
    const error = await new Promise((resolve) =>
      createTransport().log({ level: "info", at: "Test", message: "Test message" }, resolve),
    );
    assert.instanceOf(error, TransportError);
    assert.include(error.originalError.message, "timed out");
  });

  it("Reports the timed-out log to the transport-error logger", async function () {
    const logger = createNewLogger([createTransport()], { createConsoleTransport: false });
    const spy = sinon.spy();
    logger.transportErrorLogger.clear().add(new SpyTransport({}, { spy }));

    logger.info({ at: "Test", message: "Test message" });
    while (!spy.called) await new Promise((resolve) => setTimeout(resolve, 10));

    const { message, originalError, originalInfo } = spy.getCall(0).lastArg;
    assert.equal(message, "Error occurred while logging to Slack transport");
    assert.include(originalError.message, "timed out");
    assert.equal(originalInfo.message, "Test message");
  });
});
