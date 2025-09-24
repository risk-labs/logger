# @risk-labs/logger

@risk-labs/logger is a specialized logger package optimized for minimal dependencies, ensuring compatibility and ease of integration.

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
