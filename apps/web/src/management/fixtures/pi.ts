/**
 * @file apps/web/src/management/fixtures/pi.ts
 */
import type { PiModelProjection } from '../types';

export const mockPiModelsData: PiModelProjection[] = [
  {
    id: 'claude-3-5-sonnet',
    name: 'Claude 3.5 Sonnet (默认执行核心)',
    provider: 'anthropic',
    isDefault: true,
    contextWindowTokens: 200000,
    temperature: 0.2,
    capabilityState: '已实现',
    tokensToday: 124000,
    costTodayUsd: null, // Unknown cost! Cannot be $0.00
    costStatus: 'unpriced',
    activeSessionsCount: 4,
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o (多模态与快响应)',
    provider: 'openai',
    isDefault: false,
    contextWindowTokens: 128000,
    temperature: 0.7,
    capabilityState: '已实现',
    tokensToday: 42500,
    costTodayUsd: null,
    costStatus: 'unknown',
    activeSessionsCount: 1,
  },
  {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat (V3)',
    provider: 'deepseek',
    isDefault: false,
    contextWindowTokens: 64000,
    temperature: 0.3,
    capabilityState: 'P3 目标',
    tokensToday: 18000,
    costTodayUsd: null,
    costStatus: 'unpriced',
    lastError: '暂态超时 (已自动熔断切换至 Claude)',
    activeSessionsCount: 0,
  },
];
