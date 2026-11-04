const { assert } = require("chai");
const http = require("http");
const { createSlackTransport } = require("../../dist/logger/SlackTransport");
const { TransportError } = require("../../dist/logger/TransportError");

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

  it("Fails an unanswered post", async function () {
    const transport = createSlackTransport({
      defaultWebHookUrl: `http://127.0.0.1:${server.address().port}`,
      timeoutMs: 100,
    });
    const error = await new Promise((resolve) =>
      transport.log({ level: "info", at: "Test", message: "Test message" }, resolve),
    );
    assert.instanceOf(error, TransportError);
  });
});
