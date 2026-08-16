const { assert } = require("chai");
const sinon = require("sinon");

const { HttpError, postJson } = require("../../dist/helpers/postJson");

const URL = "https://hooks.example.test/webhook";

describe("postJson", function () {
  let fetchStub;

  beforeEach(function () {
    fetchStub = sinon.stub(globalThis, "fetch");
  });

  afterEach(function () {
    sinon.restore();
  });

  it("POSTs the body as JSON", async function () {
    fetchStub.resolves(new Response("ok", { status: 200 }));

    await postJson(URL, { blocks: [{ type: "divider" }] });

    const [url, init] = fetchStub.firstCall.args;
    assert.equal(url, URL);
    assert.equal(init.method, "POST");
    assert.equal(init.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(init.body), { blocks: [{ type: "divider" }] });
  });

  it("Resolves on any 2xx", async function () {
    // Slack answers 200 with a body of "ok", Discord answers 204 with no body at all.
    for (const status of [200, 204]) {
      fetchStub.resolves(new Response(status === 204 ? null : "ok", { status }));
      await postJson(URL, {});
    }
  });

  it("Throws HttpError carrying the status, headers and parsed body", async function () {
    fetchStub.resolves(
      new Response(JSON.stringify({ retry_after: 1.5 }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "2" },
      }),
    );

    const error = await postJson(URL, {}).catch((error) => error);

    assert.instanceOf(error, HttpError);
    assert.equal(error.status, 429);
    assert.equal(error.headers.get("retry-after"), "2");
    assert.deepEqual(error.data, { retry_after: 1.5 });
    assert.equal(error.message, "Request failed with status code 429");
  });

  it("Keeps a non-JSON error body as text", async function () {
    fetchStub.resolves(new Response("<html>502 Bad Gateway</html>", { status: 502 }));

    const error = await postJson(URL, {}).catch((error) => error);

    assert.instanceOf(error, HttpError);
    assert.equal(error.data, "<html>502 Bad Gateway</html>");
  });

  it("Aborts the request once timeoutMs elapses", async function () {
    // Stand in for a webhook that accepts the connection and never answers.
    fetchStub.callsFake(
      (url, init) =>
        new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
    );

    const error = await postJson(URL, {}, { timeoutMs: 20 }).catch((error) => error);

    assert.equal(error.name, "TimeoutError");
  });

  it("Sends no abort signal when no timeout is configured", async function () {
    fetchStub.resolves(new Response("ok", { status: 200 }));

    await postJson(URL, {});

    assert.isUndefined(fetchStub.firstCall.args[1].signal);
  });

  it("Propagates network failures untouched", async function () {
    const networkError = new TypeError("fetch failed");
    fetchStub.rejects(networkError);

    const error = await postJson(URL, {}).catch((error) => error);

    assert.equal(error, networkError);
  });
});
