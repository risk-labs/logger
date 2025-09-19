import type { TransformableInfo } from "logform";

// If the log entry contains an error then extract the stack trace as the error message.
export function errorStackTracerFormatter(info: TransformableInfo) {
  if ((info as any).error) {
    (info as any).error = handleRecursiveErrorArray((info as any).error);
  }
  return info;
}

// Iterate over each element in the log and see if it is a big number. if it is, then try casting it to a string to
// make it more readable. If something goes wrong in parsing the object (it's too large or something else) then simply
// return the original log entry without modifying it.
export function bigNumberFormatter(info: TransformableInfo) {
  type SymbolRecord = Record<string | symbol, any>;
  try {
    // Out is the original object if and only if one or more BigNumbers were replaced.
    const out = iterativelyReplaceBigNumbers(info as unknown as Record<string | symbol, any>);

    // Because winston depends on some non-enumerable symbol properties, we explicitly copy those over, as they are not
    // handled in iterativelyReplaceBigNumbers. This only needs to happen if logEntry is being replaced.
    if (out !== (info as any))
      Object.getOwnPropertySymbols(info).map(
        (symbol) => ((out as Record<string | symbol, any>)[symbol] = (info as unknown as SymbolRecord)[symbol])
      );
    return out as unknown as TransformableInfo;
  } catch (_) {
    return info;
  }
}

// Handle case where `error` is an array of errors and we want to display all of the error stacks recursively.
// i.e. `error` is in the shape: [[Error, Error], [Error], [Error, Error]]
export function handleRecursiveErrorArray(error: Error | any[]): string | any[] {
  // If error is not an array, then just return error information for there is no need to recurse further.
  if (!Array.isArray(error)) return error.stack || error.message || error.toString() || "could not extract error info";
  // Recursively add all errors to an array and flatten the output.
  return error.map(handleRecursiveErrorArray).flat();
}

// This formatter checks if the `BOT_IDENTIFIER` env variable is present. If it is, the name is appended to the message.
export function botIdentifyFormatter(botIdentifier: string, runIdentifier: string) {
  return function (info: TransformableInfo) {
    (info as any)["bot-identifier"] = botIdentifier;
    (info as any)["run-identifier"] = runIdentifier;
    return info;
  };
}

// Traverse a potentially nested object and replace any element that is either a Ethers BigNumber or web3 BigNumber
// with the string version of it for easy logging.
const iterativelyReplaceBigNumbers = (obj: Record<string | symbol, any>) => {
  // This does a DFS, recursively calling this function to find the desired value for each key.
  // It doesn't modify the original object. Instead, it creates an array of keys and updated values.
  const replacements = Object.entries(obj).map(([key, value]): [string, any] => {
    if (stringifiableBigNumberLike(value)) return [key, value.toString()];
    else if (typeof value === "object" && value !== null) return [key, iterativelyReplaceBigNumbers(value)];
    else return [key, value];
  });

  // This will catch any values that were changed by value _or_ by reference.
  // If no changes were detected, no copy is needed and it is fine to discard the copy and return the original object.
  const copyNeeded = replacements.some(([key, value]) => obj[key] !== value);

  // Only copy if something changed. Otherwise, return the original object.
  return copyNeeded ? Object.fromEntries(replacements) : obj;
};

// This function is a best effort dependency-free reimplementation of the following evaluation:
// (BigNumber.isBigNumber(value) || web3.utils.isBN(value))
// `BigNumber` in the line above is from ethers before v6
function stringifiableBigNumberLike(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Record<string, any>;

  // Must be stringifiable first
  if (typeof candidate.toString !== "function") return false;

  // - Ethers BigNumber v5 instances have `_isBigNumber === true`.
  if (candidate._isBigNumber === true) return true;

  // - bn.js: mimic BN.isBN without importing BN.
  if (isBnJsLike(candidate)) return true;

  return false;
}

// Mimit isBN function from bn.js that web3.js is using under the hood
// https://github.com/indutny/bn.js/blob/6db7c3818569423b94ebcf2bdff90fcfb9c47f6d/lib/bn.js#L61
function isBnJsLike(candidate: Record<string, any>): boolean {
  const ctor = candidate && candidate.constructor;
  const ctorWordSize = ctor && (ctor as any).wordSize;
  const hasWordsArray = candidate.words && Array.isArray(candidate.words);
  // bn.js sets BN.wordSize = 26
  const BNWordSize = 26;
  if (typeof ctorWordSize === "number" && ctorWordSize === BNWordSize && hasWordsArray) return true;
  return false;
}

// Some transports do not support markdown formatted links (e.g. <https://google.com|google.com>). This method removes
// the text anchor and leave plain URLs in the message.
export function removeAnchorTextFromLinks(msg: string): string {
  const anchorTextRegex = /<([^|]+)\|[^>]+>/g;
  // $1 is a backreference to the first capture group containing plain URL.
  return msg.replace(anchorTextRegex, "$1");
}
