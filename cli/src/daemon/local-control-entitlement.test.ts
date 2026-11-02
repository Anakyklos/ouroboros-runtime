import { describe, expect, it } from "bun:test";
import { EffectClass } from "../mission/contracts.js";
import {
  localControlEntitlementCoversBinding,
  parseLocalControlEntitlement,
  serializeLocalControlEntitlement,
} from "./local-control-entitlement.js";

function binding(
  capabilityId: string,
  effectClass: EffectClass,
  allowedRefPrefixes: string[],
) {
  return { capabilityId, effectClass, allowedRefPrefixes };
}

function entitlement(bindings: ReturnType<typeof binding>[]) {
  return { schemaVersion: 1, bindings };
}

describe("local-control entitlement envelopes", () => {
  it("validates the closed v1 shape and canonicalizes binding and prefix ordering", () => {
    const first = entitlement([
      binding("lifeos.write", EffectClass.WRITE, ["refs/lifeos/z/", "refs/lifeos/a"]),
      binding("lifeos.read", EffectClass.READ, ["refs/lifeos/read"]),
    ]);
    const reordered = entitlement([
      binding("lifeos.read", EffectClass.READ, ["refs/lifeos/read"]),
      binding("lifeos.write", EffectClass.WRITE, ["refs/lifeos/a", "refs/lifeos/z"]),
    ]);

    expect(parseLocalControlEntitlement(first)).toEqual({
      schemaVersion: 1,
      bindings: [
        binding("lifeos.read", EffectClass.READ, ["refs/lifeos/read"]),
        binding("lifeos.write", EffectClass.WRITE, ["refs/lifeos/a", "refs/lifeos/z"]),
      ],
    });
    expect(serializeLocalControlEntitlement(first)).toBe(serializeLocalControlEntitlement(reordered));
    expect(serializeLocalControlEntitlement(entitlement([]))).toBeNull();
    expect(parseLocalControlEntitlement(entitlement([]))).toEqual({ schemaVersion: 1, bindings: [] });
  });

  it("rejects unknown versions, extra or missing fields, duplicate pairs, and malformed identifiers/effects", () => {
    const valid = binding("lifeos.read", EffectClass.READ, ["refs/lifeos"]);
    const invalidValues: unknown[] = [
      { schemaVersion: 2, bindings: [] },
      { schemaVersion: 1, bindings: [], unexpected: true },
      { schemaVersion: 1 },
      { schemaVersion: 1, bindings: [valid, { ...valid, allowedRefPrefixes: ["refs/elsewhere"] }] },
      entitlement([{ ...valid, unexpected: true } as ReturnType<typeof binding>]),
      entitlement([binding("", EffectClass.READ, [])]),
      entitlement([binding(" lifeos.read", EffectClass.READ, [])]),
      entitlement([binding("lifeos.read\n", EffectClass.READ, [])]),
      entitlement([binding("lifeos.read", "admin" as EffectClass, [])]),
    ];
    for (const value of invalidValues) expect(() => parseLocalControlEntitlement(value)).toThrow();
  });

  it("rejects semantically duplicate and ambiguous prefixes", () => {
    const invalidValues = [
      entitlement([binding("lifeos.read", EffectClass.READ, ["refs/lifeos", "refs/lifeos/"])]),
      entitlement([binding("lifeos.read", EffectClass.READ, ["refs/lifeos/a", "refs/lifeos/%61"])]),
      entitlement([binding("lifeos.read", EffectClass.READ, ["refs/lifeos/../private"])]),
      entitlement([binding("lifeos.read", EffectClass.READ, ["refs/lifeos/%2e%2e/private"])]),
      entitlement([binding("lifeos.read", EffectClass.READ, ["refs/lifeos%2Fprivate"])]),
      entitlement([binding("lifeos.read", EffectClass.READ, ["refs/lifeos//private"])]),
      entitlement([binding("lifeos.read", EffectClass.READ, ["refs/lifeos?query"])]),
      entitlement([binding("lifeos.read", EffectClass.READ, ["https://user@example.test/private"])]),
      entitlement([binding("lifeos.read", EffectClass.READ, ["file://remote.example/private"])]),
    ];
    for (const value of invalidValues) expect(() => parseLocalControlEntitlement(value)).toThrow();
  });

  it("enforces byte, binding, and per-binding prefix caps", () => {
    const maxId = "a".repeat(512);
    const maxPrefix = `refs/${"p".repeat(507)}`;
    expect(parseLocalControlEntitlement(entitlement([binding(maxId, EffectClass.READ, [maxPrefix])])).bindings).toHaveLength(1);
    expect(() => parseLocalControlEntitlement(entitlement([binding(`${maxId}a`, EffectClass.READ, [])]))).toThrow();
    expect(() => parseLocalControlEntitlement(entitlement([binding("lifeos.read", EffectClass.READ, [`${maxPrefix}a`])]))).toThrow();

    const maxBindings = Array.from({ length: 128 }, (_, index) => binding(`capability.${index}`, EffectClass.READ, []));
    expect(parseLocalControlEntitlement(entitlement(maxBindings)).bindings).toHaveLength(128);
    expect(() => parseLocalControlEntitlement(entitlement([
      ...maxBindings,
      binding("capability.overflow", EffectClass.READ, []),
    ]))).toThrow();

    const maxPrefixes = Array.from({ length: 64 }, (_, index) => `refs/item-${index}`);
    expect(parseLocalControlEntitlement(entitlement([binding("capability.read", EffectClass.READ, maxPrefixes)])))
      .toMatchObject({ bindings: [{ allowedRefPrefixes: expect.any(Array) }] });
    expect(() => parseLocalControlEntitlement(entitlement([
      binding("capability.read", EffectClass.READ, [...maxPrefixes, "refs/overflow"]),
    ]))).toThrow();

    const oversized = [0, 1].map((bindingIndex) => binding(
      `capability.${bindingIndex}`,
      bindingIndex === 0 ? EffectClass.READ : EffectClass.WRITE,
      Array.from({ length: 64 }, (_, index) => {
        const prefix = `refs/${bindingIndex}/${index.toString(16).padStart(2, "0")}/`;
        return `${prefix}${"x".repeat(512 - prefix.length)}`;
      }),
    ));
    expect(() => parseLocalControlEntitlement(entitlement(oversized))).toThrow(/64 KiB/u);
  });

  it("compares correlated bindings and segment-bounded reference prefixes", () => {
    const limits = entitlement([
      binding("lifeos.read", EffectClass.READ, ["refs/lifeos/journal"]),
      binding("runstead.write", EffectClass.WRITE, ["https://EXAMPLE.test:00443/workspace/root"]),
    ]);

    expect(localControlEntitlementCoversBinding(limits, binding(
      "lifeos.read", EffectClass.READ, ["refs/lifeos/journal/entry/123"],
    ))).toBe(true);
    expect(localControlEntitlementCoversBinding(limits, binding(
      "lifeos.read", EffectClass.READ, ["refs/lifeos/journal-sibling"],
    ))).toBe(false);
    expect(localControlEntitlementCoversBinding(limits, binding(
      "lifeos.read", EffectClass.WRITE, ["refs/lifeos/journal"],
    ))).toBe(false);
    expect(localControlEntitlementCoversBinding(limits, binding(
      "lifeos.read", EffectClass.READ, ["https://example.test/workspace/root/item"],
    ))).toBe(false);
    expect(localControlEntitlementCoversBinding(limits, binding(
      "runstead.write", EffectClass.WRITE, ["https://example.test:00443/workspace/root/item"],
    ))).toBe(true);
    expect(localControlEntitlementCoversBinding(limits, binding(
      "runstead.write", EffectClass.WRITE, ["https://example.test:444/workspace/root/item"],
    ))).toBe(false);
    expect(localControlEntitlementCoversBinding(limits, binding(
      "runstead.write", EffectClass.WRITE, ["https://example.test:443/workspace/rooted/item"],
    ))).toBe(false);
    expect(localControlEntitlementCoversBinding(null, binding("lifeos.read", EffectClass.READ, []))).toBe(false);
  });
});
