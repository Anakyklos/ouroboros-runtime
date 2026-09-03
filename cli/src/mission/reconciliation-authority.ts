/**
 * Runtime-only authority used by the ConnectorDispatchSeam when it submits
 * an owner reconciliation fact to the MissionEngine.
 *
 * The token is intentionally not exported from the Mission public barrel.
 * A plain object, serialized value, or structurally similar caller value is
 * not accepted by the engine; only a token minted for a live seam instance
 * can promote a connector result.
 */

const authorities = new WeakSet<object>();

export type ReconciliationAuthority = object;

export function createReconciliationAuthority(): ReconciliationAuthority {
    const authority = Object.freeze({});
    authorities.add(authority);
    return authority;
}

export function isReconciliationAuthority(value: unknown): value is ReconciliationAuthority {
    return typeof value === "object" && value !== null && authorities.has(value);
}
