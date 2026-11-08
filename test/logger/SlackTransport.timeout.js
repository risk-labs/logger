const { assert } = require("chai");
const http = require("http");
const { createSlackTransport } = require("../../dist/logger/SlackTransport");

describe("SlackTransport: post timeout", async function () {
  let server, requests;
  beforeEach(async function () {
    // Accept requests but never respond.
    requests = 0;
    server = http.createServer(() => requests++);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  });
  afterEach(async function () {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  function createTransport() {
    return createSlackTransport({
      defaultWebHookUrl: `http://127.0.0.1:${server.address().port}`,
      timeoutMs: 100,
      minSendIntervalMs: 0,
    });
  }

  it("Does not hold up the log call behind an unanswered post", async function () {
    const transport = createTransport();
    const error = await new Promise((resolve) =>
      transport.log({ level: "info", at: "Test", message: "Test message" }, resolve),
    );
    assert.isUndefined(error);
    assert.isFalse(transport.isFlushed);
  });

  it("Abandons an unanswered post after the timeout and retries it", async function () {
    this.timeout(5000);
    const transport = createTransport();
    transport.log({ level: "info", at: "Test", message: "Test message" }, () => {});
    // First attempt times out after 100ms, then the retry follows the 1s fallback wait.
    while (requests < 2) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requests, 2);
  });
});
