/**
 * @file apps/web/src/management/fixtures/pi.ts
 */
import type {
  PiModelProjection,
  PiProfileProjection,
  PiSessionHealthProjection,
} from '../types';

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
    quota: null, // Unknown quota! Cannot be zero
    quotaStatus: 'unknown',
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
    quota: null,
    quotaStatus: 'unknown',
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
    quota: null,
    quotaStatus: 'unreported',
    lastError: '暂态超时 (已自动熔断切换至 Claude)',
    activeSessionsCount: 0,
  },
];

export const mockPiProfilesData: PiProfileProjection[] = [
  {
    id: 'profile_p3_closed_loop',
    name: 'lora-pi-kit:p3-closed-loop',
    description: 'P3 闭环生产 Profile，集成玻璃盒策略网桥与跟踪钩子',
    preset: 'owner-direct + qq-group preset',
    toolsCount: 8,
    extensionsLoaded: 4,
  },
  {
    id: 'profile_eval_suite',
    name: 'lora-pi-kit:eval-suite',
    description: '评测与基准测试沙盒 Profile，仅开放只读工具',
    preset: 'test-harness preset',
    toolsCount: 3,
    extensionsLoaded: 2,
  },
  {
    id: 'profile_minimal_sandbox',
    name: 'lora-pi-kit:minimal-sandbox',
    description: '最小受限环境，无网络与文件写入权限',
    preset: 'visitor-direct preset',
    toolsCount: 1,
    extensionsLoaded: 1,
  },
];

export const mockPiSessionHealthData: PiSessionHealthProjection[] = [
  {
    sessionId: 'pi_sess_01',
    modelId: 'claude-3-5-sonnet',
    channel: 'Workbench Web',
    status: 'active',
    lastActivity: '12 秒前',
  },
  {
    sessionId: 'pi_sess_02',
    modelId: 'claude-3-5-sonnet',
    channel: 'OneBot 11 QQ',
    status: 'active',
    lastActivity: '28 秒前',
  },
  {
    sessionId: 'pi_sess_03',
    modelId: 'gpt-4o',
    channel: 'API Gateway',
    status: 'idle',
    lastActivity: '5 分钟前',
  },
  {
    sessionId: 'pi_sess_04',
    modelId: 'claude-3-5-sonnet',
    channel: 'Herdr Worker',
    status: 'closed',
    lastActivity: '12 分钟前',
  },
];
