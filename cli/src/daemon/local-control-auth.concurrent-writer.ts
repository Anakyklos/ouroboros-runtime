import { LocalControlCredentialStore } from "./local-control-auth.js";

const [databasePath, clientId, expirationText] = process.argv.slice(2);
if (!databasePath || !clientId || !expirationText) throw new Error("Concurrent writer arguments are required");
const expiresAt = Number(expirationText);
if (!Number.isSafeInteger(expiresAt)) throw new Error("Concurrent writer expiry is invalid");

const store = new LocalControlCredentialStore(databasePath);
try {
  store.provision(clientId, ["mission.read"], expiresAt);
  process.stdout.write("rotated\n");
} finally {
  store.close();
}
