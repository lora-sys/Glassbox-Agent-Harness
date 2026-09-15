import { ManagementApiError } from "./errors";

const storageKey = "glassbox:management-access";
const accessEvent = "glassbox:management-access-changed";
type AccessStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function tabStorage(): AccessStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function isManagementToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/u.test(value);
}

export function readManagementAccess(storage = tabStorage()): string | null {
  try {
    const token = storage?.getItem(storageKey);
    return token && isManagementToken(token) ? token : null;
  } catch {
    return null;
  }
}

function notifyAccessChange() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(accessEvent));
}

export function saveManagementAccess(token: string, storage = tabStorage()): void {
  if (!isManagementToken(token)) throw new ManagementApiError("UNAUTHORIZED");
  if (!storage) throw new ManagementApiError("ACCESS_STORAGE");
  try {
    storage.setItem(storageKey, token);
  } catch {
    throw new ManagementApiError("ACCESS_STORAGE");
  }
  notifyAccessChange();
}

/** A stale request must not erase a replacement credential. */
export function clearManagementAccess(expectedToken?: string, storage = tabStorage()): void {
  if (expectedToken && readManagementAccess(storage) !== expectedToken) return;
  try {
    storage?.removeItem(storageKey);
  } catch {
    throw new ManagementApiError("ACCESS_STORAGE");
  }
  notifyAccessChange();
}

export function subscribeManagementAccess(listener: () => void): () => void {
  window.addEventListener(accessEvent, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(accessEvent, listener);
    window.removeEventListener("storage", listener);
  };
}

/** All browser HTTP access stays on the current origin and uses a header credential. */
export async function managementFetch(
  path: string,
  init: RequestInit = {},
  options: {
    token?: string | null;
    fetch?: typeof globalThis.fetch;
  } = {},
): Promise<Response> {
  const token = options.token === undefined ? readManagementAccess() : options.token;
  if (!token || !isManagementToken(token)) throw new ManagementApiError("UNAUTHORIZED");
  const [pathname, query, extraQuery] = path.split("?");
  if (
    !pathname ||
    !/^\/api\/[a-zA-Z0-9_/%-]+$/u.test(pathname) ||
    /%2e|%2f|%5c/iu.test(pathname) ||
    extraQuery !== undefined
  )
    throw new ManagementApiError("INVALID_INPUT");
  if (query !== undefined) {
    const parameters = new URLSearchParams(query);
    const names = [...parameters.keys()];
    if (
      !query ||
      new Set(names).size !== names.length ||
      query !== parameters.toString() ||
      names.some((name) => !["cursor", "conversationId"].includes(name)) ||
      (parameters.has("cursor") && !/^[A-Za-z0-9_-]{1,4096}$/u.test(parameters.get("cursor")!)) ||
      (parameters.has("conversationId") &&
        !/^[A-Za-z0-9-]{1,80}$/u.test(parameters.get("conversationId")!))
    )
      throw new ManagementApiError("INVALID_INPUT");
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(path, {
      ...init,
      headers,
      redirect: "error",
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ManagementApiError(init.signal?.aborted ? "ABORTED" : "CONNECTION_FAILED");
  }
  if (response.redirected || (response.status >= 300 && response.status < 400))
    throw new ManagementApiError("INVALID_RESPONSE");
  if (response.status === 401) {
    clearManagementAccess(token);
    throw new ManagementApiError("UNAUTHORIZED");
  }
  if (response.status === 403) throw new ManagementApiError("FORBIDDEN");
  return response;
}
