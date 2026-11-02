import { LocalControlCredentialStore } from "./local-control-auth.js";

const [databasePath, clientId, limitsJson] = process.argv.slice(2);
if (!databasePath || !clientId || !limitsJson) throw new Error("Entitlement writer arguments are required");

const limits: unknown = JSON.parse(limitsJson);
const store = new LocalControlCredentialStore(databasePath);
try {
  if (!store.setEntitlementLimits(clientId, limits)) throw new Error("Entitlement writer observed an unexpected no-op");
  process.stdout.write("updated\n");
} finally {
  store.close();
}
