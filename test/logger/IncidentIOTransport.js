const { assert } = require("chai");
const sinon = require("sinon");
const {
  IncidentIOTransport,
  createConfig,
  pagingUrgency,
  retryDelay,
} = require("../../dist/logger/IncidentIOTransport");
const { createTransports } = require("../../dist/logger/Transports");
const { PagerDutyV2Transport } = require("../../dist/logger/PagerDutyV2Transport");
const destination = { url: "https://api.incident.io/v2/alert_events/http/fixture", token: "fixture", urgency: "high" };
const info = { level: "error", at: "Bot", message: "failed", "bot-identifier": "prod-relayer" };
const send = (transport, event) => new Promise((resolve) => transport.log(event, resolve));
const sent = (call) => JSON.parse(call.args[1].body);
const accept = async (_url, init) =>
  new Response(JSON.stringify({ status: "accepted", deduplication_key: JSON.parse(init.body).deduplication_key }), {
    status: 202,
  });

describe("IncidentIOTransport", function () {
  afterEach(() => sinon.restore());
  it("adds an independent transport without removing PagerDuty", function () {
    // createTransports suppresses external transports only when argv contains
    // a bare 'test'; mocha receives paths, matching the repository test command.
    const transports = createTransports({
      createConsoleTransport: false,
      pagerDutyV2Config: { integrationKey: "fixture" },
      incidentIOConfig: { destination },
    });
    assert.equal(transports.filter((x) => x instanceof PagerDutyV2Transport).length, 1);
    assert.equal(transports.filter((x) => x instanceof IncidentIOTransport).length, 1);
  });
  it("keeps one key across retries and does not mutate the log event", async function () {
    const post = sinon.stub(globalThis, "fetch");
    post.onFirstCall().rejects(new Error("network failure"));
    post.callsFake(accept);
    const transport = new IncidentIOTransport({}, createConfig({ destination }));
    assert.isUndefined(await send(transport, info));
    assert.equal(post.callCount, 2);
    assert.equal(sent(post.firstCall).deduplication_key, sent(post.secondCall).deduplication_key);
    assert.deepEqual(info, { level: "error", at: "Bot", message: "failed", "bot-identifier": "prod-relayer" });
    assert.equal(sent(post.secondCall).metadata.paging_urgency, "high");
    assert.equal(post.secondCall.args[1].headers.Authorization, "Bearer fixture");
    assert.equal(post.secondCall.args[1].redirect, "manual");
    assert.isTrue(transport.isFlushed);
  });
  it("keeps unrelated occurrences separate, and honors scoped producer keys", async function () {
    const post = sinon.stub(globalThis, "fetch").callsFake(accept);
    const transport = new IncidentIOTransport({}, createConfig({ destination }));
    for (const event of [
      info,
      info,
      { ...info, incidentDeduplicationKey: "same" },
      { ...info, incidentDeduplicationKey: "same" },
      { ...info, "bot-identifier": "another", incidentDeduplicationKey: "same" },
    ])
      await send(transport, event);
    assert.notEqual(sent(post.getCall(0)).deduplication_key, sent(post.getCall(1)).deduplication_key);
    assert.equal(sent(post.getCall(2)).deduplication_key, sent(post.getCall(3)).deduplication_key);
    assert.notEqual(sent(post.getCall(3)).deduplication_key, sent(post.getCall(4)).deduplication_key);
  });
  it("routes notification paths and redacts delivery failures", async function () {
    const post = sinon
      .stub(globalThis, "fetch")
      .resolves(new Response(JSON.stringify({ message: "secret URL and token" }), { status: 401 }));
    const other = { ...destination, url: "https://api.incident.io/v2/alert_events/http/other" };
    const transport = new IncidentIOTransport({}, createConfig({ destination, customServices: { custom: other } }));
    const error = await send(transport, { ...info, notificationPath: "custom" });
    assert.equal(post.callCount, 1);
    assert.equal(post.firstCall.args[0], other.url);
    assert.notInclude(JSON.stringify(error), "secret URL and token");
    assert.include(error.originalError.message, "401");
    assert.isTrue(transport.isFlushed);
  });
  it("waits for Retry-After before retrying a 429", async function () {
    const clock = sinon.useFakeTimers();
    const post = sinon.stub(globalThis, "fetch");
    post.onFirstCall().resolves(new Response(null, { status: 429, headers: { "retry-after": "7" } }));
    post.callsFake(accept);
    const result = send(new IncidentIOTransport({}, createConfig({ destination })), info);
    await clock.tickAsync(6999);
    assert.equal(post.callCount, 1);
    await clock.tickAsync(1);
    assert.isUndefined(await result);
    assert.equal(post.callCount, 2);
  });
  it("retries a 2xx that does not confirm the event key, and accepts success", async function () {
    const clock = sinon.useFakeTimers();
    const post = sinon.stub(globalThis, "fetch");
    post.onFirstCall().resolves(new Response("not json", { status: 202 }));
    post
      .onSecondCall()
      .resolves(new Response(JSON.stringify({ status: "accepted", deduplication_key: "other" }), { status: 202 }));
    post.callsFake(async (_url, init) => {
      const { deduplication_key } = JSON.parse(init.body);
      return new Response(JSON.stringify({ status: "success", deduplication_key }), { status: 200 });
    });
    const result = send(new IncidentIOTransport({}, createConfig({ destination })), info);
    await clock.tickAsync(750);
    assert.isUndefined(await result);
    assert.equal(post.callCount, 3);
  });
  it("caps Retry-After at 30s and backs off exponentially without it", function () {
    assert.equal(retryDelay("120", 1), 30);
    assert.equal(retryDelay(undefined, 1), 0.25);
    assert.equal(retryDelay("Fri, 06 Nov 2026 15:00:00 GMT", 2), 0.5);
  });
  it("rejects destinations outside the authenticated native HTTP endpoint", function () {
    assert.throws(() => createConfig({ destination: { ...destination, url: "https://example.org" } }));
  });
});

describe("incident.io support-hours parity", function () {
  it("preserves Indexer daily 02:00-18:00 Eastern boundaries across DST", function () {
    const config = { ...destination, supportHours: { timeZone: "America/New_York", startHour: 2, endHour: 18 } };
    for (const [at, expected] of [
      ["2026-01-15T06:59:59Z", "low"],
      ["2026-01-15T07:00:00Z", "high"],
      ["2026-01-15T23:00:00Z", "low"],
      ["2026-07-15T05:59:59Z", "low"],
      ["2026-07-15T06:00:00Z", "high"],
      ["2026-07-15T22:00:00Z", "low"],
      ["2026-03-08T07:00:00Z", "high"],
      ["2026-11-01T06:30:00Z", "low"],
      ["2026-11-01T07:00:00Z", "high"],
    ]) {
      assert.equal(pagingUrgency(config, "error", new Date(at)), expected, at);
    }
  });
});
