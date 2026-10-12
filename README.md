# @risk-labs/logger

@risk-labs/logger is a specialized logger package optimized for minimal dependencies, ensuring compatibility and ease of integration.

@risk-labs/logger initially was maintained as a part of [UMAProtocol/protocol repo](https://github.com/UMAprotocol/protocol) and tag `@uma/logger@1.3.3` is the last common version for these logger implementations.

## Installing the package

```bash
yarn add @risk-labs/logger
```

## Importing the package

The [Logger](./src/logger) directory contains helpers and factories for logging with Winston. To get the default
logger:

```js
const { Logger } = require("@risk-labs/logger")

// You can also log directly using the winston logger.
Logger.debug({
  at: "createPriceFeed",
  message: "Creating CryptoWatchPriceFeed",
  otherParam: 5,
})
```

### Parallel incident.io delivery

After deploying the matching native HTTP alert source, set `INCIDENT_IO_CONFIG`
through the consumer's secret configuration. It has a `destination` object with
`url`, `token` (the source token, not a workspace API key), and `urgency` (`high`,
`low`, or `severity_based`), plus optional `customServices` destinations keyed by
`notificationPath`. Use the same service mapping as `PAGER_DUTY_V2_CONFIG`.
Keep PagerDuty configured: these are independent transports and each receives
error-level events. Omitting the new configuration or setting `disabled: true`
disables only incident.io. Do not store source credentials in Git.

Each existing trigger-only log occurrence remains a separate alert unless the
producer supplies `incidentDeduplicationKey`. That key is scoped by bot identifier
and notification path; all delivery retries reuse it. The transport tracks pending
requests for `waitForLogger`, retries transient failures within a bounded budget,
and sanitizes delivery errors. Logger silence does not resolve alerts; existing
producer recovery semantics must be implemented separately before final cutover.
A destination can specify daily `supportHours` with `timeZone`, `startHour` and
`endHour`: high urgency inside the half-open interval, low outside. For the
reviewed legacy Indexer policy these are `America/New_York`, `2`, and `18` every
day. IANA timezone conversion preserves daylight saving; the interval is evaluated
at send time. Confirm the live policy before enabling this configuration.

Publish the reviewed logger release, update the consumers' dependency versions,
and then configure production destinations through each consumer's deployment
workflow. Adding this library code alone does not change any running producer.
