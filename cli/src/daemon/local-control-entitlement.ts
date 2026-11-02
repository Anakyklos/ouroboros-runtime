import { EffectClass } from "../mission/contracts.js";

export const LOCAL_CONTROL_ENTITLEMENT_MAX_JSON_BYTES = 64 * 1024;
export const LOCAL_CONTROL_ENTITLEMENT_MAX_BINDINGS = 128;
export const LOCAL_CONTROL_ENTITLEMENT_MAX_PREFIXES_PER_BINDING = 64;
export const LOCAL_CONTROL_ENTITLEMENT_MAX_IDENTIFIER_BYTES = 512;

export interface LocalControlEntitlementBinding {
  readonly capabilityId: string;
  readonly effectClass: EffectClass;
  readonly allowedRefPrefixes: readonly string[];
}

export interface LocalControlEntitlement {
  readonly schemaVersion: 1;
  readonly bindings: readonly LocalControlEntitlementBinding[];
}

interface ParsedPrefix {
  kind: "namespace" | "uri";
  scheme?: string;
  authority?: string;
  segments: string[];
  canonical: string;
}

const EFFECT_CLASSES = new Set<string>(Object.values(EffectClass));

/** Parse, validate, canonicalize, and bound an internal AuthStore entitlement envelope. */
export function parseLocalControlEntitlement(value: unknown): LocalControlEntitlement {
  const record = asExactRecord(value, ["schemaVersion", "bindings"], "envelope");
  if (record.schemaVersion !== 1) invalid("schemaVersion must be 1");
  const rawBindings = asArray(record.bindings, LOCAL_CONTROL_ENTITLEMENT_MAX_BINDINGS, "bindings");
  const bindings: LocalControlEntitlementBinding[] = [];
  const seenPairs = new Set<string>();

  for (const rawBinding of rawBindings) {
    const parsed = parseBinding(rawBinding);
    const pair = JSON.stringify([parsed.capabilityId, parsed.effectClass]);
    if (seenPairs.has(pair)) invalid("bindings must not repeat a capability/effect pair");
    seenPairs.add(pair);
    bindings.push(parsed);
  }

  bindings.sort((left, right) => compareStable(left.capabilityId, right.capabilityId)
    || compareStable(left.effectClass, right.effectClass));
  const normalized: LocalControlEntitlement = { schemaVersion: 1, bindings };
  assertCanonicalSize(normalized);
  return normalized;
}

/** Serialize a validated envelope in stable UTF-8 JSON form; zero bindings persist as SQL NULL. */
export function serializeLocalControlEntitlement(value: unknown | null): string | null {
  if (value === null || value === undefined) return null;
  const normalized = parseLocalControlEntitlement(value);
  if (normalized.bindings.length === 0) return null;
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, "utf8") > LOCAL_CONTROL_ENTITLEMENT_MAX_JSON_BYTES) {
    invalid("canonical JSON exceeds 64 KiB");
  }
  return json;
}

/** Validate a persisted `limits_json` value and return its canonical in-memory representation. */
export function parseStoredLocalControlEntitlement(value: unknown): LocalControlEntitlement | null {
  if (value === null) return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > LOCAL_CONTROL_ENTITLEMENT_MAX_JSON_BYTES) {
    invalid("persisted limits_json is invalid or exceeds 64 KiB");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    invalid("persisted limits_json is corrupt");
  }
  const normalized = parseLocalControlEntitlement(parsed);
  return normalized.bindings.length === 0 ? null : normalized;
}

/** Compare a requested binding to one correlated envelope binding without authorizing an external effect. */
export function localControlEntitlementCoversBinding(entitlement: unknown, requestedBinding: unknown): boolean {
  try {
    if (entitlement === null || entitlement === undefined) return false;
    const limits = parseLocalControlEntitlement(entitlement);
    const requested = parseBinding(requestedBinding);
    const matching = limits.bindings.find((binding) => binding.capabilityId === requested.capabilityId
      && binding.effectClass === requested.effectClass);
    if (!matching || matching.allowedRefPrefixes.length === 0 || requested.allowedRefPrefixes.length === 0) return false;
    return requested.allowedRefPrefixes.every((requestedPrefix) => matching.allowedRefPrefixes.some(
      (allowedPrefix) => prefixContains(allowedPrefix, requestedPrefix),
    ));
  } catch {
    return false;
  }
}

function parseBinding(value: unknown): LocalControlEntitlementBinding {
  const record = asExactRecord(value, ["capabilityId", "effectClass", "allowedRefPrefixes"], "binding");
  const capabilityId = asIdentifier(record.capabilityId, "capabilityId");
  if (typeof record.effectClass !== "string" || !EFFECT_CLASSES.has(record.effectClass)) {
    invalid("binding effectClass is not a recognized EffectClass");
  }
  const rawPrefixes = asArray(record.allowedRefPrefixes, LOCAL_CONTROL_ENTITLEMENT_MAX_PREFIXES_PER_BINDING, "allowedRefPrefixes");
  const prefixes = rawPrefixes.map((prefix) => asPrefix(prefix));
  const seenPrefixes = new Set<string>();
  for (const prefix of prefixes) {
    if (seenPrefixes.has(prefix)) invalid("binding prefixes must not repeat");
    seenPrefixes.add(prefix);
  }
  prefixes.sort(compareStable);
  return {
    capabilityId,
    effectClass: record.effectClass as EffectClass,
    allowedRefPrefixes: prefixes,
  };
}

function asIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
      || /[\u0000-\u001f\u007f]/u.test(value) || !isWellFormedUtf8(value)) {
    invalid(`binding ${field} is malformed`);
  }
  assertByteLimit(value, `binding ${field}`);
  return value;
}

function asPrefix(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !isWellFormedUtf8(value)) {
    invalid("binding reference prefix is malformed");
  }
  assertByteLimit(value, "binding reference prefix");
  const parsed = parsePrefix(value);
  assertByteLimit(parsed.canonical, "canonical binding reference prefix");
  return parsed.canonical;
}

function parsePrefix(value: string): ParsedPrefix {
  if (value !== value.trim() || /[\u0000-\u0020\u007f\\?#]/u.test(value)) {
    invalid("reference prefix contains whitespace, a control, query, fragment, or ambiguous separator");
  }

  let kind: ParsedPrefix["kind"];
  let scheme: string | undefined;
  let authority: string | undefined;
  let path: string;
  const uriMarker = value.indexOf("://");
  if (uriMarker >= 0) {
    const rawScheme = value.slice(0, uriMarker);
    const remainder = value.slice(uriMarker + 3);
    if (!/^[a-z][a-z0-9+.-]*$/iu.test(rawScheme) || rawScheme.toLowerCase() === "refs") {
      invalid("reference URI scheme is invalid");
    }
    scheme = rawScheme.toLowerCase();
    const slash = remainder.indexOf("/");
    if (scheme === "file") {
      if (slash !== 0) invalid("file URI must use the local empty-authority form");
      authority = "";
      path = remainder.slice(1);
    } else {
      if (slash <= 0) invalid("reference URI authority or path is missing");
      authority = canonicalAuthority(remainder.slice(0, slash));
      path = remainder.slice(slash + 1);
    }
    kind = "uri";
  } else {
    if (value.includes(":")) invalid("namespaced reference prefix is invalid");
    kind = "namespace";
    path = value;
  }

  if (path.endsWith("/")) path = path.slice(0, -1);
  if (path.length === 0) invalid("reference prefix path is empty");
  const rawSegments = path.split("/");
  const segments = rawSegments.map(decodePathSegment);
  if (segments.some((segment) => segment === null)) invalid("reference prefix contains an invalid path segment");
  const decodedSegments = segments as string[];
  if (kind === "namespace" && (decodedSegments[0] !== "refs" || decodedSegments.length < 2)) {
    invalid("namespaced reference prefix must begin with refs/ and contain a category");
  }

  const encodedPath = decodedSegments.map(encodePathSegment).join("/");
  const canonical = kind === "namespace"
    ? `refs/${encodedPath.slice("refs/".length)}`
    : scheme === "file"
      ? `file:///${encodedPath}`
      : `${scheme}://${authority}/${encodedPath}`;
  return { kind, scheme, authority, segments: decodedSegments, canonical };
}

function canonicalAuthority(value: string): string {
  const match = /^([a-z0-9._~-]+)(?::([0-9]{1,5}))?$/iu.exec(value);
  if (!match) invalid("reference URI authority is ambiguous");
  const portText = match[2];
  if (portText === undefined) return match[1]!.toLowerCase();
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port > 65_535) invalid("reference URI port is invalid");
  return `${match[1]!.toLowerCase()}:${portText}`;
}

function decodePathSegment(segment: string): string | null {
  if (segment.length === 0) return null;
  let decoded = segment;
  for (let pass = 0; pass < 5; pass += 1) {
    if (/%(?![0-9a-f]{2})/iu.test(decoded)) return null;
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) break;
    decoded = next;
    if (pass === 4 && /%[0-9a-f]{2}/iu.test(decoded)) return null;
  }
  if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")
      || /[\u0000-\u001f\u007f]/u.test(decoded) || !isWellFormedUtf8(decoded)) {
    return null;
  }
  return decoded;
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function prefixContains(allowedPrefix: string, requestedPrefix: string): boolean {
  const allowed = parsePrefix(allowedPrefix);
  const requested = parsePrefix(requestedPrefix);
  if (allowed.kind !== requested.kind) return false;
  if (allowed.kind === "uri" && (allowed.scheme !== requested.scheme || allowed.authority !== requested.authority)) {
    return false;
  }
  return allowed.segments.length <= requested.segments.length
    && allowed.segments.every((segment, index) => requested.segments[index] === segment);
}

function asExactRecord(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid(`${field} must be a plain object`);
  }
  const actualKeys = Reflect.ownKeys(value as object);
  if (actualKeys.some((key) => typeof key !== "string")
      || actualKeys.length !== keys.length
      || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    invalid(`${field} has missing or extra fields`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, maximum: number, field: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    invalid(`${field} must be an array with at most ${maximum} items`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => key !== "length"
      && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length))) {
    invalid(`${field} must be a plain dense array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) invalid(`${field} must not contain holes`);
  }
  return value;
}

function assertCanonicalSize(value: LocalControlEntitlement): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > LOCAL_CONTROL_ENTITLEMENT_MAX_JSON_BYTES) {
    invalid("canonical JSON exceeds 64 KiB");
  }
}

function assertByteLimit(value: string, field: string): void {
  if (Buffer.byteLength(value, "utf8") > LOCAL_CONTROL_ENTITLEMENT_MAX_IDENTIFIER_BYTES) {
    invalid(`${field} exceeds 512 UTF-8 bytes`);
  }
}

function isWellFormedUtf8(value: string): boolean {
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

function compareStable(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function invalid(message: string): never {
  throw new Error(`Local-control entitlement ${message}`);
}
