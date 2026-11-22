import { describe, it, expect } from "vitest";
import { replaceAddressInList } from "./replaceAddress";

const santaClara = { street: "1 Old St", city: "Santa Clara", state: "CA", zipCode: "95050" };
const gilroy = { street: "100 Test Lane", city: "Gilroy", state: "CA", zipCode: "95020" };

describe("replaceAddressInList", () => {
  it("swaps the old address for the new one and keeps the other details", () => {
    const out = replaceAddressInList([{ ...santaClara, petsInHome: true }], santaClara, gilroy);
    expect(out).toEqual([{ ...gilroy, petsInHome: true }]);
  });
  it("leaves other addresses alone", () => {
    const other = { street: "9 Elm", city: "San Jose", state: "CA", zipCode: "95112" };
    expect(replaceAddressInList([santaClara, other], santaClara, gilroy)).toEqual([gilroy, other]);
  });
  it("does not leave two copies of the new address", () => {
    expect(replaceAddressInList([gilroy, santaClara], santaClara, gilroy)).toEqual([gilroy]);
  });
  it("handles a missing list", () => {
    expect(replaceAddressInList(undefined, santaClara, gilroy)).toEqual([]);
  });
});
