export interface ServiceSourceIdentity {
  launchCommit: string;
  launchClean: boolean;
  launchSourceTreeSha256?: string;
}

export function serviceSourceTreeSha256(checkout: string): string;
export function serviceSourceIdentity(checkout: string): ServiceSourceIdentity | undefined;
