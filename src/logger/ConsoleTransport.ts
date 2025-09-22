// This transport enables Winston logging to the console.
import winston from "winston";
const { format } = winston;
const { combine, timestamp, colorize, printf } = format;

export function createConsoleTransport(): winston.transports.ConsoleTransportInstance {
  return new winston.transports.Console({
    handleExceptions: true,
    format: combine(
      // Adds timestamp.
      colorize(),
      timestamp({
        format: "YYYY-MM-DD HH:mm:ss",
      }),
      printf((info) => {
        const { timestamp, level, error, ...args } = info;

        let log = `${timestamp} [${level}]: ${
          Object.keys(args).length
            ? JSON.stringify(args, (key, value) => (typeof value === "bigint" ? value.toString() : value), 2)
            : ""
        }`;

        // Winston does not properly log Error objects like console.error() does, so this formatter will search for the Error object
        // in the "error" property of "info", and add the error stack to the log.
        // Discussion at https://github.com/winstonjs/winston/issues/1338.
        if (error) {
          log = `${log}\n${error}`;
        }
        return log;
      }),
    ),
  });
}
