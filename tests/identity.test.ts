import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractionRequiredAuthError, PublicClientApplication, type AccountInfo } from "@azure/msal-browser";
import { createIdentity, type Settings } from "../src/auth/identity";

const msal = vi.hoisted(() => ({
  initialize: vi.fn<() => Promise<void>>(),
  handleRedirectPromise: vi.fn<() => Promise<{ account: AccountInfo | null } | null>>(),
  getActiveAccount: vi.fn<() => AccountInfo | null>(),
  getAllAccounts: vi.fn<() => AccountInfo[]>(),
  setActiveAccount: vi.fn<(account: AccountInfo | null) => void>(),
  loginRedirect: vi.fn<(...args: unknown[]) => Promise<void>>(),
  logoutRedirect: vi.fn<(...args: unknown[]) => Promise<void>>(),
  acquireTokenSilent: vi.fn<(...args: unknown[]) => Promise<{ accessToken: string }>>(),
}));
vi.mock("@azure/msal-browser", async original => ({
  ...await original<typeof import("@azure/msal-browser")>(),
  PublicClientApplication: vi.fn(function () { return msal; }),
}));

const settings: Settings = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  clientId: "22222222-2222-2222-2222-222222222222",
  apiScope: "api://33333333-3333-3333-3333-333333333333/access_as_user",
  apiBase: "https://pilot.azure-api.net",
};
const account: AccountInfo = {
  homeAccountId: "test-home", localAccountId: "test-local", environment: "login.microsoftonline.com",
  tenantId: settings.tenantId, username: "synthetic-account", name: "Synthetic pilot",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("window", { location: { origin: "https://pilot.example" } });
  let active: AccountInfo | null = null;
  msal.initialize.mockResolvedValue();
  msal.handleRedirectPromise.mockResolvedValue(null);
  msal.getActiveAccount.mockImplementation(() => active);
  msal.setActiveAccount.mockImplementation(value => { active = value; });
  msal.getAllAccounts.mockReturnValue([]);
  msal.loginRedirect.mockResolvedValue();
  msal.logoutRedirect.mockResolvedValue();
});
afterEach(() => vi.unstubAllGlobals());

describe("same-tab Microsoft authentication", () => {
  it("uses the application root, PKCE redirect flow and session storage without popup callbacks", () => {
    createIdentity(settings);
    expect(PublicClientApplication).toHaveBeenCalledWith({
      auth: {
        clientId: settings.clientId, authority: `https://login.microsoftonline.com/${settings.tenantId}`,
        redirectUri: "https://pilot.example/", postLogoutRedirectUri: "https://pilot.example/",
        navigateToLoginRequestUrl: false,
      },
      cache: { cacheLocation: "sessionStorage" },
    });
  });
  it("handles the redirect once before activating the returned account, including StrictMode startup", async () => {
    msal.handleRedirectPromise.mockResolvedValue({ account });
    const identity = createIdentity(settings);
    expect(await Promise.all([identity.initialize(), identity.initialize()])).toEqual([account.name, account.name]);
    expect(msal.initialize).toHaveBeenCalledTimes(1);
    expect(msal.handleRedirectPromise).toHaveBeenCalledTimes(1);
    expect(msal.setActiveAccount).toHaveBeenCalledWith(account);
    expect(msal.initialize.mock.invocationCallOrder[0]).toBeLessThan(msal.handleRedirectPromise.mock.invocationCallOrder[0]);
    expect(msal.handleRedirectPromise.mock.invocationCallOrder[0]).toBeLessThan(msal.setActiveAccount.mock.invocationCallOrder[0]);
  });
  it("restores the active account on reload without interactive login", async () => {
    msal.getActiveAccount.mockReturnValue(account);
    expect(await createIdentity(settings).initialize()).toBe(account.name);
    expect(msal.loginRedirect).not.toHaveBeenCalled();
  });
  it("restores a single tenant account when no account is active", async () => {
    msal.getAllAccounts.mockReturnValue([{ ...account, tenantId: "other-tenant" }, account]);
    expect(await createIdentity(settings).initialize()).toBe(account.name);
    expect(msal.setActiveAccount).toHaveBeenCalledWith(account);
  });
  it("does not arbitrarily choose between multiple cached accounts", async () => {
    msal.getAllAccounts.mockReturnValue([account, { ...account, homeAccountId: "second-home" }]);
    expect(await createIdentity(settings).initialize()).toBe("");
  });
  it("waits for pending callback handling before starting a login with the API scope", async () => {
    let finish!: (value: null) => void;
    msal.handleRedirectPromise.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const identity = createIdentity(settings);
    const login = identity.signIn();
    await vi.waitFor(() => expect(msal.handleRedirectPromise).toHaveBeenCalled());
    expect(msal.loginRedirect).not.toHaveBeenCalled();
    finish(null);
    await login;
    expect(msal.loginRedirect).toHaveBeenCalledWith({ scopes: [settings.apiScope], prompt: "select_account" });
  });
  it("surfaces callback errors but allows a fresh interactive attempt after cleanup", async () => {
    msal.handleRedirectPromise.mockRejectedValue(new Error("AADSTS65001: consent required"));
    const identity = createIdentity(settings);
    await expect(identity.initialize()).rejects.toThrow("AADSTS65001");
    await identity.signIn();
    expect(msal.loginRedirect).toHaveBeenCalledTimes(1);
  });
  it("surfaces redirect navigation errors", async () => {
    msal.loginRedirect.mockRejectedValue(new Error("Navigation failed"));
    await expect(createIdentity(settings).signIn()).rejects.toThrow("Navigation failed");
  });
  it.each([null, { ...account, tenantId: "other-tenant" }])("rejects a callback without an authorized tenant account: %j", async returned => {
    msal.handleRedirectPromise.mockResolvedValue({ account: returned });
    await expect(createIdentity(settings).initialize()).rejects.toThrow();
    expect(msal.setActiveAccount).not.toHaveBeenCalled();
  });
  it("does not request tokens for an anonymous or wrong-tenant account", async () => {
    const identity = createIdentity(settings);
    await expect(identity.getToken()).rejects.toThrow("Sign in");
    msal.getActiveAccount.mockReturnValue({ ...account, tenantId: "other-tenant" });
    await expect(identity.getToken()).rejects.toThrow("pilot tenant");
    expect(msal.acquireTokenSilent).not.toHaveBeenCalled();
  });
  it("acquires a silent token for the restored account and protected API scope", async () => {
    msal.handleRedirectPromise.mockResolvedValue({ account });
    msal.acquireTokenSilent.mockResolvedValue({ accessToken: "synthetic-test-token" });
    expect(await createIdentity(settings).getToken()).toBe("synthetic-test-token");
    expect(msal.acquireTokenSilent).toHaveBeenCalledWith({ account, scopes: [settings.apiScope] });
  });
  it("requires explicit interaction when silent renewal cannot continue", async () => {
    msal.getActiveAccount.mockReturnValue(account);
    msal.acquireTokenSilent.mockRejectedValue(new InteractionRequiredAuthError("interaction_required"));
    await expect(createIdentity(settings).getToken()).rejects.toThrow("session requires interaction");
    expect(msal.loginRedirect).not.toHaveBeenCalled();
  });
  it("propagates unexpected token failures", async () => {
    msal.getActiveAccount.mockReturnValue(account);
    msal.acquireTokenSilent.mockRejectedValue(new Error("Token endpoint unavailable"));
    await expect(createIdentity(settings).getToken()).rejects.toThrow("Token endpoint unavailable");
  });
  it("logs out in the same tab using the active account", async () => {
    msal.getActiveAccount.mockReturnValue(account);
    await createIdentity(settings).signOut();
    expect(msal.logoutRedirect).toHaveBeenCalledWith({ account });
  });
});
