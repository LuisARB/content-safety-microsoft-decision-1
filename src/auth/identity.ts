import { InteractionRequiredAuthError, PublicClientApplication } from "@azure/msal-browser";
import { validateApiBase } from "../api/client";

export interface Settings { tenantId: string; clientId: string; apiScope: string; apiBase: string }
export function readSettings(): Settings {
  const { VITE_TENANT_ID: tenantId, VITE_CLIENT_ID: clientId, VITE_API_SCOPE: apiScope, VITE_API_BASE_URL: apiBase } = import.meta.env;
  const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!guid.test(tenantId ?? "") || !guid.test(clientId ?? "") || !apiScope?.startsWith("api://") || !apiScope.endsWith("/access_as_user") || !apiBase) {
    throw new Error("Configure VITE_TENANT_ID, VITE_CLIENT_ID, VITE_API_SCOPE and VITE_API_BASE_URL in .env.local before connecting to Azure.");
  }
  return { tenantId: tenantId.toLowerCase(), clientId: clientId.toLowerCase(), apiScope, apiBase: validateApiBase(apiBase) };
}
export function createIdentity(settings: Settings) {
  const client = new PublicClientApplication({
    auth: {
      clientId: settings.clientId, authority: `https://login.microsoftonline.com/${settings.tenantId}`,
      redirectUri: `${window.location.origin}/`,
      postLogoutRedirectUri: `${window.location.origin}/`,
      navigateToLoginRequestUrl: false,
    },
    cache: { cacheLocation: "sessionStorage" },
  });
  let initialized: Promise<void> | undefined;
  const ready = () => initialized ??= client.initialize();
  let startup: Promise<string> | undefined;
  let startupComplete = false;
  const validateAccount = (account: { tenantId: string }) => {
    if (account.tenantId.toLowerCase() !== settings.tenantId) throw new Error("Use an authorized account in the pilot tenant.");
  };
  const initialize = () => startup ??= (async () => {
    try {
      await ready();
      const response = await client.handleRedirectPromise();
      const accounts = client.getAllAccounts().filter(account => account.tenantId.toLowerCase() === settings.tenantId);
      const account = response ? response.account : client.getActiveAccount() ?? (accounts.length === 1 ? accounts[0] : null);
      if (response && !account) throw new Error("Microsoft authentication returned no account. Sign in again.");
      if (account) validateAccount(account);
      client.setActiveAccount(account);
      return account ? account.name ?? "Pilot user" : "";
    } finally {
      startupComplete = true;
    }
  })();
  const ensureStartup = async () => {
    if (!startupComplete) await initialize();
    await ready();
  };
  return {
    initialize,
    async signIn() {
      await ensureStartup();
      await client.loginRedirect({ scopes: [settings.apiScope], prompt: "select_account" });
    },
    async getToken() {
      await ensureStartup();
      const account = client.getActiveAccount();
      if (!account) throw new Error("Sign in before analyzing prompts.");
      validateAccount(account);
      try {
        const result = await client.acquireTokenSilent({ account, scopes: [settings.apiScope] });
        return result.accessToken;
      } catch (error) {
        if (error instanceof InteractionRequiredAuthError) throw new Error("Your session requires interaction. Sign in again before continuing.");
        throw error;
      }
    },
    async signOut() {
      await ensureStartup();
      await client.logoutRedirect({ account: client.getActiveAccount() });
    },
  };
}
