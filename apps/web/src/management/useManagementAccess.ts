import { useSyncExternalStore } from "react";
import { readManagementAccess, subscribeManagementAccess } from "./access";

export function useManagementAccess(): string | null {
  return useSyncExternalStore(subscribeManagementAccess, readManagementAccess, () => null);
}
