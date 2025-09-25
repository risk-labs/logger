export type Awaited<T> = T extends PromiseLike<infer U> ? Awaited<U> : T;

export type FinancialContractType = "ExpiringMultiParty" | "Perpetual";
export type FinancialContractFactoryType = "PerpetualCreator" | "ExpiringMultiPartyCreator";

export function isDefined<T>(val: T | undefined | null): val is T {
  return val !== undefined && val !== null;
}
