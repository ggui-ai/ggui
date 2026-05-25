// AUTO-GENERATED — do not edit manually.
// Run: make update-openrouter-models
// Source: https://openrouter.ai/api/v1/models
// Generated: 2026-03-23T08:45:50.449Z
// Models: 322

import type { ModelTier } from "./llm.js";
import type { LlmProvider } from "./llm-route.js";

export interface OpenRouterModelConfig {
  id: string;
  openRouterId: string;
  provider: LlmProvider;
  displayName: string;
  tier: ModelTier;
  costs: { inputPer1M: number; outputPer1M: number };
  maxTokens: number;
  supportsTools: boolean;
  supportsCaching: boolean;
  supportsThinking: boolean;
}

export const OPENROUTER_MODEL_REGISTRY: Record<string, OpenRouterModelConfig> = {
  "openrouter/ai21/jamba-large-1.7": {
    "id": "openrouter/ai21/jamba-large-1.7",
    "openRouterId": "ai21/jamba-large-1.7",
    "provider": "openrouter",
    "displayName": "AI21: Jamba Large 1.7",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2,
      "outputPer1M": 8
    },
    "maxTokens": 256000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/aion-labs/aion-1.0": {
    "id": "openrouter/aion-labs/aion-1.0",
    "openRouterId": "aion-labs/aion-1.0",
    "provider": "openrouter",
    "displayName": "AionLabs: Aion-1.0",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 4,
      "outputPer1M": 8
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/aion-labs/aion-1.0-mini": {
    "id": "openrouter/aion-labs/aion-1.0-mini",
    "openRouterId": "aion-labs/aion-1.0-mini",
    "provider": "openrouter",
    "displayName": "AionLabs: Aion-1.0-Mini",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.7,
      "outputPer1M": 1.4
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/aion-labs/aion-2.0": {
    "id": "openrouter/aion-labs/aion-2.0",
    "openRouterId": "aion-labs/aion-2.0",
    "provider": "openrouter",
    "displayName": "AionLabs: Aion-2.0",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.8,
      "outputPer1M": 1.6
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/aion-labs/aion-rp-llama-3.1-8b": {
    "id": "openrouter/aion-labs/aion-rp-llama-3.1-8b",
    "openRouterId": "aion-labs/aion-rp-llama-3.1-8b",
    "provider": "openrouter",
    "displayName": "AionLabs: Aion-RP 1.0 (8B)",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.8,
      "outputPer1M": 1.6
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/alfredpros/codellama-7b-instruct-solidity": {
    "id": "openrouter/alfredpros/codellama-7b-instruct-solidity",
    "openRouterId": "alfredpros/codellama-7b-instruct-solidity",
    "provider": "openrouter",
    "displayName": "AlfredPros: CodeLLaMa 7B Instruct Solidity",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.8,
      "outputPer1M": 1.2
    },
    "maxTokens": 4096,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/alibaba/tongyi-deepresearch-30b-a3b": {
    "id": "openrouter/alibaba/tongyi-deepresearch-30b-a3b",
    "openRouterId": "alibaba/tongyi-deepresearch-30b-a3b",
    "provider": "openrouter",
    "displayName": "Tongyi DeepResearch 30B A3B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.09,
      "outputPer1M": 0.45
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/allenai/olmo-2-0325-32b-instruct": {
    "id": "openrouter/allenai/olmo-2-0325-32b-instruct",
    "openRouterId": "allenai/olmo-2-0325-32b-instruct",
    "provider": "openrouter",
    "displayName": "AllenAI: Olmo 2 32B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.05,
      "outputPer1M": 0.2
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/allenai/olmo-3-32b-think": {
    "id": "openrouter/allenai/olmo-3-32b-think",
    "openRouterId": "allenai/olmo-3-32b-think",
    "provider": "openrouter",
    "displayName": "AllenAI: Olmo 3 32B Think",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.15,
      "outputPer1M": 0.5
    },
    "maxTokens": 65536,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/allenai/olmo-3.1-32b-instruct": {
    "id": "openrouter/allenai/olmo-3.1-32b-instruct",
    "openRouterId": "allenai/olmo-3.1-32b-instruct",
    "provider": "openrouter",
    "displayName": "AllenAI: Olmo 3.1 32B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.2,
      "outputPer1M": 0.6
    },
    "maxTokens": 65536,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/allenai/olmo-3.1-32b-think": {
    "id": "openrouter/allenai/olmo-3.1-32b-think",
    "openRouterId": "allenai/olmo-3.1-32b-think",
    "provider": "openrouter",
    "displayName": "AllenAI: Olmo 3.1 32B Think",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.15,
      "outputPer1M": 0.5
    },
    "maxTokens": 65536,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/alpindale/goliath-120b": {
    "id": "openrouter/alpindale/goliath-120b",
    "openRouterId": "alpindale/goliath-120b",
    "provider": "openrouter",
    "displayName": "Goliath 120B",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 3.75,
      "outputPer1M": 7.5
    },
    "maxTokens": 6144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/amazon/nova-2-lite-v1": {
    "id": "openrouter/amazon/nova-2-lite-v1",
    "openRouterId": "amazon/nova-2-lite-v1",
    "provider": "openrouter",
    "displayName": "Amazon: Nova 2 Lite",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.3,
      "outputPer1M": 2.5
    },
    "maxTokens": 1000000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/amazon/nova-lite-v1": {
    "id": "openrouter/amazon/nova-lite-v1",
    "openRouterId": "amazon/nova-lite-v1",
    "provider": "openrouter",
    "displayName": "Amazon: Nova Lite 1.0",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.06,
      "outputPer1M": 0.24
    },
    "maxTokens": 300000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/amazon/nova-micro-v1": {
    "id": "openrouter/amazon/nova-micro-v1",
    "openRouterId": "amazon/nova-micro-v1",
    "provider": "openrouter",
    "displayName": "Amazon: Nova Micro 1.0",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.04,
      "outputPer1M": 0.14
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/amazon/nova-premier-v1": {
    "id": "openrouter/amazon/nova-premier-v1",
    "openRouterId": "amazon/nova-premier-v1",
    "provider": "openrouter",
    "displayName": "Amazon: Nova Premier 1.0",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2.5,
      "outputPer1M": 12.5
    },
    "maxTokens": 1000000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/amazon/nova-pro-v1": {
    "id": "openrouter/amazon/nova-pro-v1",
    "openRouterId": "amazon/nova-pro-v1",
    "provider": "openrouter",
    "displayName": "Amazon: Nova Pro 1.0",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.8,
      "outputPer1M": 3.2
    },
    "maxTokens": 300000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/anthracite-org/magnum-v4-72b": {
    "id": "openrouter/anthracite-org/magnum-v4-72b",
    "openRouterId": "anthracite-org/magnum-v4-72b",
    "provider": "openrouter",
    "displayName": "Magnum v4 72B",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 3,
      "outputPer1M": 5
    },
    "maxTokens": 16384,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/anthropic/claude-3-haiku": {
    "id": "openrouter/anthropic/claude-3-haiku",
    "openRouterId": "anthropic/claude-3-haiku",
    "provider": "openrouter",
    "displayName": "Anthropic: Claude 3 Haiku",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.25,
      "outputPer1M": 1.25
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/anthropic/claude-3.5-haiku": {
    "id": "openrouter/anthropic/claude-3.5-haiku",
    "openRouterId": "anthropic/claude-3.5-haiku",
    "provider": "openrouter",
    "displayName": "Anthropic: Claude 3.5 Haiku",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.8,
      "outputPer1M": 4
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/anthropic/claude-3.5-sonnet": {
    "id": "openrouter/anthropic/claude-3.5-sonnet",
    "openRouterId": "anthropic/claude-3.5-sonnet",
    "provider": "openrouter",
    "displayName": "Anthropic: Claude 3.5 Sonnet",
    "tier": "premium",
    "costs": {
      "inputPer1M": 6,
      "outputPer1M": 30
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": true
  },
  "openrouter/anthropic/claude-3.7-sonnet": {
    "id": "openrouter/anthropic/claude-3.7-sonnet",
    "openRouterId": "anthropic/claude-3.7-sonnet",
    "provider": "openrouter",
    "displayName": "Anthropic: Claude 3.7 Sonnet",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 3,
      "outputPer1M": 15
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": true
  },
  "openrouter/anthropic/claude-3.7-sonnet:thinking": {
    "id": "openrouter/anthropic/claude-3.7-sonnet:thinking",
    "openRouterId": "anthropic/claude-3.7-sonnet:thinking",
    "provider": "openrouter",
    "displayName": "Anthropic: Claude 3.7 Sonnet (thinking)",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 3,
      "outputPer1M": 15
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": true
  },
  "openrouter/anthropic/claude-haiku-4.5": {
    "id": "openrouter/anthropic/claude-haiku-4.5",
    "openRouterId": "anthropic/claude-haiku-4.5",
    "provider": "openrouter",
    "displayName": "Anthropic: Claude Haiku 4.5",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1,
      "outputPer1M": 5
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/anthropic/claude-opus-4": {
    "id": "openrouter/anthropic/claude-opus-4",
    "openRouterId": "anthropic/claude-opus-4",
    "provider": "openrouter",
    "displayName": "Anthropic: Claude Opus 4",
    "tier": "premium",
    "costs": {
      "inputPer1M": 15,
      "outputPer1M": 75
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": true
  },
  "openrouter/anthropic/claude-opus-4.1": {
    "id": "openrouter/anthropic/claude-opus-4.1",
    "openRouterId": "anthropic/claude-opus-4.1",
    "provider": "openrouter",
    "displayName": "Anthropic: Claude Opus 4.1",
    "tier": "premium",
    "costs": {
      "inputPer1M": 15,
      "outputPer1M": 75
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": true
  },
  "openrouter/anthropic/claude-opus-4.5": {
    "id": "openrouter/anthropic/claude-opus-4.5",
    "openRouterId": "anthropic/claude-opus-4.5",
    "provider": "openrouter",
    "displayName": "Anthropic: Claude Opus 4.5",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 5,
      "outputPer1M": 25
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": true
  },
  "openrouter/anthropic/claude-opus-4.6": {
    "id": "openrouter/anthropic/claude-opus-4.6",
    "openRouterId": "anthropic/claude-opus-4.6",
    "provider": "openrouter",
    "displayName": "Anthropic: Claude Opus 4.6",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 5,
      "outputPer1M": 25
    },
    "maxTokens": 1000000,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": true
  },
  "openrouter/anthropic/claude-sonnet-4": {
    "id": "openrouter/anthropic/claude-sonnet-4",
    "openRouterId": "anthropic/claude-sonnet-4",
    "provider": "openrouter",
    "displayName": "Anthropic: Claude Sonnet 4",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 3,
      "outputPer1M": 15
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": true
  },
  "openrouter/anthropic/claude-sonnet-4.5": {
    "id": "openrouter/anthropic/claude-sonnet-4.5",
    "openRouterId": "anthropic/claude-sonnet-4.5",
    "provider": "openrouter",
    "displayName": "Anthropic: Claude Sonnet 4.5",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 3,
      "outputPer1M": 15
    },
    "maxTokens": 1000000,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": true
  },
  "openrouter/anthropic/claude-sonnet-4.6": {
    "id": "openrouter/anthropic/claude-sonnet-4.6",
    "openRouterId": "anthropic/claude-sonnet-4.6",
    "provider": "openrouter",
    "displayName": "Anthropic: Claude Sonnet 4.6",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 3,
      "outputPer1M": 15
    },
    "maxTokens": 1000000,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": true
  },
  "openrouter/arcee-ai/coder-large": {
    "id": "openrouter/arcee-ai/coder-large",
    "openRouterId": "arcee-ai/coder-large",
    "provider": "openrouter",
    "displayName": "Arcee AI: Coder Large",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.5,
      "outputPer1M": 0.8
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/arcee-ai/maestro-reasoning": {
    "id": "openrouter/arcee-ai/maestro-reasoning",
    "openRouterId": "arcee-ai/maestro-reasoning",
    "provider": "openrouter",
    "displayName": "Arcee AI: Maestro Reasoning",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.9,
      "outputPer1M": 3.3
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/arcee-ai/spotlight": {
    "id": "openrouter/arcee-ai/spotlight",
    "openRouterId": "arcee-ai/spotlight",
    "provider": "openrouter",
    "displayName": "Arcee AI: Spotlight",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.18,
      "outputPer1M": 0.18
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/arcee-ai/trinity-mini": {
    "id": "openrouter/arcee-ai/trinity-mini",
    "openRouterId": "arcee-ai/trinity-mini",
    "provider": "openrouter",
    "displayName": "Arcee AI: Trinity Mini",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.05,
      "outputPer1M": 0.15
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/arcee-ai/virtuoso-large": {
    "id": "openrouter/arcee-ai/virtuoso-large",
    "openRouterId": "arcee-ai/virtuoso-large",
    "provider": "openrouter",
    "displayName": "Arcee AI: Virtuoso Large",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.75,
      "outputPer1M": 1.2
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/baidu/ernie-4.5-21b-a3b": {
    "id": "openrouter/baidu/ernie-4.5-21b-a3b",
    "openRouterId": "baidu/ernie-4.5-21b-a3b",
    "provider": "openrouter",
    "displayName": "Baidu: ERNIE 4.5 21B A3B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.07,
      "outputPer1M": 0.28
    },
    "maxTokens": 120000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/baidu/ernie-4.5-21b-a3b-thinking": {
    "id": "openrouter/baidu/ernie-4.5-21b-a3b-thinking",
    "openRouterId": "baidu/ernie-4.5-21b-a3b-thinking",
    "provider": "openrouter",
    "displayName": "Baidu: ERNIE 4.5 21B A3B Thinking",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.07,
      "outputPer1M": 0.28
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/baidu/ernie-4.5-300b-a47b": {
    "id": "openrouter/baidu/ernie-4.5-300b-a47b",
    "openRouterId": "baidu/ernie-4.5-300b-a47b",
    "provider": "openrouter",
    "displayName": "Baidu: ERNIE 4.5 300B A47B ",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.28,
      "outputPer1M": 1.1
    },
    "maxTokens": 123000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/baidu/ernie-4.5-vl-28b-a3b": {
    "id": "openrouter/baidu/ernie-4.5-vl-28b-a3b",
    "openRouterId": "baidu/ernie-4.5-vl-28b-a3b",
    "provider": "openrouter",
    "displayName": "Baidu: ERNIE 4.5 VL 28B A3B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.14,
      "outputPer1M": 0.56
    },
    "maxTokens": 30000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/baidu/ernie-4.5-vl-424b-a47b": {
    "id": "openrouter/baidu/ernie-4.5-vl-424b-a47b",
    "openRouterId": "baidu/ernie-4.5-vl-424b-a47b",
    "provider": "openrouter",
    "displayName": "Baidu: ERNIE 4.5 VL 424B A47B ",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.42,
      "outputPer1M": 1.25
    },
    "maxTokens": 123000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/bytedance-seed/seed-1.6": {
    "id": "openrouter/bytedance-seed/seed-1.6",
    "openRouterId": "bytedance-seed/seed-1.6",
    "provider": "openrouter",
    "displayName": "ByteDance Seed: Seed 1.6",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.25,
      "outputPer1M": 2
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/bytedance-seed/seed-1.6-flash": {
    "id": "openrouter/bytedance-seed/seed-1.6-flash",
    "openRouterId": "bytedance-seed/seed-1.6-flash",
    "provider": "openrouter",
    "displayName": "ByteDance Seed: Seed 1.6 Flash",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.08,
      "outputPer1M": 0.3
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/bytedance-seed/seed-2.0-lite": {
    "id": "openrouter/bytedance-seed/seed-2.0-lite",
    "openRouterId": "bytedance-seed/seed-2.0-lite",
    "provider": "openrouter",
    "displayName": "ByteDance Seed: Seed-2.0-Lite",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.25,
      "outputPer1M": 2
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/bytedance-seed/seed-2.0-mini": {
    "id": "openrouter/bytedance-seed/seed-2.0-mini",
    "openRouterId": "bytedance-seed/seed-2.0-mini",
    "provider": "openrouter",
    "displayName": "ByteDance Seed: Seed-2.0-Mini",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.1,
      "outputPer1M": 0.4
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/bytedance/ui-tars-1.5-7b": {
    "id": "openrouter/bytedance/ui-tars-1.5-7b",
    "openRouterId": "bytedance/ui-tars-1.5-7b",
    "provider": "openrouter",
    "displayName": "ByteDance: UI-TARS 7B ",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.1,
      "outputPer1M": 0.2
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/cohere/command-a": {
    "id": "openrouter/cohere/command-a",
    "openRouterId": "cohere/command-a",
    "provider": "openrouter",
    "displayName": "Cohere: Command A",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2.5,
      "outputPer1M": 10
    },
    "maxTokens": 256000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/cohere/command-r-08-2024": {
    "id": "openrouter/cohere/command-r-08-2024",
    "openRouterId": "cohere/command-r-08-2024",
    "provider": "openrouter",
    "displayName": "Cohere: Command R (08-2024)",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.15,
      "outputPer1M": 0.6
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/cohere/command-r-plus-08-2024": {
    "id": "openrouter/cohere/command-r-plus-08-2024",
    "openRouterId": "cohere/command-r-plus-08-2024",
    "provider": "openrouter",
    "displayName": "Cohere: Command R+ (08-2024)",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2.5,
      "outputPer1M": 10
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/cohere/command-r7b-12-2024": {
    "id": "openrouter/cohere/command-r7b-12-2024",
    "openRouterId": "cohere/command-r7b-12-2024",
    "provider": "openrouter",
    "displayName": "Cohere: Command R7B (12-2024)",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.04,
      "outputPer1M": 0.15
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/deepcogito/cogito-v2.1-671b": {
    "id": "openrouter/deepcogito/cogito-v2.1-671b",
    "openRouterId": "deepcogito/cogito-v2.1-671b",
    "provider": "openrouter",
    "displayName": "Deep Cogito: Cogito v2.1 671B",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.25,
      "outputPer1M": 1.25
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/deepseek/deepseek-chat": {
    "id": "openrouter/deepseek/deepseek-chat",
    "openRouterId": "deepseek/deepseek-chat",
    "provider": "openrouter",
    "displayName": "DeepSeek: DeepSeek V3",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.32,
      "outputPer1M": 0.89
    },
    "maxTokens": 163840,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/deepseek/deepseek-chat-v3-0324": {
    "id": "openrouter/deepseek/deepseek-chat-v3-0324",
    "openRouterId": "deepseek/deepseek-chat-v3-0324",
    "provider": "openrouter",
    "displayName": "DeepSeek: DeepSeek V3 0324",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.2,
      "outputPer1M": 0.77
    },
    "maxTokens": 163840,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/deepseek/deepseek-chat-v3.1": {
    "id": "openrouter/deepseek/deepseek-chat-v3.1",
    "openRouterId": "deepseek/deepseek-chat-v3.1",
    "provider": "openrouter",
    "displayName": "DeepSeek: DeepSeek V3.1",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.15,
      "outputPer1M": 0.75
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/deepseek/deepseek-r1": {
    "id": "openrouter/deepseek/deepseek-r1",
    "openRouterId": "deepseek/deepseek-r1",
    "provider": "openrouter",
    "displayName": "DeepSeek: R1",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.7,
      "outputPer1M": 2.5
    },
    "maxTokens": 64000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/deepseek/deepseek-r1-0528": {
    "id": "openrouter/deepseek/deepseek-r1-0528",
    "openRouterId": "deepseek/deepseek-r1-0528",
    "provider": "openrouter",
    "displayName": "DeepSeek: R1 0528",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.45,
      "outputPer1M": 2.15
    },
    "maxTokens": 163840,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/deepseek/deepseek-r1-distill-llama-70b": {
    "id": "openrouter/deepseek/deepseek-r1-distill-llama-70b",
    "openRouterId": "deepseek/deepseek-r1-distill-llama-70b",
    "provider": "openrouter",
    "displayName": "DeepSeek: R1 Distill Llama 70B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.7,
      "outputPer1M": 0.8
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/deepseek/deepseek-r1-distill-qwen-32b": {
    "id": "openrouter/deepseek/deepseek-r1-distill-qwen-32b",
    "openRouterId": "deepseek/deepseek-r1-distill-qwen-32b",
    "provider": "openrouter",
    "displayName": "DeepSeek: R1 Distill Qwen 32B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.29,
      "outputPer1M": 0.29
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/deepseek/deepseek-v3.1-terminus": {
    "id": "openrouter/deepseek/deepseek-v3.1-terminus",
    "openRouterId": "deepseek/deepseek-v3.1-terminus",
    "provider": "openrouter",
    "displayName": "DeepSeek: DeepSeek V3.1 Terminus",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.21,
      "outputPer1M": 0.79
    },
    "maxTokens": 163840,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/deepseek/deepseek-v3.2": {
    "id": "openrouter/deepseek/deepseek-v3.2",
    "openRouterId": "deepseek/deepseek-v3.2",
    "provider": "openrouter",
    "displayName": "DeepSeek: DeepSeek V3.2",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.26,
      "outputPer1M": 0.38
    },
    "maxTokens": 163840,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/deepseek/deepseek-v3.2-exp": {
    "id": "openrouter/deepseek/deepseek-v3.2-exp",
    "openRouterId": "deepseek/deepseek-v3.2-exp",
    "provider": "openrouter",
    "displayName": "DeepSeek: DeepSeek V3.2 Exp",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.27,
      "outputPer1M": 0.41
    },
    "maxTokens": 163840,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/deepseek/deepseek-v3.2-speciale": {
    "id": "openrouter/deepseek/deepseek-v3.2-speciale",
    "openRouterId": "deepseek/deepseek-v3.2-speciale",
    "provider": "openrouter",
    "displayName": "DeepSeek: DeepSeek V3.2 Speciale",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.4,
      "outputPer1M": 1.2
    },
    "maxTokens": 163840,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/eleutherai/llemma_7b": {
    "id": "openrouter/eleutherai/llemma_7b",
    "openRouterId": "eleutherai/llemma_7b",
    "provider": "openrouter",
    "displayName": "EleutherAI: Llemma 7b",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.8,
      "outputPer1M": 1.2
    },
    "maxTokens": 4096,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/essentialai/rnj-1-instruct": {
    "id": "openrouter/essentialai/rnj-1-instruct",
    "openRouterId": "essentialai/rnj-1-instruct",
    "provider": "openrouter",
    "displayName": "EssentialAI: Rnj 1 Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.15,
      "outputPer1M": 0.15
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/google/gemini-2.0-flash-001": {
    "id": "openrouter/google/gemini-2.0-flash-001",
    "openRouterId": "google/gemini-2.0-flash-001",
    "provider": "openrouter",
    "displayName": "Google: Gemini 2.0 Flash",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.1,
      "outputPer1M": 0.4
    },
    "maxTokens": 1048576,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemini-2.0-flash-lite-001": {
    "id": "openrouter/google/gemini-2.0-flash-lite-001",
    "openRouterId": "google/gemini-2.0-flash-lite-001",
    "provider": "openrouter",
    "displayName": "Google: Gemini 2.0 Flash Lite",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.08,
      "outputPer1M": 0.3
    },
    "maxTokens": 1048576,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemini-2.5-flash": {
    "id": "openrouter/google/gemini-2.5-flash",
    "openRouterId": "google/gemini-2.5-flash",
    "provider": "openrouter",
    "displayName": "Google: Gemini 2.5 Flash",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.3,
      "outputPer1M": 2.5
    },
    "maxTokens": 1048576,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemini-2.5-flash-image": {
    "id": "openrouter/google/gemini-2.5-flash-image",
    "openRouterId": "google/gemini-2.5-flash-image",
    "provider": "openrouter",
    "displayName": "Google: Nano Banana (Gemini 2.5 Flash Image)",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.3,
      "outputPer1M": 2.5
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemini-2.5-flash-lite": {
    "id": "openrouter/google/gemini-2.5-flash-lite",
    "openRouterId": "google/gemini-2.5-flash-lite",
    "provider": "openrouter",
    "displayName": "Google: Gemini 2.5 Flash Lite",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.1,
      "outputPer1M": 0.4
    },
    "maxTokens": 1048576,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemini-2.5-flash-lite-preview-09-2025": {
    "id": "openrouter/google/gemini-2.5-flash-lite-preview-09-2025",
    "openRouterId": "google/gemini-2.5-flash-lite-preview-09-2025",
    "provider": "openrouter",
    "displayName": "Google: Gemini 2.5 Flash Lite Preview 09-2025",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.1,
      "outputPer1M": 0.4
    },
    "maxTokens": 1048576,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemini-2.5-pro": {
    "id": "openrouter/google/gemini-2.5-pro",
    "openRouterId": "google/gemini-2.5-pro",
    "provider": "openrouter",
    "displayName": "Google: Gemini 2.5 Pro",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.25,
      "outputPer1M": 10
    },
    "maxTokens": 1048576,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemini-2.5-pro-preview": {
    "id": "openrouter/google/gemini-2.5-pro-preview",
    "openRouterId": "google/gemini-2.5-pro-preview",
    "provider": "openrouter",
    "displayName": "Google: Gemini 2.5 Pro Preview 06-05",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.25,
      "outputPer1M": 10
    },
    "maxTokens": 1048576,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemini-2.5-pro-preview-05-06": {
    "id": "openrouter/google/gemini-2.5-pro-preview-05-06",
    "openRouterId": "google/gemini-2.5-pro-preview-05-06",
    "provider": "openrouter",
    "displayName": "Google: Gemini 2.5 Pro Preview 05-06",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.25,
      "outputPer1M": 10
    },
    "maxTokens": 1048576,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemini-3-flash-preview": {
    "id": "openrouter/google/gemini-3-flash-preview",
    "openRouterId": "google/gemini-3-flash-preview",
    "provider": "openrouter",
    "displayName": "Google: Gemini 3 Flash Preview",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.5,
      "outputPer1M": 3
    },
    "maxTokens": 1048576,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemini-3-pro-image-preview": {
    "id": "openrouter/google/gemini-3-pro-image-preview",
    "openRouterId": "google/gemini-3-pro-image-preview",
    "provider": "openrouter",
    "displayName": "Google: Nano Banana Pro (Gemini 3 Pro Image Preview)",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2,
      "outputPer1M": 12
    },
    "maxTokens": 65536,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemini-3-pro-preview": {
    "id": "openrouter/google/gemini-3-pro-preview",
    "openRouterId": "google/gemini-3-pro-preview",
    "provider": "openrouter",
    "displayName": "Google: Gemini 3 Pro Preview",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2,
      "outputPer1M": 12
    },
    "maxTokens": 1048576,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemini-3.1-flash-image-preview": {
    "id": "openrouter/google/gemini-3.1-flash-image-preview",
    "openRouterId": "google/gemini-3.1-flash-image-preview",
    "provider": "openrouter",
    "displayName": "Google: Nano Banana 2 (Gemini 3.1 Flash Image Preview)",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.5,
      "outputPer1M": 3
    },
    "maxTokens": 65536,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemini-3.1-flash-lite-preview": {
    "id": "openrouter/google/gemini-3.1-flash-lite-preview",
    "openRouterId": "google/gemini-3.1-flash-lite-preview",
    "provider": "openrouter",
    "displayName": "Google: Gemini 3.1 Flash Lite Preview",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.25,
      "outputPer1M": 1.5
    },
    "maxTokens": 1048576,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemini-3.1-pro-preview": {
    "id": "openrouter/google/gemini-3.1-pro-preview",
    "openRouterId": "google/gemini-3.1-pro-preview",
    "provider": "openrouter",
    "displayName": "Google: Gemini 3.1 Pro Preview",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2,
      "outputPer1M": 12
    },
    "maxTokens": 1048576,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemini-3.1-pro-preview-customtools": {
    "id": "openrouter/google/gemini-3.1-pro-preview-customtools",
    "openRouterId": "google/gemini-3.1-pro-preview-customtools",
    "provider": "openrouter",
    "displayName": "Google: Gemini 3.1 Pro Preview Custom Tools",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2,
      "outputPer1M": 12
    },
    "maxTokens": 1048576,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemma-2-27b-it": {
    "id": "openrouter/google/gemma-2-27b-it",
    "openRouterId": "google/gemma-2-27b-it",
    "provider": "openrouter",
    "displayName": "Google: Gemma 2 27B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.65,
      "outputPer1M": 0.65
    },
    "maxTokens": 8192,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemma-2-9b-it": {
    "id": "openrouter/google/gemma-2-9b-it",
    "openRouterId": "google/gemma-2-9b-it",
    "provider": "openrouter",
    "displayName": "Google: Gemma 2 9B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.03,
      "outputPer1M": 0.09
    },
    "maxTokens": 8192,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemma-3-12b-it": {
    "id": "openrouter/google/gemma-3-12b-it",
    "openRouterId": "google/gemma-3-12b-it",
    "provider": "openrouter",
    "displayName": "Google: Gemma 3 12B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.04,
      "outputPer1M": 0.13
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemma-3-27b-it": {
    "id": "openrouter/google/gemma-3-27b-it",
    "openRouterId": "google/gemma-3-27b-it",
    "provider": "openrouter",
    "displayName": "Google: Gemma 3 27B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.08,
      "outputPer1M": 0.16
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemma-3-4b-it": {
    "id": "openrouter/google/gemma-3-4b-it",
    "openRouterId": "google/gemma-3-4b-it",
    "provider": "openrouter",
    "displayName": "Google: Gemma 3 4B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.04,
      "outputPer1M": 0.08
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/google/gemma-3n-e4b-it": {
    "id": "openrouter/google/gemma-3n-e4b-it",
    "openRouterId": "google/gemma-3n-e4b-it",
    "provider": "openrouter",
    "displayName": "Google: Gemma 3n 4B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.02,
      "outputPer1M": 0.04
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": true,
    "supportsThinking": false
  },
  "openrouter/gryphe/mythomax-l2-13b": {
    "id": "openrouter/gryphe/mythomax-l2-13b",
    "openRouterId": "gryphe/mythomax-l2-13b",
    "provider": "openrouter",
    "displayName": "MythoMax 13B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.06,
      "outputPer1M": 0.06
    },
    "maxTokens": 4096,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/ibm-granite/granite-4.0-h-micro": {
    "id": "openrouter/ibm-granite/granite-4.0-h-micro",
    "openRouterId": "ibm-granite/granite-4.0-h-micro",
    "provider": "openrouter",
    "displayName": "IBM: Granite 4.0 Micro",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.02,
      "outputPer1M": 0.11
    },
    "maxTokens": 131000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/inception/mercury": {
    "id": "openrouter/inception/mercury",
    "openRouterId": "inception/mercury",
    "provider": "openrouter",
    "displayName": "Inception: Mercury",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.25,
      "outputPer1M": 0.75
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/inception/mercury-2": {
    "id": "openrouter/inception/mercury-2",
    "openRouterId": "inception/mercury-2",
    "provider": "openrouter",
    "displayName": "Inception: Mercury 2",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.25,
      "outputPer1M": 0.75
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/inception/mercury-coder": {
    "id": "openrouter/inception/mercury-coder",
    "openRouterId": "inception/mercury-coder",
    "provider": "openrouter",
    "displayName": "Inception: Mercury Coder",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.25,
      "outputPer1M": 0.75
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/inflection/inflection-3-pi": {
    "id": "openrouter/inflection/inflection-3-pi",
    "openRouterId": "inflection/inflection-3-pi",
    "provider": "openrouter",
    "displayName": "Inflection: Inflection 3 Pi",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2.5,
      "outputPer1M": 10
    },
    "maxTokens": 8000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/inflection/inflection-3-productivity": {
    "id": "openrouter/inflection/inflection-3-productivity",
    "openRouterId": "inflection/inflection-3-productivity",
    "provider": "openrouter",
    "displayName": "Inflection: Inflection 3 Productivity",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2.5,
      "outputPer1M": 10
    },
    "maxTokens": 8000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/kwaipilot/kat-coder-pro": {
    "id": "openrouter/kwaipilot/kat-coder-pro",
    "openRouterId": "kwaipilot/kat-coder-pro",
    "provider": "openrouter",
    "displayName": "Kwaipilot: KAT-Coder-Pro V1",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.21,
      "outputPer1M": 0.83
    },
    "maxTokens": 256000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/liquid/lfm-2-24b-a2b": {
    "id": "openrouter/liquid/lfm-2-24b-a2b",
    "openRouterId": "liquid/lfm-2-24b-a2b",
    "provider": "openrouter",
    "displayName": "LiquidAI: LFM2-24B-A2B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.03,
      "outputPer1M": 0.12
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/liquid/lfm-2.2-6b": {
    "id": "openrouter/liquid/lfm-2.2-6b",
    "openRouterId": "liquid/lfm-2.2-6b",
    "provider": "openrouter",
    "displayName": "LiquidAI: LFM2-2.6B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.01,
      "outputPer1M": 0.02
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/liquid/lfm2-8b-a1b": {
    "id": "openrouter/liquid/lfm2-8b-a1b",
    "openRouterId": "liquid/lfm2-8b-a1b",
    "provider": "openrouter",
    "displayName": "LiquidAI: LFM2-8B-A1B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.01,
      "outputPer1M": 0.02
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mancer/weaver": {
    "id": "openrouter/mancer/weaver",
    "openRouterId": "mancer/weaver",
    "provider": "openrouter",
    "displayName": "Mancer: Weaver (alpha)",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.75,
      "outputPer1M": 1
    },
    "maxTokens": 8000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/meituan/longcat-flash-chat": {
    "id": "openrouter/meituan/longcat-flash-chat",
    "openRouterId": "meituan/longcat-flash-chat",
    "provider": "openrouter",
    "displayName": "Meituan: LongCat Flash Chat",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.2,
      "outputPer1M": 0.8
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/meta-llama/llama-3-70b-instruct": {
    "id": "openrouter/meta-llama/llama-3-70b-instruct",
    "openRouterId": "meta-llama/llama-3-70b-instruct",
    "provider": "openrouter",
    "displayName": "Meta: Llama 3 70B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.51,
      "outputPer1M": 0.74
    },
    "maxTokens": 8192,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/meta-llama/llama-3-8b-instruct": {
    "id": "openrouter/meta-llama/llama-3-8b-instruct",
    "openRouterId": "meta-llama/llama-3-8b-instruct",
    "provider": "openrouter",
    "displayName": "Meta: Llama 3 8B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.03,
      "outputPer1M": 0.04
    },
    "maxTokens": 8192,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/meta-llama/llama-3.1-405b": {
    "id": "openrouter/meta-llama/llama-3.1-405b",
    "openRouterId": "meta-llama/llama-3.1-405b",
    "provider": "openrouter",
    "displayName": "Meta: Llama 3.1 405B (base)",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 4,
      "outputPer1M": 4
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/meta-llama/llama-3.1-70b-instruct": {
    "id": "openrouter/meta-llama/llama-3.1-70b-instruct",
    "openRouterId": "meta-llama/llama-3.1-70b-instruct",
    "provider": "openrouter",
    "displayName": "Meta: Llama 3.1 70B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.4,
      "outputPer1M": 0.4
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/meta-llama/llama-3.1-8b-instruct": {
    "id": "openrouter/meta-llama/llama-3.1-8b-instruct",
    "openRouterId": "meta-llama/llama-3.1-8b-instruct",
    "provider": "openrouter",
    "displayName": "Meta: Llama 3.1 8B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.02,
      "outputPer1M": 0.05
    },
    "maxTokens": 16384,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/meta-llama/llama-3.2-11b-vision-instruct": {
    "id": "openrouter/meta-llama/llama-3.2-11b-vision-instruct",
    "openRouterId": "meta-llama/llama-3.2-11b-vision-instruct",
    "provider": "openrouter",
    "displayName": "Meta: Llama 3.2 11B Vision Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.05,
      "outputPer1M": 0.05
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/meta-llama/llama-3.2-1b-instruct": {
    "id": "openrouter/meta-llama/llama-3.2-1b-instruct",
    "openRouterId": "meta-llama/llama-3.2-1b-instruct",
    "provider": "openrouter",
    "displayName": "Meta: Llama 3.2 1B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.03,
      "outputPer1M": 0.2
    },
    "maxTokens": 60000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/meta-llama/llama-3.2-3b-instruct": {
    "id": "openrouter/meta-llama/llama-3.2-3b-instruct",
    "openRouterId": "meta-llama/llama-3.2-3b-instruct",
    "provider": "openrouter",
    "displayName": "Meta: Llama 3.2 3B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.05,
      "outputPer1M": 0.34
    },
    "maxTokens": 80000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/meta-llama/llama-3.3-70b-instruct": {
    "id": "openrouter/meta-llama/llama-3.3-70b-instruct",
    "openRouterId": "meta-llama/llama-3.3-70b-instruct",
    "provider": "openrouter",
    "displayName": "Meta: Llama 3.3 70B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.1,
      "outputPer1M": 0.32
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/meta-llama/llama-4-maverick": {
    "id": "openrouter/meta-llama/llama-4-maverick",
    "openRouterId": "meta-llama/llama-4-maverick",
    "provider": "openrouter",
    "displayName": "Meta: Llama 4 Maverick",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.15,
      "outputPer1M": 0.6
    },
    "maxTokens": 1048576,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/meta-llama/llama-4-scout": {
    "id": "openrouter/meta-llama/llama-4-scout",
    "openRouterId": "meta-llama/llama-4-scout",
    "provider": "openrouter",
    "displayName": "Meta: Llama 4 Scout",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.08,
      "outputPer1M": 0.3
    },
    "maxTokens": 327680,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/meta-llama/llama-guard-3-8b": {
    "id": "openrouter/meta-llama/llama-guard-3-8b",
    "openRouterId": "meta-llama/llama-guard-3-8b",
    "provider": "openrouter",
    "displayName": "Llama Guard 3 8B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.02,
      "outputPer1M": 0.06
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/meta-llama/llama-guard-4-12b": {
    "id": "openrouter/meta-llama/llama-guard-4-12b",
    "openRouterId": "meta-llama/llama-guard-4-12b",
    "provider": "openrouter",
    "displayName": "Meta: Llama Guard 4 12B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.18,
      "outputPer1M": 0.18
    },
    "maxTokens": 163840,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/microsoft/phi-4": {
    "id": "openrouter/microsoft/phi-4",
    "openRouterId": "microsoft/phi-4",
    "provider": "openrouter",
    "displayName": "Microsoft: Phi 4",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.07,
      "outputPer1M": 0.14
    },
    "maxTokens": 16384,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/microsoft/wizardlm-2-8x22b": {
    "id": "openrouter/microsoft/wizardlm-2-8x22b",
    "openRouterId": "microsoft/wizardlm-2-8x22b",
    "provider": "openrouter",
    "displayName": "WizardLM-2 8x22B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.62,
      "outputPer1M": 0.62
    },
    "maxTokens": 65535,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/minimax/minimax-01": {
    "id": "openrouter/minimax/minimax-01",
    "openRouterId": "minimax/minimax-01",
    "provider": "openrouter",
    "displayName": "MiniMax: MiniMax-01",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.2,
      "outputPer1M": 1.1
    },
    "maxTokens": 1000192,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/minimax/minimax-m1": {
    "id": "openrouter/minimax/minimax-m1",
    "openRouterId": "minimax/minimax-m1",
    "provider": "openrouter",
    "displayName": "MiniMax: MiniMax M1",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.4,
      "outputPer1M": 2.2
    },
    "maxTokens": 1000000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/minimax/minimax-m2": {
    "id": "openrouter/minimax/minimax-m2",
    "openRouterId": "minimax/minimax-m2",
    "provider": "openrouter",
    "displayName": "MiniMax: MiniMax M2",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.26,
      "outputPer1M": 1
    },
    "maxTokens": 196608,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/minimax/minimax-m2-her": {
    "id": "openrouter/minimax/minimax-m2-her",
    "openRouterId": "minimax/minimax-m2-her",
    "provider": "openrouter",
    "displayName": "MiniMax: MiniMax M2-her",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.3,
      "outputPer1M": 1.2
    },
    "maxTokens": 65536,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/minimax/minimax-m2.1": {
    "id": "openrouter/minimax/minimax-m2.1",
    "openRouterId": "minimax/minimax-m2.1",
    "provider": "openrouter",
    "displayName": "MiniMax: MiniMax M2.1",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.27,
      "outputPer1M": 0.95
    },
    "maxTokens": 196608,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/minimax/minimax-m2.5": {
    "id": "openrouter/minimax/minimax-m2.5",
    "openRouterId": "minimax/minimax-m2.5",
    "provider": "openrouter",
    "displayName": "MiniMax: MiniMax M2.5",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.2,
      "outputPer1M": 1.17
    },
    "maxTokens": 196608,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/minimax/minimax-m2.7": {
    "id": "openrouter/minimax/minimax-m2.7",
    "openRouterId": "minimax/minimax-m2.7",
    "provider": "openrouter",
    "displayName": "MiniMax: MiniMax M2.7",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.3,
      "outputPer1M": 1.2
    },
    "maxTokens": 204800,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/codestral-2508": {
    "id": "openrouter/mistralai/codestral-2508",
    "openRouterId": "mistralai/codestral-2508",
    "provider": "openrouter",
    "displayName": "Mistral: Codestral 2508",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.3,
      "outputPer1M": 0.9
    },
    "maxTokens": 256000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/devstral-2512": {
    "id": "openrouter/mistralai/devstral-2512",
    "openRouterId": "mistralai/devstral-2512",
    "provider": "openrouter",
    "displayName": "Mistral: Devstral 2 2512",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.4,
      "outputPer1M": 2
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/devstral-medium": {
    "id": "openrouter/mistralai/devstral-medium",
    "openRouterId": "mistralai/devstral-medium",
    "provider": "openrouter",
    "displayName": "Mistral: Devstral Medium",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.4,
      "outputPer1M": 2
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/devstral-small": {
    "id": "openrouter/mistralai/devstral-small",
    "openRouterId": "mistralai/devstral-small",
    "provider": "openrouter",
    "displayName": "Mistral: Devstral Small 1.1",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.1,
      "outputPer1M": 0.3
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/ministral-14b-2512": {
    "id": "openrouter/mistralai/ministral-14b-2512",
    "openRouterId": "mistralai/ministral-14b-2512",
    "provider": "openrouter",
    "displayName": "Mistral: Ministral 3 14B 2512",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.2,
      "outputPer1M": 0.2
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/ministral-3b-2512": {
    "id": "openrouter/mistralai/ministral-3b-2512",
    "openRouterId": "mistralai/ministral-3b-2512",
    "provider": "openrouter",
    "displayName": "Mistral: Ministral 3 3B 2512",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.1,
      "outputPer1M": 0.1
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/ministral-8b-2512": {
    "id": "openrouter/mistralai/ministral-8b-2512",
    "openRouterId": "mistralai/ministral-8b-2512",
    "provider": "openrouter",
    "displayName": "Mistral: Ministral 3 8B 2512",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.15,
      "outputPer1M": 0.15
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/mistral-7b-instruct-v0.1": {
    "id": "openrouter/mistralai/mistral-7b-instruct-v0.1",
    "openRouterId": "mistralai/mistral-7b-instruct-v0.1",
    "provider": "openrouter",
    "displayName": "Mistral: Mistral 7B Instruct v0.1",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.11,
      "outputPer1M": 0.19
    },
    "maxTokens": 2824,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/mistral-large": {
    "id": "openrouter/mistralai/mistral-large",
    "openRouterId": "mistralai/mistral-large",
    "provider": "openrouter",
    "displayName": "Mistral Large",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2,
      "outputPer1M": 6
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/mistral-large-2407": {
    "id": "openrouter/mistralai/mistral-large-2407",
    "openRouterId": "mistralai/mistral-large-2407",
    "provider": "openrouter",
    "displayName": "Mistral Large 2407",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2,
      "outputPer1M": 6
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/mistral-large-2411": {
    "id": "openrouter/mistralai/mistral-large-2411",
    "openRouterId": "mistralai/mistral-large-2411",
    "provider": "openrouter",
    "displayName": "Mistral Large 2411",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2,
      "outputPer1M": 6
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/mistral-large-2512": {
    "id": "openrouter/mistralai/mistral-large-2512",
    "openRouterId": "mistralai/mistral-large-2512",
    "provider": "openrouter",
    "displayName": "Mistral: Mistral Large 3 2512",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.5,
      "outputPer1M": 1.5
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/mistral-medium-3": {
    "id": "openrouter/mistralai/mistral-medium-3",
    "openRouterId": "mistralai/mistral-medium-3",
    "provider": "openrouter",
    "displayName": "Mistral: Mistral Medium 3",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.4,
      "outputPer1M": 2
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/mistral-medium-3.1": {
    "id": "openrouter/mistralai/mistral-medium-3.1",
    "openRouterId": "mistralai/mistral-medium-3.1",
    "provider": "openrouter",
    "displayName": "Mistral: Mistral Medium 3.1",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.4,
      "outputPer1M": 2
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/mistral-nemo": {
    "id": "openrouter/mistralai/mistral-nemo",
    "openRouterId": "mistralai/mistral-nemo",
    "provider": "openrouter",
    "displayName": "Mistral: Mistral Nemo",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.02,
      "outputPer1M": 0.04
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/mistral-saba": {
    "id": "openrouter/mistralai/mistral-saba",
    "openRouterId": "mistralai/mistral-saba",
    "provider": "openrouter",
    "displayName": "Mistral: Saba",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.2,
      "outputPer1M": 0.6
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/mistral-small-24b-instruct-2501": {
    "id": "openrouter/mistralai/mistral-small-24b-instruct-2501",
    "openRouterId": "mistralai/mistral-small-24b-instruct-2501",
    "provider": "openrouter",
    "displayName": "Mistral: Mistral Small 3",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.05,
      "outputPer1M": 0.08
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/mistral-small-2603": {
    "id": "openrouter/mistralai/mistral-small-2603",
    "openRouterId": "mistralai/mistral-small-2603",
    "provider": "openrouter",
    "displayName": "Mistral: Mistral Small 4",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.15,
      "outputPer1M": 0.6
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/mistral-small-3.1-24b-instruct": {
    "id": "openrouter/mistralai/mistral-small-3.1-24b-instruct",
    "openRouterId": "mistralai/mistral-small-3.1-24b-instruct",
    "provider": "openrouter",
    "displayName": "Mistral: Mistral Small 3.1 24B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.03,
      "outputPer1M": 0.11
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/mistral-small-3.2-24b-instruct": {
    "id": "openrouter/mistralai/mistral-small-3.2-24b-instruct",
    "openRouterId": "mistralai/mistral-small-3.2-24b-instruct",
    "provider": "openrouter",
    "displayName": "Mistral: Mistral Small 3.2 24B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.08,
      "outputPer1M": 0.2
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/mistral-small-creative": {
    "id": "openrouter/mistralai/mistral-small-creative",
    "openRouterId": "mistralai/mistral-small-creative",
    "provider": "openrouter",
    "displayName": "Mistral: Mistral Small Creative",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.1,
      "outputPer1M": 0.3
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/mixtral-8x22b-instruct": {
    "id": "openrouter/mistralai/mixtral-8x22b-instruct",
    "openRouterId": "mistralai/mixtral-8x22b-instruct",
    "provider": "openrouter",
    "displayName": "Mistral: Mixtral 8x22B Instruct",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2,
      "outputPer1M": 6
    },
    "maxTokens": 65536,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/mixtral-8x7b-instruct": {
    "id": "openrouter/mistralai/mixtral-8x7b-instruct",
    "openRouterId": "mistralai/mixtral-8x7b-instruct",
    "provider": "openrouter",
    "displayName": "Mistral: Mixtral 8x7B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.54,
      "outputPer1M": 0.54
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/pixtral-12b": {
    "id": "openrouter/mistralai/pixtral-12b",
    "openRouterId": "mistralai/pixtral-12b",
    "provider": "openrouter",
    "displayName": "Mistral: Pixtral 12B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.1,
      "outputPer1M": 0.1
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/pixtral-large-2411": {
    "id": "openrouter/mistralai/pixtral-large-2411",
    "openRouterId": "mistralai/pixtral-large-2411",
    "provider": "openrouter",
    "displayName": "Mistral: Pixtral Large 2411",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2,
      "outputPer1M": 6
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/mistralai/voxtral-small-24b-2507": {
    "id": "openrouter/mistralai/voxtral-small-24b-2507",
    "openRouterId": "mistralai/voxtral-small-24b-2507",
    "provider": "openrouter",
    "displayName": "Mistral: Voxtral Small 24B 2507",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.1,
      "outputPer1M": 0.3
    },
    "maxTokens": 32000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/moonshotai/kimi-k2": {
    "id": "openrouter/moonshotai/kimi-k2",
    "openRouterId": "moonshotai/kimi-k2",
    "provider": "openrouter",
    "displayName": "MoonshotAI: Kimi K2 0711",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.55,
      "outputPer1M": 2.2
    },
    "maxTokens": 131000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/moonshotai/kimi-k2-0905": {
    "id": "openrouter/moonshotai/kimi-k2-0905",
    "openRouterId": "moonshotai/kimi-k2-0905",
    "provider": "openrouter",
    "displayName": "MoonshotAI: Kimi K2 0905",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.4,
      "outputPer1M": 2
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/moonshotai/kimi-k2-thinking": {
    "id": "openrouter/moonshotai/kimi-k2-thinking",
    "openRouterId": "moonshotai/kimi-k2-thinking",
    "provider": "openrouter",
    "displayName": "MoonshotAI: Kimi K2 Thinking",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.47,
      "outputPer1M": 2
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/moonshotai/kimi-k2.5": {
    "id": "openrouter/moonshotai/kimi-k2.5",
    "openRouterId": "moonshotai/kimi-k2.5",
    "provider": "openrouter",
    "displayName": "MoonshotAI: Kimi K2.5",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.45,
      "outputPer1M": 2.2
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/morph/morph-v3-fast": {
    "id": "openrouter/morph/morph-v3-fast",
    "openRouterId": "morph/morph-v3-fast",
    "provider": "openrouter",
    "displayName": "Morph: Morph V3 Fast",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.8,
      "outputPer1M": 1.2
    },
    "maxTokens": 81920,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/morph/morph-v3-large": {
    "id": "openrouter/morph/morph-v3-large",
    "openRouterId": "morph/morph-v3-large",
    "provider": "openrouter",
    "displayName": "Morph: Morph V3 Large",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.9,
      "outputPer1M": 1.9
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/nex-agi/deepseek-v3.1-nex-n1": {
    "id": "openrouter/nex-agi/deepseek-v3.1-nex-n1",
    "openRouterId": "nex-agi/deepseek-v3.1-nex-n1",
    "provider": "openrouter",
    "displayName": "Nex AGI: DeepSeek V3.1 Nex N1",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.27,
      "outputPer1M": 1
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/nousresearch/hermes-2-pro-llama-3-8b": {
    "id": "openrouter/nousresearch/hermes-2-pro-llama-3-8b",
    "openRouterId": "nousresearch/hermes-2-pro-llama-3-8b",
    "provider": "openrouter",
    "displayName": "NousResearch: Hermes 2 Pro - Llama-3 8B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.14,
      "outputPer1M": 0.14
    },
    "maxTokens": 8192,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/nousresearch/hermes-3-llama-3.1-405b": {
    "id": "openrouter/nousresearch/hermes-3-llama-3.1-405b",
    "openRouterId": "nousresearch/hermes-3-llama-3.1-405b",
    "provider": "openrouter",
    "displayName": "Nous: Hermes 3 405B Instruct",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1,
      "outputPer1M": 1
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/nousresearch/hermes-3-llama-3.1-70b": {
    "id": "openrouter/nousresearch/hermes-3-llama-3.1-70b",
    "openRouterId": "nousresearch/hermes-3-llama-3.1-70b",
    "provider": "openrouter",
    "displayName": "Nous: Hermes 3 70B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.3,
      "outputPer1M": 0.3
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/nousresearch/hermes-4-405b": {
    "id": "openrouter/nousresearch/hermes-4-405b",
    "openRouterId": "nousresearch/hermes-4-405b",
    "provider": "openrouter",
    "displayName": "Nous: Hermes 4 405B",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1,
      "outputPer1M": 3
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/nousresearch/hermes-4-70b": {
    "id": "openrouter/nousresearch/hermes-4-70b",
    "openRouterId": "nousresearch/hermes-4-70b",
    "provider": "openrouter",
    "displayName": "Nous: Hermes 4 70B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.13,
      "outputPer1M": 0.4
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/nvidia/llama-3.1-nemotron-70b-instruct": {
    "id": "openrouter/nvidia/llama-3.1-nemotron-70b-instruct",
    "openRouterId": "nvidia/llama-3.1-nemotron-70b-instruct",
    "provider": "openrouter",
    "displayName": "NVIDIA: Llama 3.1 Nemotron 70B Instruct",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.2,
      "outputPer1M": 1.2
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/nvidia/llama-3.1-nemotron-ultra-253b-v1": {
    "id": "openrouter/nvidia/llama-3.1-nemotron-ultra-253b-v1",
    "openRouterId": "nvidia/llama-3.1-nemotron-ultra-253b-v1",
    "provider": "openrouter",
    "displayName": "NVIDIA: Llama 3.1 Nemotron Ultra 253B v1",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.6,
      "outputPer1M": 1.8
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/nvidia/llama-3.3-nemotron-super-49b-v1.5": {
    "id": "openrouter/nvidia/llama-3.3-nemotron-super-49b-v1.5",
    "openRouterId": "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    "provider": "openrouter",
    "displayName": "NVIDIA: Llama 3.3 Nemotron Super 49B V1.5",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.1,
      "outputPer1M": 0.4
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/nvidia/nemotron-3-nano-30b-a3b": {
    "id": "openrouter/nvidia/nemotron-3-nano-30b-a3b",
    "openRouterId": "nvidia/nemotron-3-nano-30b-a3b",
    "provider": "openrouter",
    "displayName": "NVIDIA: Nemotron 3 Nano 30B A3B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.05,
      "outputPer1M": 0.2
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/nvidia/nemotron-3-super-120b-a12b": {
    "id": "openrouter/nvidia/nemotron-3-super-120b-a12b",
    "openRouterId": "nvidia/nemotron-3-super-120b-a12b",
    "provider": "openrouter",
    "displayName": "NVIDIA: Nemotron 3 Super",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.1,
      "outputPer1M": 0.5
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/nvidia/nemotron-nano-12b-v2-vl": {
    "id": "openrouter/nvidia/nemotron-nano-12b-v2-vl",
    "openRouterId": "nvidia/nemotron-nano-12b-v2-vl",
    "provider": "openrouter",
    "displayName": "NVIDIA: Nemotron Nano 12B 2 VL",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.2,
      "outputPer1M": 0.6
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/nvidia/nemotron-nano-9b-v2": {
    "id": "openrouter/nvidia/nemotron-nano-9b-v2",
    "openRouterId": "nvidia/nemotron-nano-9b-v2",
    "provider": "openrouter",
    "displayName": "NVIDIA: Nemotron Nano 9B V2",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.04,
      "outputPer1M": 0.16
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-3.5-turbo": {
    "id": "openrouter/openai/gpt-3.5-turbo",
    "openRouterId": "openai/gpt-3.5-turbo",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-3.5 Turbo",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.5,
      "outputPer1M": 1.5
    },
    "maxTokens": 16385,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-3.5-turbo-0613": {
    "id": "openrouter/openai/gpt-3.5-turbo-0613",
    "openRouterId": "openai/gpt-3.5-turbo-0613",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-3.5 Turbo (older v0613)",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1,
      "outputPer1M": 2
    },
    "maxTokens": 4095,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-3.5-turbo-16k": {
    "id": "openrouter/openai/gpt-3.5-turbo-16k",
    "openRouterId": "openai/gpt-3.5-turbo-16k",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-3.5 Turbo 16k",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 3,
      "outputPer1M": 4
    },
    "maxTokens": 16385,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-3.5-turbo-instruct": {
    "id": "openrouter/openai/gpt-3.5-turbo-instruct",
    "openRouterId": "openai/gpt-3.5-turbo-instruct",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-3.5 Turbo Instruct",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.5,
      "outputPer1M": 2
    },
    "maxTokens": 4095,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-4": {
    "id": "openrouter/openai/gpt-4",
    "openRouterId": "openai/gpt-4",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-4",
    "tier": "premium",
    "costs": {
      "inputPer1M": 30,
      "outputPer1M": 60
    },
    "maxTokens": 8191,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-4-0314": {
    "id": "openrouter/openai/gpt-4-0314",
    "openRouterId": "openai/gpt-4-0314",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-4 (older v0314)",
    "tier": "premium",
    "costs": {
      "inputPer1M": 30,
      "outputPer1M": 60
    },
    "maxTokens": 8191,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-4-1106-preview": {
    "id": "openrouter/openai/gpt-4-1106-preview",
    "openRouterId": "openai/gpt-4-1106-preview",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-4 Turbo (older v1106)",
    "tier": "premium",
    "costs": {
      "inputPer1M": 10,
      "outputPer1M": 30
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-4-turbo": {
    "id": "openrouter/openai/gpt-4-turbo",
    "openRouterId": "openai/gpt-4-turbo",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-4 Turbo",
    "tier": "premium",
    "costs": {
      "inputPer1M": 10,
      "outputPer1M": 30
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-4-turbo-preview": {
    "id": "openrouter/openai/gpt-4-turbo-preview",
    "openRouterId": "openai/gpt-4-turbo-preview",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-4 Turbo Preview",
    "tier": "premium",
    "costs": {
      "inputPer1M": 10,
      "outputPer1M": 30
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-4.1": {
    "id": "openrouter/openai/gpt-4.1",
    "openRouterId": "openai/gpt-4.1",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-4.1",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2,
      "outputPer1M": 8
    },
    "maxTokens": 1047576,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-4.1-mini": {
    "id": "openrouter/openai/gpt-4.1-mini",
    "openRouterId": "openai/gpt-4.1-mini",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-4.1 Mini",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.4,
      "outputPer1M": 1.6
    },
    "maxTokens": 1047576,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-4.1-nano": {
    "id": "openrouter/openai/gpt-4.1-nano",
    "openRouterId": "openai/gpt-4.1-nano",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-4.1 Nano",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.1,
      "outputPer1M": 0.4
    },
    "maxTokens": 1047576,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-4o": {
    "id": "openrouter/openai/gpt-4o",
    "openRouterId": "openai/gpt-4o",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-4o",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2.5,
      "outputPer1M": 10
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-4o-2024-05-13": {
    "id": "openrouter/openai/gpt-4o-2024-05-13",
    "openRouterId": "openai/gpt-4o-2024-05-13",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-4o (2024-05-13)",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 5,
      "outputPer1M": 15
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-4o-2024-08-06": {
    "id": "openrouter/openai/gpt-4o-2024-08-06",
    "openRouterId": "openai/gpt-4o-2024-08-06",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-4o (2024-08-06)",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2.5,
      "outputPer1M": 10
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-4o-2024-11-20": {
    "id": "openrouter/openai/gpt-4o-2024-11-20",
    "openRouterId": "openai/gpt-4o-2024-11-20",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-4o (2024-11-20)",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2.5,
      "outputPer1M": 10
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-4o-audio-preview": {
    "id": "openrouter/openai/gpt-4o-audio-preview",
    "openRouterId": "openai/gpt-4o-audio-preview",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-4o Audio",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2.5,
      "outputPer1M": 10
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-4o-mini": {
    "id": "openrouter/openai/gpt-4o-mini",
    "openRouterId": "openai/gpt-4o-mini",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-4o-mini",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.15,
      "outputPer1M": 0.6
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-4o-mini-2024-07-18": {
    "id": "openrouter/openai/gpt-4o-mini-2024-07-18",
    "openRouterId": "openai/gpt-4o-mini-2024-07-18",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-4o-mini (2024-07-18)",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.15,
      "outputPer1M": 0.6
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-4o-mini-search-preview": {
    "id": "openrouter/openai/gpt-4o-mini-search-preview",
    "openRouterId": "openai/gpt-4o-mini-search-preview",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-4o-mini Search Preview",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.15,
      "outputPer1M": 0.6
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-4o-search-preview": {
    "id": "openrouter/openai/gpt-4o-search-preview",
    "openRouterId": "openai/gpt-4o-search-preview",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-4o Search Preview",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2.5,
      "outputPer1M": 10
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-4o:extended": {
    "id": "openrouter/openai/gpt-4o:extended",
    "openRouterId": "openai/gpt-4o:extended",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-4o (extended)",
    "tier": "premium",
    "costs": {
      "inputPer1M": 6,
      "outputPer1M": 18
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5": {
    "id": "openrouter/openai/gpt-5",
    "openRouterId": "openai/gpt-5",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.25,
      "outputPer1M": 10
    },
    "maxTokens": 400000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5-chat": {
    "id": "openrouter/openai/gpt-5-chat",
    "openRouterId": "openai/gpt-5-chat",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5 Chat",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.25,
      "outputPer1M": 10
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5-codex": {
    "id": "openrouter/openai/gpt-5-codex",
    "openRouterId": "openai/gpt-5-codex",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5 Codex",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.25,
      "outputPer1M": 10
    },
    "maxTokens": 400000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5-image": {
    "id": "openrouter/openai/gpt-5-image",
    "openRouterId": "openai/gpt-5-image",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5 Image",
    "tier": "premium",
    "costs": {
      "inputPer1M": 10,
      "outputPer1M": 10
    },
    "maxTokens": 400000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5-image-mini": {
    "id": "openrouter/openai/gpt-5-image-mini",
    "openRouterId": "openai/gpt-5-image-mini",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5 Image Mini",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2.5,
      "outputPer1M": 2
    },
    "maxTokens": 400000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5-mini": {
    "id": "openrouter/openai/gpt-5-mini",
    "openRouterId": "openai/gpt-5-mini",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5 Mini",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.25,
      "outputPer1M": 2
    },
    "maxTokens": 400000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5-nano": {
    "id": "openrouter/openai/gpt-5-nano",
    "openRouterId": "openai/gpt-5-nano",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5 Nano",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.05,
      "outputPer1M": 0.4
    },
    "maxTokens": 400000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5-pro": {
    "id": "openrouter/openai/gpt-5-pro",
    "openRouterId": "openai/gpt-5-pro",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5 Pro",
    "tier": "premium",
    "costs": {
      "inputPer1M": 15,
      "outputPer1M": 120
    },
    "maxTokens": 400000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5.1": {
    "id": "openrouter/openai/gpt-5.1",
    "openRouterId": "openai/gpt-5.1",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5.1",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.25,
      "outputPer1M": 10
    },
    "maxTokens": 400000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5.1-chat": {
    "id": "openrouter/openai/gpt-5.1-chat",
    "openRouterId": "openai/gpt-5.1-chat",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5.1 Chat",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.25,
      "outputPer1M": 10
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5.1-codex": {
    "id": "openrouter/openai/gpt-5.1-codex",
    "openRouterId": "openai/gpt-5.1-codex",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5.1-Codex",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.25,
      "outputPer1M": 10
    },
    "maxTokens": 400000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5.1-codex-max": {
    "id": "openrouter/openai/gpt-5.1-codex-max",
    "openRouterId": "openai/gpt-5.1-codex-max",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5.1-Codex-Max",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.25,
      "outputPer1M": 10
    },
    "maxTokens": 400000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5.1-codex-mini": {
    "id": "openrouter/openai/gpt-5.1-codex-mini",
    "openRouterId": "openai/gpt-5.1-codex-mini",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5.1-Codex-Mini",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.25,
      "outputPer1M": 2
    },
    "maxTokens": 400000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5.2": {
    "id": "openrouter/openai/gpt-5.2",
    "openRouterId": "openai/gpt-5.2",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5.2",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.75,
      "outputPer1M": 14
    },
    "maxTokens": 400000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5.2-chat": {
    "id": "openrouter/openai/gpt-5.2-chat",
    "openRouterId": "openai/gpt-5.2-chat",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5.2 Chat",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.75,
      "outputPer1M": 14
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5.2-codex": {
    "id": "openrouter/openai/gpt-5.2-codex",
    "openRouterId": "openai/gpt-5.2-codex",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5.2-Codex",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.75,
      "outputPer1M": 14
    },
    "maxTokens": 400000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5.2-pro": {
    "id": "openrouter/openai/gpt-5.2-pro",
    "openRouterId": "openai/gpt-5.2-pro",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5.2 Pro",
    "tier": "premium",
    "costs": {
      "inputPer1M": 21,
      "outputPer1M": 168
    },
    "maxTokens": 400000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5.3-chat": {
    "id": "openrouter/openai/gpt-5.3-chat",
    "openRouterId": "openai/gpt-5.3-chat",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5.3 Chat",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.75,
      "outputPer1M": 14
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5.3-codex": {
    "id": "openrouter/openai/gpt-5.3-codex",
    "openRouterId": "openai/gpt-5.3-codex",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5.3-Codex",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.75,
      "outputPer1M": 14
    },
    "maxTokens": 400000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5.4": {
    "id": "openrouter/openai/gpt-5.4",
    "openRouterId": "openai/gpt-5.4",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5.4",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2.5,
      "outputPer1M": 15
    },
    "maxTokens": 1050000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5.4-mini": {
    "id": "openrouter/openai/gpt-5.4-mini",
    "openRouterId": "openai/gpt-5.4-mini",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5.4 Mini",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.75,
      "outputPer1M": 4.5
    },
    "maxTokens": 400000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5.4-nano": {
    "id": "openrouter/openai/gpt-5.4-nano",
    "openRouterId": "openai/gpt-5.4-nano",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5.4 Nano",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.2,
      "outputPer1M": 1.25
    },
    "maxTokens": 400000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-5.4-pro": {
    "id": "openrouter/openai/gpt-5.4-pro",
    "openRouterId": "openai/gpt-5.4-pro",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT-5.4 Pro",
    "tier": "premium",
    "costs": {
      "inputPer1M": 30,
      "outputPer1M": 180
    },
    "maxTokens": 1050000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-audio": {
    "id": "openrouter/openai/gpt-audio",
    "openRouterId": "openai/gpt-audio",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT Audio",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2.5,
      "outputPer1M": 10
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-audio-mini": {
    "id": "openrouter/openai/gpt-audio-mini",
    "openRouterId": "openai/gpt-audio-mini",
    "provider": "openrouter",
    "displayName": "OpenAI: GPT Audio Mini",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.6,
      "outputPer1M": 2.4
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-oss-120b": {
    "id": "openrouter/openai/gpt-oss-120b",
    "openRouterId": "openai/gpt-oss-120b",
    "provider": "openrouter",
    "displayName": "OpenAI: gpt-oss-120b",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.04,
      "outputPer1M": 0.19
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-oss-20b": {
    "id": "openrouter/openai/gpt-oss-20b",
    "openRouterId": "openai/gpt-oss-20b",
    "provider": "openrouter",
    "displayName": "OpenAI: gpt-oss-20b",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.03,
      "outputPer1M": 0.11
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/gpt-oss-safeguard-20b": {
    "id": "openrouter/openai/gpt-oss-safeguard-20b",
    "openRouterId": "openai/gpt-oss-safeguard-20b",
    "provider": "openrouter",
    "displayName": "OpenAI: gpt-oss-safeguard-20b",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.08,
      "outputPer1M": 0.3
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/o1": {
    "id": "openrouter/openai/o1",
    "openRouterId": "openai/o1",
    "provider": "openrouter",
    "displayName": "OpenAI: o1",
    "tier": "premium",
    "costs": {
      "inputPer1M": 15,
      "outputPer1M": 60
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/o1-pro": {
    "id": "openrouter/openai/o1-pro",
    "openRouterId": "openai/o1-pro",
    "provider": "openrouter",
    "displayName": "OpenAI: o1-pro",
    "tier": "premium",
    "costs": {
      "inputPer1M": 150,
      "outputPer1M": 600
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/o3": {
    "id": "openrouter/openai/o3",
    "openRouterId": "openai/o3",
    "provider": "openrouter",
    "displayName": "OpenAI: o3",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2,
      "outputPer1M": 8
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/o3-deep-research": {
    "id": "openrouter/openai/o3-deep-research",
    "openRouterId": "openai/o3-deep-research",
    "provider": "openrouter",
    "displayName": "OpenAI: o3 Deep Research",
    "tier": "premium",
    "costs": {
      "inputPer1M": 10,
      "outputPer1M": 40
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/o3-mini": {
    "id": "openrouter/openai/o3-mini",
    "openRouterId": "openai/o3-mini",
    "provider": "openrouter",
    "displayName": "OpenAI: o3 Mini",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.1,
      "outputPer1M": 4.4
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/o3-mini-high": {
    "id": "openrouter/openai/o3-mini-high",
    "openRouterId": "openai/o3-mini-high",
    "provider": "openrouter",
    "displayName": "OpenAI: o3 Mini High",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.1,
      "outputPer1M": 4.4
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/o3-pro": {
    "id": "openrouter/openai/o3-pro",
    "openRouterId": "openai/o3-pro",
    "provider": "openrouter",
    "displayName": "OpenAI: o3 Pro",
    "tier": "premium",
    "costs": {
      "inputPer1M": 20,
      "outputPer1M": 80
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/o4-mini": {
    "id": "openrouter/openai/o4-mini",
    "openRouterId": "openai/o4-mini",
    "provider": "openrouter",
    "displayName": "OpenAI: o4 Mini",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.1,
      "outputPer1M": 4.4
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/o4-mini-deep-research": {
    "id": "openrouter/openai/o4-mini-deep-research",
    "openRouterId": "openai/o4-mini-deep-research",
    "provider": "openrouter",
    "displayName": "OpenAI: o4 Mini Deep Research",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2,
      "outputPer1M": 8
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openai/o4-mini-high": {
    "id": "openrouter/openai/o4-mini-high",
    "openRouterId": "openai/o4-mini-high",
    "provider": "openrouter",
    "displayName": "OpenAI: o4 Mini High",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.1,
      "outputPer1M": 4.4
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openrouter/auto": {
    "id": "openrouter/openrouter/auto",
    "openRouterId": "openrouter/auto",
    "provider": "openrouter",
    "displayName": "Auto Router",
    "tier": "fast",
    "costs": {
      "inputPer1M": -1000000,
      "outputPer1M": -1000000
    },
    "maxTokens": 2000000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/openrouter/bodybuilder": {
    "id": "openrouter/openrouter/bodybuilder",
    "openRouterId": "openrouter/bodybuilder",
    "provider": "openrouter",
    "displayName": "Body Builder (beta)",
    "tier": "fast",
    "costs": {
      "inputPer1M": -1000000,
      "outputPer1M": -1000000
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/perplexity/sonar": {
    "id": "openrouter/perplexity/sonar",
    "openRouterId": "perplexity/sonar",
    "provider": "openrouter",
    "displayName": "Perplexity: Sonar",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1,
      "outputPer1M": 1
    },
    "maxTokens": 127072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/perplexity/sonar-deep-research": {
    "id": "openrouter/perplexity/sonar-deep-research",
    "openRouterId": "perplexity/sonar-deep-research",
    "provider": "openrouter",
    "displayName": "Perplexity: Sonar Deep Research",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2,
      "outputPer1M": 8
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/perplexity/sonar-pro": {
    "id": "openrouter/perplexity/sonar-pro",
    "openRouterId": "perplexity/sonar-pro",
    "provider": "openrouter",
    "displayName": "Perplexity: Sonar Pro",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 3,
      "outputPer1M": 15
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/perplexity/sonar-pro-search": {
    "id": "openrouter/perplexity/sonar-pro-search",
    "openRouterId": "perplexity/sonar-pro-search",
    "provider": "openrouter",
    "displayName": "Perplexity: Sonar Pro Search",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 3,
      "outputPer1M": 15
    },
    "maxTokens": 200000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/perplexity/sonar-reasoning-pro": {
    "id": "openrouter/perplexity/sonar-reasoning-pro",
    "openRouterId": "perplexity/sonar-reasoning-pro",
    "provider": "openrouter",
    "displayName": "Perplexity: Sonar Reasoning Pro",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2,
      "outputPer1M": 8
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/prime-intellect/intellect-3": {
    "id": "openrouter/prime-intellect/intellect-3",
    "openRouterId": "prime-intellect/intellect-3",
    "provider": "openrouter",
    "displayName": "Prime Intellect: INTELLECT-3",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.2,
      "outputPer1M": 1.1
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen-2.5-72b-instruct": {
    "id": "openrouter/qwen/qwen-2.5-72b-instruct",
    "openRouterId": "qwen/qwen-2.5-72b-instruct",
    "provider": "openrouter",
    "displayName": "Qwen2.5 72B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.12,
      "outputPer1M": 0.39
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen-2.5-7b-instruct": {
    "id": "openrouter/qwen/qwen-2.5-7b-instruct",
    "openRouterId": "qwen/qwen-2.5-7b-instruct",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen2.5 7B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.04,
      "outputPer1M": 0.1
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen-2.5-coder-32b-instruct": {
    "id": "openrouter/qwen/qwen-2.5-coder-32b-instruct",
    "openRouterId": "qwen/qwen-2.5-coder-32b-instruct",
    "provider": "openrouter",
    "displayName": "Qwen2.5 Coder 32B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.66,
      "outputPer1M": 1
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen-2.5-vl-7b-instruct": {
    "id": "openrouter/qwen/qwen-2.5-vl-7b-instruct",
    "openRouterId": "qwen/qwen-2.5-vl-7b-instruct",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen2.5-VL 7B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.2,
      "outputPer1M": 0.2
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen-max": {
    "id": "openrouter/qwen/qwen-max",
    "openRouterId": "qwen/qwen-max",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen-Max ",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.04,
      "outputPer1M": 4.16
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen-plus": {
    "id": "openrouter/qwen/qwen-plus",
    "openRouterId": "qwen/qwen-plus",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen-Plus",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.26,
      "outputPer1M": 0.78
    },
    "maxTokens": 1000000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen-plus-2025-07-28": {
    "id": "openrouter/qwen/qwen-plus-2025-07-28",
    "openRouterId": "qwen/qwen-plus-2025-07-28",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen Plus 0728",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.26,
      "outputPer1M": 0.78
    },
    "maxTokens": 1000000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen-plus-2025-07-28:thinking": {
    "id": "openrouter/qwen/qwen-plus-2025-07-28:thinking",
    "openRouterId": "qwen/qwen-plus-2025-07-28:thinking",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen Plus 0728 (thinking)",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.26,
      "outputPer1M": 0.78
    },
    "maxTokens": 1000000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen-turbo": {
    "id": "openrouter/qwen/qwen-turbo",
    "openRouterId": "qwen/qwen-turbo",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen-Turbo",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.03,
      "outputPer1M": 0.13
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen-vl-max": {
    "id": "openrouter/qwen/qwen-vl-max",
    "openRouterId": "qwen/qwen-vl-max",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen VL Max",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.52,
      "outputPer1M": 2.08
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen-vl-plus": {
    "id": "openrouter/qwen/qwen-vl-plus",
    "openRouterId": "qwen/qwen-vl-plus",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen VL Plus",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.14,
      "outputPer1M": 0.41
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen2.5-coder-7b-instruct": {
    "id": "openrouter/qwen/qwen2.5-coder-7b-instruct",
    "openRouterId": "qwen/qwen2.5-coder-7b-instruct",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen2.5 Coder 7B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.03,
      "outputPer1M": 0.09
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen2.5-vl-32b-instruct": {
    "id": "openrouter/qwen/qwen2.5-vl-32b-instruct",
    "openRouterId": "qwen/qwen2.5-vl-32b-instruct",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen2.5 VL 32B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.2,
      "outputPer1M": 0.6
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen2.5-vl-72b-instruct": {
    "id": "openrouter/qwen/qwen2.5-vl-72b-instruct",
    "openRouterId": "qwen/qwen2.5-vl-72b-instruct",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen2.5 VL 72B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.8,
      "outputPer1M": 0.8
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-14b": {
    "id": "openrouter/qwen/qwen3-14b",
    "openRouterId": "qwen/qwen3-14b",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 14B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.06,
      "outputPer1M": 0.24
    },
    "maxTokens": 40960,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-235b-a22b": {
    "id": "openrouter/qwen/qwen3-235b-a22b",
    "openRouterId": "qwen/qwen3-235b-a22b",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 235B A22B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.45,
      "outputPer1M": 1.82
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-235b-a22b-2507": {
    "id": "openrouter/qwen/qwen3-235b-a22b-2507",
    "openRouterId": "qwen/qwen3-235b-a22b-2507",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 235B A22B Instruct 2507",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.07,
      "outputPer1M": 0.1
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-235b-a22b-thinking-2507": {
    "id": "openrouter/qwen/qwen3-235b-a22b-thinking-2507",
    "openRouterId": "qwen/qwen3-235b-a22b-thinking-2507",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 235B A22B Thinking 2507",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.15,
      "outputPer1M": 1.5
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-30b-a3b": {
    "id": "openrouter/qwen/qwen3-30b-a3b",
    "openRouterId": "qwen/qwen3-30b-a3b",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 30B A3B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.08,
      "outputPer1M": 0.28
    },
    "maxTokens": 40960,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-30b-a3b-instruct-2507": {
    "id": "openrouter/qwen/qwen3-30b-a3b-instruct-2507",
    "openRouterId": "qwen/qwen3-30b-a3b-instruct-2507",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 30B A3B Instruct 2507",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.09,
      "outputPer1M": 0.3
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-30b-a3b-thinking-2507": {
    "id": "openrouter/qwen/qwen3-30b-a3b-thinking-2507",
    "openRouterId": "qwen/qwen3-30b-a3b-thinking-2507",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 30B A3B Thinking 2507",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.08,
      "outputPer1M": 0.4
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-32b": {
    "id": "openrouter/qwen/qwen3-32b",
    "openRouterId": "qwen/qwen3-32b",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 32B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.08,
      "outputPer1M": 0.24
    },
    "maxTokens": 40960,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-8b": {
    "id": "openrouter/qwen/qwen3-8b",
    "openRouterId": "qwen/qwen3-8b",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 8B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.05,
      "outputPer1M": 0.4
    },
    "maxTokens": 40960,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-coder": {
    "id": "openrouter/qwen/qwen3-coder",
    "openRouterId": "qwen/qwen3-coder",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 Coder 480B A35B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.22,
      "outputPer1M": 1
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-coder-30b-a3b-instruct": {
    "id": "openrouter/qwen/qwen3-coder-30b-a3b-instruct",
    "openRouterId": "qwen/qwen3-coder-30b-a3b-instruct",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 Coder 30B A3B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.07,
      "outputPer1M": 0.27
    },
    "maxTokens": 160000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-coder-flash": {
    "id": "openrouter/qwen/qwen3-coder-flash",
    "openRouterId": "qwen/qwen3-coder-flash",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 Coder Flash",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.2,
      "outputPer1M": 0.98
    },
    "maxTokens": 1000000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-coder-next": {
    "id": "openrouter/qwen/qwen3-coder-next",
    "openRouterId": "qwen/qwen3-coder-next",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 Coder Next",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.12,
      "outputPer1M": 0.75
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-coder-plus": {
    "id": "openrouter/qwen/qwen3-coder-plus",
    "openRouterId": "qwen/qwen3-coder-plus",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 Coder Plus",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.65,
      "outputPer1M": 3.25
    },
    "maxTokens": 1000000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-max": {
    "id": "openrouter/qwen/qwen3-max",
    "openRouterId": "qwen/qwen3-max",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 Max",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.78,
      "outputPer1M": 3.9
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-max-thinking": {
    "id": "openrouter/qwen/qwen3-max-thinking",
    "openRouterId": "qwen/qwen3-max-thinking",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 Max Thinking",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.78,
      "outputPer1M": 3.9
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-next-80b-a3b-instruct": {
    "id": "openrouter/qwen/qwen3-next-80b-a3b-instruct",
    "openRouterId": "qwen/qwen3-next-80b-a3b-instruct",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 Next 80B A3B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.09,
      "outputPer1M": 1.1
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-next-80b-a3b-thinking": {
    "id": "openrouter/qwen/qwen3-next-80b-a3b-thinking",
    "openRouterId": "qwen/qwen3-next-80b-a3b-thinking",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 Next 80B A3B Thinking",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.1,
      "outputPer1M": 0.78
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-vl-235b-a22b-instruct": {
    "id": "openrouter/qwen/qwen3-vl-235b-a22b-instruct",
    "openRouterId": "qwen/qwen3-vl-235b-a22b-instruct",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 VL 235B A22B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.2,
      "outputPer1M": 0.88
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-vl-235b-a22b-thinking": {
    "id": "openrouter/qwen/qwen3-vl-235b-a22b-thinking",
    "openRouterId": "qwen/qwen3-vl-235b-a22b-thinking",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 VL 235B A22B Thinking",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.26,
      "outputPer1M": 2.6
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-vl-30b-a3b-instruct": {
    "id": "openrouter/qwen/qwen3-vl-30b-a3b-instruct",
    "openRouterId": "qwen/qwen3-vl-30b-a3b-instruct",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 VL 30B A3B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.13,
      "outputPer1M": 0.52
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-vl-30b-a3b-thinking": {
    "id": "openrouter/qwen/qwen3-vl-30b-a3b-thinking",
    "openRouterId": "qwen/qwen3-vl-30b-a3b-thinking",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 VL 30B A3B Thinking",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.13,
      "outputPer1M": 1.56
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-vl-32b-instruct": {
    "id": "openrouter/qwen/qwen3-vl-32b-instruct",
    "openRouterId": "qwen/qwen3-vl-32b-instruct",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 VL 32B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.1,
      "outputPer1M": 0.42
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-vl-8b-instruct": {
    "id": "openrouter/qwen/qwen3-vl-8b-instruct",
    "openRouterId": "qwen/qwen3-vl-8b-instruct",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 VL 8B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.08,
      "outputPer1M": 0.5
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3-vl-8b-thinking": {
    "id": "openrouter/qwen/qwen3-vl-8b-thinking",
    "openRouterId": "qwen/qwen3-vl-8b-thinking",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3 VL 8B Thinking",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.12,
      "outputPer1M": 1.37
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3.5-122b-a10b": {
    "id": "openrouter/qwen/qwen3.5-122b-a10b",
    "openRouterId": "qwen/qwen3.5-122b-a10b",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3.5-122B-A10B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.26,
      "outputPer1M": 2.08
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3.5-27b": {
    "id": "openrouter/qwen/qwen3.5-27b",
    "openRouterId": "qwen/qwen3.5-27b",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3.5-27B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.2,
      "outputPer1M": 1.56
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3.5-35b-a3b": {
    "id": "openrouter/qwen/qwen3.5-35b-a3b",
    "openRouterId": "qwen/qwen3.5-35b-a3b",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3.5-35B-A3B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.16,
      "outputPer1M": 1.3
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3.5-397b-a17b": {
    "id": "openrouter/qwen/qwen3.5-397b-a17b",
    "openRouterId": "qwen/qwen3.5-397b-a17b",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3.5 397B A17B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.39,
      "outputPer1M": 2.34
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3.5-9b": {
    "id": "openrouter/qwen/qwen3.5-9b",
    "openRouterId": "qwen/qwen3.5-9b",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3.5-9B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.05,
      "outputPer1M": 0.15
    },
    "maxTokens": 256000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3.5-flash-02-23": {
    "id": "openrouter/qwen/qwen3.5-flash-02-23",
    "openRouterId": "qwen/qwen3.5-flash-02-23",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3.5-Flash",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.07,
      "outputPer1M": 0.26
    },
    "maxTokens": 1000000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwen3.5-plus-02-15": {
    "id": "openrouter/qwen/qwen3.5-plus-02-15",
    "openRouterId": "qwen/qwen3.5-plus-02-15",
    "provider": "openrouter",
    "displayName": "Qwen: Qwen3.5 Plus 2026-02-15",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.26,
      "outputPer1M": 1.56
    },
    "maxTokens": 1000000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/qwen/qwq-32b": {
    "id": "openrouter/qwen/qwq-32b",
    "openRouterId": "qwen/qwq-32b",
    "provider": "openrouter",
    "displayName": "Qwen: QwQ 32B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.15,
      "outputPer1M": 0.58
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/relace/relace-apply-3": {
    "id": "openrouter/relace/relace-apply-3",
    "openRouterId": "relace/relace-apply-3",
    "provider": "openrouter",
    "displayName": "Relace: Relace Apply 3",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.85,
      "outputPer1M": 1.25
    },
    "maxTokens": 256000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/relace/relace-search": {
    "id": "openrouter/relace/relace-search",
    "openRouterId": "relace/relace-search",
    "provider": "openrouter",
    "displayName": "Relace: Relace Search",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1,
      "outputPer1M": 3
    },
    "maxTokens": 256000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/sao10k/l3-euryale-70b": {
    "id": "openrouter/sao10k/l3-euryale-70b",
    "openRouterId": "sao10k/l3-euryale-70b",
    "provider": "openrouter",
    "displayName": "Sao10k: Llama 3 Euryale 70B v2.1",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1.48,
      "outputPer1M": 1.48
    },
    "maxTokens": 8192,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/sao10k/l3-lunaris-8b": {
    "id": "openrouter/sao10k/l3-lunaris-8b",
    "openRouterId": "sao10k/l3-lunaris-8b",
    "provider": "openrouter",
    "displayName": "Sao10K: Llama 3 8B Lunaris",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.04,
      "outputPer1M": 0.05
    },
    "maxTokens": 8192,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/sao10k/l3.1-70b-hanami-x1": {
    "id": "openrouter/sao10k/l3.1-70b-hanami-x1",
    "openRouterId": "sao10k/l3.1-70b-hanami-x1",
    "provider": "openrouter",
    "displayName": "Sao10K: Llama 3.1 70B Hanami x1",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 3,
      "outputPer1M": 3
    },
    "maxTokens": 16000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/sao10k/l3.1-euryale-70b": {
    "id": "openrouter/sao10k/l3.1-euryale-70b",
    "openRouterId": "sao10k/l3.1-euryale-70b",
    "provider": "openrouter",
    "displayName": "Sao10K: Llama 3.1 Euryale 70B v2.2",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.85,
      "outputPer1M": 0.85
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/sao10k/l3.3-euryale-70b": {
    "id": "openrouter/sao10k/l3.3-euryale-70b",
    "openRouterId": "sao10k/l3.3-euryale-70b",
    "provider": "openrouter",
    "displayName": "Sao10K: Llama 3.3 Euryale 70B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.65,
      "outputPer1M": 0.75
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/stepfun/step-3.5-flash": {
    "id": "openrouter/stepfun/step-3.5-flash",
    "openRouterId": "stepfun/step-3.5-flash",
    "provider": "openrouter",
    "displayName": "StepFun: Step 3.5 Flash",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.1,
      "outputPer1M": 0.3
    },
    "maxTokens": 256000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/switchpoint/router": {
    "id": "openrouter/switchpoint/router",
    "openRouterId": "switchpoint/router",
    "provider": "openrouter",
    "displayName": "Switchpoint Router",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.85,
      "outputPer1M": 3.4
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/tencent/hunyuan-a13b-instruct": {
    "id": "openrouter/tencent/hunyuan-a13b-instruct",
    "openRouterId": "tencent/hunyuan-a13b-instruct",
    "provider": "openrouter",
    "displayName": "Tencent: Hunyuan A13B Instruct",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.14,
      "outputPer1M": 0.57
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/thedrummer/cydonia-24b-v4.1": {
    "id": "openrouter/thedrummer/cydonia-24b-v4.1",
    "openRouterId": "thedrummer/cydonia-24b-v4.1",
    "provider": "openrouter",
    "displayName": "TheDrummer: Cydonia 24B V4.1",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.3,
      "outputPer1M": 0.5
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/thedrummer/rocinante-12b": {
    "id": "openrouter/thedrummer/rocinante-12b",
    "openRouterId": "thedrummer/rocinante-12b",
    "provider": "openrouter",
    "displayName": "TheDrummer: Rocinante 12B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.17,
      "outputPer1M": 0.43
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/thedrummer/skyfall-36b-v2": {
    "id": "openrouter/thedrummer/skyfall-36b-v2",
    "openRouterId": "thedrummer/skyfall-36b-v2",
    "provider": "openrouter",
    "displayName": "TheDrummer: Skyfall 36B V2",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.55,
      "outputPer1M": 0.8
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/thedrummer/unslopnemo-12b": {
    "id": "openrouter/thedrummer/unslopnemo-12b",
    "openRouterId": "thedrummer/unslopnemo-12b",
    "provider": "openrouter",
    "displayName": "TheDrummer: UnslopNemo 12B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.4,
      "outputPer1M": 0.4
    },
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/tngtech/deepseek-r1t2-chimera": {
    "id": "openrouter/tngtech/deepseek-r1t2-chimera",
    "openRouterId": "tngtech/deepseek-r1t2-chimera",
    "provider": "openrouter",
    "displayName": "TNG: DeepSeek R1T2 Chimera",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.3,
      "outputPer1M": 1.1
    },
    "maxTokens": 163840,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/undi95/remm-slerp-l2-13b": {
    "id": "openrouter/undi95/remm-slerp-l2-13b",
    "openRouterId": "undi95/remm-slerp-l2-13b",
    "provider": "openrouter",
    "displayName": "ReMM SLERP 13B",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.45,
      "outputPer1M": 0.65
    },
    "maxTokens": 6144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/upstage/solar-pro-3": {
    "id": "openrouter/upstage/solar-pro-3",
    "openRouterId": "upstage/solar-pro-3",
    "provider": "openrouter",
    "displayName": "Upstage: Solar Pro 3",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.15,
      "outputPer1M": 0.6
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/writer/palmyra-x5": {
    "id": "openrouter/writer/palmyra-x5",
    "openRouterId": "writer/palmyra-x5",
    "provider": "openrouter",
    "displayName": "Writer: Palmyra X5",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.6,
      "outputPer1M": 6
    },
    "maxTokens": 1040000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/x-ai/grok-3": {
    "id": "openrouter/x-ai/grok-3",
    "openRouterId": "x-ai/grok-3",
    "provider": "openrouter",
    "displayName": "xAI: Grok 3",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 3,
      "outputPer1M": 15
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/x-ai/grok-3-beta": {
    "id": "openrouter/x-ai/grok-3-beta",
    "openRouterId": "x-ai/grok-3-beta",
    "provider": "openrouter",
    "displayName": "xAI: Grok 3 Beta",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 3,
      "outputPer1M": 15
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/x-ai/grok-3-mini": {
    "id": "openrouter/x-ai/grok-3-mini",
    "openRouterId": "x-ai/grok-3-mini",
    "provider": "openrouter",
    "displayName": "xAI: Grok 3 Mini",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.3,
      "outputPer1M": 0.5
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/x-ai/grok-3-mini-beta": {
    "id": "openrouter/x-ai/grok-3-mini-beta",
    "openRouterId": "x-ai/grok-3-mini-beta",
    "provider": "openrouter",
    "displayName": "xAI: Grok 3 Mini Beta",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.3,
      "outputPer1M": 0.5
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/x-ai/grok-4": {
    "id": "openrouter/x-ai/grok-4",
    "openRouterId": "x-ai/grok-4",
    "provider": "openrouter",
    "displayName": "xAI: Grok 4",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 3,
      "outputPer1M": 15
    },
    "maxTokens": 256000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/x-ai/grok-4-fast": {
    "id": "openrouter/x-ai/grok-4-fast",
    "openRouterId": "x-ai/grok-4-fast",
    "provider": "openrouter",
    "displayName": "xAI: Grok 4 Fast",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.2,
      "outputPer1M": 0.5
    },
    "maxTokens": 2000000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/x-ai/grok-4.1-fast": {
    "id": "openrouter/x-ai/grok-4.1-fast",
    "openRouterId": "x-ai/grok-4.1-fast",
    "provider": "openrouter",
    "displayName": "xAI: Grok 4.1 Fast",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.2,
      "outputPer1M": 0.5
    },
    "maxTokens": 2000000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/x-ai/grok-4.20-beta": {
    "id": "openrouter/x-ai/grok-4.20-beta",
    "openRouterId": "x-ai/grok-4.20-beta",
    "provider": "openrouter",
    "displayName": "xAI: Grok 4.20 Beta",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2,
      "outputPer1M": 6
    },
    "maxTokens": 2000000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/x-ai/grok-4.20-multi-agent-beta": {
    "id": "openrouter/x-ai/grok-4.20-multi-agent-beta",
    "openRouterId": "x-ai/grok-4.20-multi-agent-beta",
    "provider": "openrouter",
    "displayName": "xAI: Grok 4.20 Multi-Agent Beta",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 2,
      "outputPer1M": 6
    },
    "maxTokens": 2000000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/x-ai/grok-code-fast-1": {
    "id": "openrouter/x-ai/grok-code-fast-1",
    "openRouterId": "x-ai/grok-code-fast-1",
    "provider": "openrouter",
    "displayName": "xAI: Grok Code Fast 1",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.2,
      "outputPer1M": 1.5
    },
    "maxTokens": 256000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/xiaomi/mimo-v2-flash": {
    "id": "openrouter/xiaomi/mimo-v2-flash",
    "openRouterId": "xiaomi/mimo-v2-flash",
    "provider": "openrouter",
    "displayName": "Xiaomi: MiMo-V2-Flash",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.09,
      "outputPer1M": 0.29
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/xiaomi/mimo-v2-omni": {
    "id": "openrouter/xiaomi/mimo-v2-omni",
    "openRouterId": "xiaomi/mimo-v2-omni",
    "provider": "openrouter",
    "displayName": "Xiaomi: MiMo-V2-Omni",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.4,
      "outputPer1M": 2
    },
    "maxTokens": 262144,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/xiaomi/mimo-v2-pro": {
    "id": "openrouter/xiaomi/mimo-v2-pro",
    "openRouterId": "xiaomi/mimo-v2-pro",
    "provider": "openrouter",
    "displayName": "Xiaomi: MiMo-V2-Pro",
    "tier": "balanced",
    "costs": {
      "inputPer1M": 1,
      "outputPer1M": 3
    },
    "maxTokens": 1048576,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/z-ai/glm-4-32b": {
    "id": "openrouter/z-ai/glm-4-32b",
    "openRouterId": "z-ai/glm-4-32b",
    "provider": "openrouter",
    "displayName": "Z.ai: GLM 4 32B ",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.1,
      "outputPer1M": 0.1
    },
    "maxTokens": 128000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/z-ai/glm-4.5": {
    "id": "openrouter/z-ai/glm-4.5",
    "openRouterId": "z-ai/glm-4.5",
    "provider": "openrouter",
    "displayName": "Z.ai: GLM 4.5",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.6,
      "outputPer1M": 2.2
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/z-ai/glm-4.5-air": {
    "id": "openrouter/z-ai/glm-4.5-air",
    "openRouterId": "z-ai/glm-4.5-air",
    "provider": "openrouter",
    "displayName": "Z.ai: GLM 4.5 Air",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.13,
      "outputPer1M": 0.85
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/z-ai/glm-4.5v": {
    "id": "openrouter/z-ai/glm-4.5v",
    "openRouterId": "z-ai/glm-4.5v",
    "provider": "openrouter",
    "displayName": "Z.ai: GLM 4.5V",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.6,
      "outputPer1M": 1.8
    },
    "maxTokens": 65536,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/z-ai/glm-4.6": {
    "id": "openrouter/z-ai/glm-4.6",
    "openRouterId": "z-ai/glm-4.6",
    "provider": "openrouter",
    "displayName": "Z.ai: GLM 4.6",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.39,
      "outputPer1M": 1.9
    },
    "maxTokens": 204800,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/z-ai/glm-4.6v": {
    "id": "openrouter/z-ai/glm-4.6v",
    "openRouterId": "z-ai/glm-4.6v",
    "provider": "openrouter",
    "displayName": "Z.ai: GLM 4.6V",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.3,
      "outputPer1M": 0.9
    },
    "maxTokens": 131072,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/z-ai/glm-4.7": {
    "id": "openrouter/z-ai/glm-4.7",
    "openRouterId": "z-ai/glm-4.7",
    "provider": "openrouter",
    "displayName": "Z.ai: GLM 4.7",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.39,
      "outputPer1M": 1.75
    },
    "maxTokens": 202752,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/z-ai/glm-4.7-flash": {
    "id": "openrouter/z-ai/glm-4.7-flash",
    "openRouterId": "z-ai/glm-4.7-flash",
    "provider": "openrouter",
    "displayName": "Z.ai: GLM 4.7 Flash",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.06,
      "outputPer1M": 0.4
    },
    "maxTokens": 202752,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/z-ai/glm-5": {
    "id": "openrouter/z-ai/glm-5",
    "openRouterId": "z-ai/glm-5",
    "provider": "openrouter",
    "displayName": "Z.ai: GLM 5",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.72,
      "outputPer1M": 2.3
    },
    "maxTokens": 80000,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  },
  "openrouter/z-ai/glm-5-turbo": {
    "id": "openrouter/z-ai/glm-5-turbo",
    "openRouterId": "z-ai/glm-5-turbo",
    "provider": "openrouter",
    "displayName": "Z.ai: GLM 5 Turbo",
    "tier": "fast",
    "costs": {
      "inputPer1M": 0.96,
      "outputPer1M": 3.2
    },
    "maxTokens": 202752,
    "supportsTools": true,
    "supportsCaching": false,
    "supportsThinking": false
  }
};

/** All OpenRouter model IDs */
export const OPENROUTER_MODEL_IDS: string[] = Object.keys(OPENROUTER_MODEL_REGISTRY);

/** Check if a model ID is a valid OpenRouter model */
export function isOpenRouterModel(id: string): boolean {
  return id.startsWith("openrouter/") && id in OPENROUTER_MODEL_REGISTRY;
}
