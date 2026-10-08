import type { LocalControlAuthorizationPort } from "./local-control-auth.js";

/** Test-only permissive port for legacy daemon behavior suites; security gates have separate real-registry E2E coverage. */
export const permissiveLocalControlTestAuth: LocalControlAuthorizationPort = {
  hasActiveClients: () => true,
  authenticateBearer: () => ({ clientId: "test", credentialVersion: "test", scopes: ["mission.read", "mission.control", "daemon.admin"] }),
  authorizeBearer: (_authorization, scope) => ({ clientId: "test", credentialVersion: "test", scopes: [scope] }),
  authenticateBrowserSession: () => ({ clientId: "test", credentialVersion: "test", scopes: ["mission.read", "mission.control", "daemon.admin"] }),
  authorizeBrowserSession: () => ({ clientId: "test", credentialVersion: "test", scopes: ["mission.read", "mission.control", "daemon.admin"] }),
  isClientStillAuthorized: () => true,
  isAllowedOrigin: () => true,
  createBrowserSession: () => ({ cookie: "A".repeat(43), maxAge: 300 }),
  close: () => {},
};
