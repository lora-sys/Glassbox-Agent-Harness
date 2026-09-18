/**
 * @file apps/web/src/management/adapter/validators.ts
 *
 * Runtime validation for untrusted API responses from /manage endpoints.
 * Ensures malformed, corrupted, or injected payloads are rejected before rendering.
 */
import type {
  ManagementStatus,
  ManagementDoctor,
  PublicModelProfile,
  PublicChannelProfile,
  PublicExecutor,
} from '@glassbox/contracts';

export class PayloadValidationError extends Error {
  constructor(message: string) {
    super(`PayloadValidationError: ${message}`);
    this.name = 'PayloadValidationError';
  }
}

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function isValidManagementToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_PATTERN.test(token.trim());
}

export function validateManagementStatus(val: unknown): ManagementStatus {
  if (!val || typeof val !== 'object') {
    throw new PayloadValidationError('Expected object for ManagementStatus');
  }
  const obj = val as Record<string, unknown>;
  if (obj.service !== 'glassbox') {
    throw new PayloadValidationError(`Invalid service in status: ${String(obj.service)}`);
  }
  if (obj.status !== 'ready') {
    throw new PayloadValidationError(`Invalid status: ${String(obj.status)}`);
  }
  if (typeof obj.version !== 'string') {
    throw new PayloadValidationError('Missing version in ManagementStatus');
  }
  if (!obj.capabilities || typeof obj.capabilities !== 'object') {
    throw new PayloadValidationError('Missing capabilities in ManagementStatus');
  }
  return val as ManagementStatus;
}

export function validateManagementDoctor(val: unknown): ManagementDoctor {
  if (!val || typeof val !== 'object') {
    throw new PayloadValidationError('Expected object for ManagementDoctor');
  }
  const obj = val as Record<string, unknown>;
  if (!Array.isArray(obj.checks)) {
    throw new PayloadValidationError('Missing checks array in ManagementDoctor');
  }
  for (const check of obj.checks) {
    if (!check || typeof check !== 'object') {
      throw new PayloadValidationError('Invalid check item in ManagementDoctor');
    }
    const c = check as Record<string, unknown>;
    if (typeof c.id !== 'string' || typeof c.label !== 'string' || typeof c.status !== 'string') {
      throw new PayloadValidationError('Malformed check item in ManagementDoctor');
    }
  }
  return val as ManagementDoctor;
}

export function validatePublicModelProfile(val: unknown): PublicModelProfile {
  if (!val || typeof val !== 'object') {
    throw new PayloadValidationError('Expected object for PublicModelProfile');
  }
  const obj = val as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !obj.id) {
    throw new PayloadValidationError('Missing model profile id');
  }
  if (typeof obj.label !== 'string') {
    throw new PayloadValidationError('Missing model profile label');
  }
  if (typeof obj.protocol !== 'string') {
    throw new PayloadValidationError('Missing model profile protocol');
  }
  if (typeof obj.baseUrl !== 'string') {
    throw new PayloadValidationError('Missing model profile baseUrl');
  }
  if (typeof obj.model !== 'string') {
    throw new PayloadValidationError('Missing model profile model name');
  }
  if (typeof obj.credentialConfigured !== 'boolean') {
    throw new PayloadValidationError('Missing credentialConfigured boolean');
  }
  return val as PublicModelProfile;
}

export function validateModelsResponse(val: unknown): { profiles: PublicModelProfile[] } {
  if (!val || typeof val !== 'object') {
    throw new PayloadValidationError('Expected object for /manage/models response');
  }
  const obj = val as Record<string, unknown>;
  if (!Array.isArray(obj.profiles)) {
    throw new PayloadValidationError('Expected profiles array in /manage/models response');
  }
  return {
    profiles: obj.profiles.map(validatePublicModelProfile),
  };
}

export function validatePublicChannelProfile(val: unknown): PublicChannelProfile {
  if (!val || typeof val !== 'object') {
    throw new PayloadValidationError('Expected object for PublicChannelProfile');
  }
  const obj = val as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !obj.id) {
    throw new PayloadValidationError('Missing channel id');
  }
  if (typeof obj.label !== 'string') {
    throw new PayloadValidationError('Missing channel label');
  }
  if (obj.kind !== 'qq-onebot') {
    throw new PayloadValidationError(`Unsupported channel kind: ${String(obj.kind)}`);
  }
  if (typeof obj.endpoint !== 'string') {
    throw new PayloadValidationError('Missing channel endpoint');
  }
  if (typeof obj.botId !== 'string') {
    throw new PayloadValidationError('Missing channel botId');
  }
  if (typeof obj.ownerId !== 'string') {
    throw new PayloadValidationError('Missing channel ownerId');
  }
  if (!Array.isArray(obj.groupIds)) {
    throw new PayloadValidationError('Missing channel groupIds');
  }
  if (typeof obj.tokenConfigured !== 'boolean') {
    throw new PayloadValidationError('Missing tokenConfigured');
  }
  if (typeof obj.autoConnect !== 'boolean') {
    throw new PayloadValidationError('Missing autoConnect');
  }
  const validStates = ['disconnected', 'connecting', 'connected', 'error'];
  if (typeof obj.connectionState !== 'string' || !validStates.includes(obj.connectionState)) {
    throw new PayloadValidationError(`Invalid connectionState: ${String(obj.connectionState)}`);
  }
  return val as PublicChannelProfile;
}

export function validateChannelsResponse(val: unknown): { channels: PublicChannelProfile[] } {
  if (!val || typeof val !== 'object') {
    throw new PayloadValidationError('Expected object for /manage/channels response');
  }
  const obj = val as Record<string, unknown>;
  if (!Array.isArray(obj.channels)) {
    throw new PayloadValidationError('Expected channels array in /manage/channels response');
  }
  return {
    channels: obj.channels.map(validatePublicChannelProfile),
  };
}

export function validateExecutorsResponse(val: unknown): { executors: PublicExecutor[] } {
  if (!val || typeof val !== 'object') {
    throw new PayloadValidationError('Expected object for /manage/executors response');
  }
  const obj = val as Record<string, unknown>;
  if (!Array.isArray(obj.executors)) {
    throw new PayloadValidationError('Expected executors array in /manage/executors response');
  }
  return val as { executors: PublicExecutor[] };
}

export function validateWsTicketResponse(val: unknown): { ticket: string } {
  if (!val || typeof val !== 'object') {
    throw new PayloadValidationError('Expected object for /manage/ws-ticket response');
  }
  const obj = val as Record<string, unknown>;
  if (typeof obj.ticket !== 'string' || obj.ticket.length === 0) {
    throw new PayloadValidationError('Missing or empty ticket in ws-ticket response');
  }
  return { ticket: obj.ticket };
}
