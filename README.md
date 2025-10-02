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
