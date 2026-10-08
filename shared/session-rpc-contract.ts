/** Version of the bounded, read-only session RPC projection. */
export const SESSION_RPC_CONTRACT_VERSION = 1 as const;
export const SESSION_RPC_MAX_ITEMS = 100;

export const SESSION_OPERATIONAL_STATUSES = ["active", "paused", "completed", "failed"] as const;
export type SessionOperationalStatus = (typeof SESSION_OPERATIONAL_STATUSES)[number];

/** Public session facts; storage context and arbitrary metadata are never part of this contract. */
export interface SessionOperationalProjectionV1 {
  id: string;
  status: SessionOperationalStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SessionGetResultV1 {
  contractVersion: typeof SESSION_RPC_CONTRACT_VERSION;
  session: SessionOperationalProjectionV1;
}

export interface SessionListResultV1 {
  contractVersion: typeof SESSION_RPC_CONTRACT_VERSION;
  sessions: SessionOperationalProjectionV1[];
  truncated: boolean;
}
