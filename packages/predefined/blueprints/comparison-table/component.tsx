import { Container, Card, Stack, Row, Text, Button } from '@ggui-ai/design/primitives';

interface Feature {
  key: string;
  label: string;
  category?: string;
}

interface ComparisonOption {
  name: string;
  price?: string;
  description?: string;
  recommended?: boolean;
  features: Record<string, boolean | string>;
}

const defaultFeatures: Feature[] = [
  { key: 'sessions', label: 'Monthly sessions', category: 'Usage' },
  { key: 'agents', label: 'Connected agents', category: 'Usage' },
  { key: 'blueprints', label: 'Custom blueprints', category: 'Features' },
  { key: 'analytics', label: 'Analytics dashboard', category: 'Features' },
  { key: 'priority', label: 'Priority support', category: 'Support' },
  { key: 'sla', label: 'SLA guarantee', category: 'Support' },
  { key: 'sso', label: 'SSO / SAML', category: 'Security' },
  { key: 'audit', label: 'Audit logs', category: 'Security' },
];

const defaultOptions: ComparisonOption[] = [
  {
    name: 'Free',
    price: '$0/mo',
    description: 'For hobbyists',
    features: { sessions: '100', agents: '1', blueprints: false, analytics: false, priority: false, sla: false, sso: false, audit: false },
  },
  {
    name: 'Pro',
    price: '$29/mo',
    description: 'For small teams',
    recommended: true,
    features: { sessions: '10,000', agents: '5', blueprints: true, analytics: true, priority: false, sla: false, sso: false, audit: true },
  },
  {
    name: 'Business',
    price: '$99/mo',
    description: 'For growing teams',
    features: { sessions: '100,000', agents: '25', blueprints: true, analytics: true, priority: true, sla: '99.9%', sso: true, audit: true },
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    description: 'For large orgs',
    features: { sessions: 'Unlimited', agents: 'Unlimited', blueprints: true, analytics: true, priority: true, sla: '99.99%', sso: true, audit: true },
  },
];

interface ComparisonTableProps {
  options?: ComparisonOption[];
  features?: Feature[];
  title?: string;
  onSelect?: (option: ComparisonOption) => void;
}

export default function ComparisonTable({
  options = defaultOptions,
  features = defaultFeatures,
  title = 'Compare Options',
  onSelect,
}: ComparisonTableProps) {
  const categories = [...new Set(features.map((f) => f.category).filter(Boolean))];

  const renderValue = (value: boolean | string | undefined) => {
    if (value === true) {
      return (
        <span style={{ color: 'var(--ggui-color-success-500, #22c55e)', fontSize: 18 }}>{'\u2713'}</span>
      );
    }
    if (value === false || value === undefined) {
      return (
        <span style={{ color: 'var(--ggui-color-neutral-300, #d4d4d4)', fontSize: 18 }}>{'\u2014'}</span>
      );
    }
    return <Text variant="body" style={{ fontWeight: 500 }}>{value}</Text>;
  };

  return (
    <Container style={{ maxWidth: 900, margin: '0 auto' }}>
      <Stack gap="md">
        <Text variant="h2" style={{ textAlign: 'center' }}>{title}</Text>

        <Card padding="none" style={{ overflow: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              textAlign: 'center',
            }}
          >
            {/* Header */}
            <thead>
              <tr>
                <th style={{ padding: '16px 20px', textAlign: 'left', width: 200 }} />
                {options.map((opt) => (
                  <th
                    key={opt.name}
                    style={{
                      padding: '20px 16px',
                      borderBottom: opt.recommended
                        ? '3px solid var(--ggui-color-primary-600, #0284c7)'
                        : '1px solid var(--ggui-color-neutral-200, #e5e5e5)',
                      backgroundColor: opt.recommended
                        ? 'var(--ggui-color-primary-50, #f0f9ff)'
                        : 'transparent',
                    }}
                  >
                    <Stack gap="xs" align="center">
                      {opt.recommended && (
                        <Text
                          variant="small"
                          style={{
                            color: 'var(--ggui-color-primary-600, #0284c7)',
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            letterSpacing: 1,
                          }}
                        >
                          Recommended
                        </Text>
                      )}
                      <Text variant="h3" style={{ margin: 0 }}>{opt.name}</Text>
                      {opt.price && (
                        <Text variant="body" style={{ fontWeight: 700, color: 'var(--ggui-color-neutral-800, #262626)' }}>
                          {opt.price}
                        </Text>
                      )}
                      {opt.description && (
                        <Text variant="small" style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}>
                          {opt.description}
                        </Text>
                      )}
                    </Stack>
                  </th>
                ))}
              </tr>
            </thead>

            {/* Feature rows grouped by category */}
            <tbody>
              {categories.map((category) => {
                const categoryFeatures = features.filter((f) => f.category === category);
                return [
                  <tr key={`cat-${category}`}>
                    <td
                      colSpan={options.length + 1}
                      style={{
                        padding: '12px 20px',
                        fontWeight: 700,
                        fontSize: 13,
                        textTransform: 'uppercase',
                        letterSpacing: 1,
                        color: 'var(--ggui-color-neutral-500, #737373)',
                        backgroundColor: 'var(--ggui-color-neutral-50, #fafafa)',
                        textAlign: 'left',
                      }}
                    >
                      {category}
                    </td>
                  </tr>,
                  ...categoryFeatures.map((feature) => (
                    <tr
                      key={feature.key}
                      style={{
                        borderBottom: '1px solid var(--ggui-color-neutral-100, #f5f5f5)',
                      }}
                    >
                      <td
                        style={{
                          padding: '12px 20px',
                          textAlign: 'left',
                          color: 'var(--ggui-color-neutral-700, #404040)',
                        }}
                      >
                        {feature.label}
                      </td>
                      {options.map((opt) => (
                        <td
                          key={`${feature.key}-${opt.name}`}
                          style={{
                            padding: '12px 16px',
                            backgroundColor: opt.recommended
                              ? 'var(--ggui-color-primary-50, #f0f9ff)'
                              : 'transparent',
                          }}
                        >
                          {renderValue(opt.features[feature.key])}
                        </td>
                      ))}
                    </tr>
                  )),
                ];
              })}
            </tbody>

            {/* CTA row */}
            {onSelect && (
              <tfoot>
                <tr>
                  <td style={{ padding: 16 }} />
                  {options.map((opt) => (
                    <td
                      key={`cta-${opt.name}`}
                      style={{
                        padding: 16,
                        backgroundColor: opt.recommended
                          ? 'var(--ggui-color-primary-50, #f0f9ff)'
                          : 'transparent',
                      }}
                    >
                      <Button
                        variant={opt.recommended ? 'primary' : 'outline'}
                        size="sm"
                        onPress={() => onSelect(opt)}
                      >
                        Choose {opt.name}
                      </Button>
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </Card>
      </Stack>
    </Container>
  );
}
