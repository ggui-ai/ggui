import { Card, Stack, Row, Text, Badge } from '@ggui-ai/design/primitives';

interface Feature {
  icon: string;
  label: string;
}

interface AgentNameCardCompositeProps {
  name?: string;
  tagline?: string;
  description?: string;
  capabilities?: string[];
  features?: Feature[];
}

const defaultCapabilities = ['MCP', 'Real-time UI', 'Blueprints', 'Bedrock'];

const defaultFeatures: Feature[] = [
  { icon: '\u26A1', label: 'Generate UIs from natural language in real-time' },
  { icon: '\uD83C\uDFA8', label: 'Blueprint-first architecture for sub-500ms responses' },
  { icon: '\uD83D\uDD17', label: 'Native MCP integration for any AI agent' },
  { icon: '\uD83D\uDCF1', label: 'Multi-platform: React, React Native, Web' },
];

export default function AgentNameCardComposite({
  name = 'Sample Agent',
  tagline = 'AI-Powered UI Generation',
  description = 'I create rich, interactive user interfaces on demand. Describe what you need in natural language and I\'ll generate production-quality React components in real-time.',
  capabilities = defaultCapabilities,
  features = defaultFeatures,
}: AgentNameCardCompositeProps) {
  return (
    <Card
      padding="none"
      style={{
        maxWidth: 420,
        margin: '0 auto',
        borderRadius: 16,
        overflow: 'hidden',
        border: '1px solid var(--ggui-color-neutral-200, #e5e5e5)',
        boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)',
      }}
    >
      {/* Header gradient */}
      <div
        style={{
          height: 80,
          background: 'linear-gradient(135deg, var(--ggui-color-primary-600, #0284c7) 0%, #8b5cf6 50%, #ec4899 100%)',
          position: 'relative',
        }}
      >
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 20,
            background: 'linear-gradient(transparent, rgba(255,255,255,0.1))',
          }}
        />
      </div>

      {/* Agent icon */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          marginTop: -32,
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 16,
            background: 'linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%)',
            border: '3px solid #ffffff',
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 28,
          }}
        >
          {'\uD83E\uDD16'}
        </div>
      </div>

      {/* Name and tagline */}
      <Stack gap="xs" style={{ padding: '12px 24px 0', alignItems: 'center', textAlign: 'center' }}>
        <Text
          variant="h2"
          style={{
            fontWeight: 700,
            color: 'var(--ggui-color-neutral-900, #171717)',
            margin: 0,
            fontSize: 20,
          }}
        >
          {name}
        </Text>
        <Text
          variant="small"
          style={{
            color: 'var(--ggui-color-primary-600, #0284c7)',
            fontWeight: 600,
            letterSpacing: '0.02em',
          }}
        >
          {tagline}
        </Text>
      </Stack>

      {/* Description */}
      {description && (
        <div style={{ padding: '12px 24px 0' }}>
          <Text
            variant="body"
            style={{
              color: 'var(--ggui-color-neutral-600, #525252)',
              lineHeight: 1.6,
              textAlign: 'center',
              fontSize: 13,
            }}
          >
            {description}
          </Text>
        </div>
      )}

      {/* Capability badges */}
      <div style={{ padding: '16px 24px 0' }}>
        <Row gap="xs" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
          {capabilities.map((cap) => (
            <Badge key={cap} variant="info" size="sm">
              {cap}
            </Badge>
          ))}
        </Row>
      </div>

      {/* Features list */}
      <Stack gap="xs" style={{ padding: '16px 24px 20px' }}>
        {features.map((feature, i) => (
          <Row
            key={i}
            gap="sm"
            align="center"
            style={{
              padding: '6px 12px',
              borderRadius: 8,
              backgroundColor: 'var(--ggui-color-neutral-50, #fafafa)',
            }}
          >
            <span style={{ fontSize: 14, flexShrink: 0 }}>{feature.icon}</span>
            <Text
              variant="small"
              style={{
                color: 'var(--ggui-color-neutral-700, #404040)',
                fontSize: 12,
              }}
            >
              {feature.label}
            </Text>
          </Row>
        ))}
      </Stack>

      {/* Footer branding */}
      <div
        style={{
          padding: '10px 24px',
          borderTop: '1px solid var(--ggui-color-neutral-100, #f5f5f5)',
          textAlign: 'center',
        }}
      >
        <Text
          variant="small"
          style={{
            color: 'var(--ggui-color-neutral-400, #a3a3a3)',
            fontSize: 10,
            letterSpacing: '0.05em',
          }}
        >
          POWERED BY GGUI
        </Text>
      </div>
    </Card>
  );
}
