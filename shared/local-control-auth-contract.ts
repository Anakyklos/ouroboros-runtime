/** Independent authorization scopes for the local-control transport boundary. */
export const LOCAL_CONTROL_AUTH_SCOPES = [
  "mission.read",
  "mission.control",
  "daemon.admin",
] as const;

export type LocalControlAuthScope = (typeof LOCAL_CONTROL_AUTH_SCOPES)[number];

export const LOCAL_CONTROL_BROWSER_SESSION_SECONDS = 300;
export const LOCAL_CONTROL_CREDENTIAL_DEFAULT_DAYS = 90;
export const LOCAL_CONTROL_MAX_CLIENT_ID_LENGTH = 64;

export interface LocalControlClientCredential {
  schemaVersion: 1;
  clientId: string;
  token: string;
}

export interface LocalControlAuthenticatedClient {
  clientId: string;
  credentialVersion: string;
  scopes: readonly LocalControlAuthScope[];
  /** Present for short-lived browser sessions; bearer clients use registry expiry. */
  expiresAt?: number;
}
