import { Card, Stack, Row, Text, Button, Divider } from '@ggui-ai/design/primitives';

interface PlanFeature {
  text: string;
  included: boolean;
}

interface Plan {
  id?: string;
  name: string;
  price: string | number;
  period?: string;
  description?: string;
  features: PlanFeature[];
  ctaLabel?: string;
  recommended?: boolean;
}

interface PricingCardsProps {
  plans: Plan[];
  title?: string;
  subtitle?: string;
  onSelectPlan?: (plan: Plan) => void;
}

function PlanCard({
  plan,
  onSelect,
}: {
  plan: Plan;
  onSelect?: (plan: Plan) => void;
}) {
  const isRecommended = plan.recommended ?? false;

  return (
    <Card
      padding="none"
      style={{
        flex: 1,
        minWidth: 240,
        maxWidth: 340,
        display: 'flex',
        flexDirection: 'column',
        border: isRecommended
          ? '2px solid var(--ggui-color-primary-500, #3b82f6)'
          : '1px solid var(--ggui-color-neutral-200, #e5e5e5)',
        borderRadius: 12,
        overflow: 'hidden',
        position: 'relative',
        boxShadow: isRecommended
          ? '0 4px 6px -1px rgba(59, 130, 246, 0.1), 0 2px 4px -2px rgba(59, 130, 246, 0.1)'
          : undefined,
      }}
    >
      {/* Recommended badge */}
      {isRecommended && (
        <div
          style={{
            backgroundColor: 'var(--ggui-color-primary-500, #3b82f6)',
            color: '#ffffff',
            textAlign: 'center',
            padding: '6px 0',
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
          }}
        >
          Recommended
        </div>
      )}

      {/* Plan details */}
      <Stack gap="lg" style={{ padding: 24, flex: 1 }}>
        <Stack gap="sm">
          <Text
            variant="h3"
            style={{
              fontWeight: 600,
              color: 'var(--ggui-color-neutral-800, #262626)',
            }}
          >
            {plan.name}
          </Text>
          {plan.description && (
            <Text
              variant="small"
              style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}
            >
              {plan.description}
            </Text>
          )}
        </Stack>

        {/* Price */}
        <Row align="baseline" gap="xs">
          <Text
            variant="h1"
            style={{
              fontSize: 40,
              fontWeight: 700,
              color: 'var(--ggui-color-neutral-900, #171717)',
              lineHeight: 1,
            }}
          >
            {typeof plan.price === 'number' ? `$${plan.price}` : plan.price}
          </Text>
          {plan.period && (
            <Text
              variant="body"
              style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}
            >
              /{plan.period}
            </Text>
          )}
        </Row>

        <Divider />

        {/* Features */}
        <Stack gap="sm" style={{ flex: 1 }}>
          {plan.features.map((feature, index) => (
            <Row key={index} gap="sm" align="start">
              <span
                style={{
                  color: feature.included
                    ? 'var(--ggui-color-success-500, #22c55e)'
                    : 'var(--ggui-color-neutral-300, #d4d4d4)',
                  fontSize: 16,
                  lineHeight: 1.5,
                  flexShrink: 0,
                }}
              >
                {feature.included ? '\u2713' : '\u2717'}
              </span>
              <Text
                variant="body"
                style={{
                  color: feature.included
                    ? 'var(--ggui-color-neutral-700, #404040)'
                    : 'var(--ggui-color-neutral-400, #a3a3a3)',
                  fontSize: 14,
                }}
              >
                {feature.text}
              </Text>
            </Row>
          ))}
        </Stack>

        {/* CTA */}
        <Button
          variant={isRecommended ? 'primary' : 'secondary'}
          onPress={() => onSelect?.(plan)}
          style={{ width: '100%', marginTop: 8 }}
        >
          {plan.ctaLabel ?? (isRecommended ? 'Get Started' : 'Choose Plan')}
        </Button>
      </Stack>
    </Card>
  );
}

export default function PricingCards({
  plans,
  title,
  subtitle,
  onSelectPlan,
}: PricingCardsProps) {
  return (
    <Stack gap="lg" style={{ alignItems: 'center', padding: '32px 16px' }}>
      {(title || subtitle) && (
        <Stack gap="sm" style={{ textAlign: 'center', maxWidth: 600 }}>
          {title && (
            <Text
              variant="h1"
              style={{ color: 'var(--ggui-color-neutral-900, #171717)' }}
            >
              {title}
            </Text>
          )}
          {subtitle && (
            <Text
              variant="body"
              style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}
            >
              {subtitle}
            </Text>
          )}
        </Stack>
      )}

      <div
        style={{
          display: 'flex',
          gap: 24,
          flexWrap: 'wrap',
          justifyContent: 'center',
          alignItems: 'stretch',
          width: '100%',
          maxWidth: 1100,
        }}
      >
        {plans.map((plan, index) => (
          <PlanCard
            key={plan.id ?? index}
            plan={plan}
            onSelect={onSelectPlan}
          />
        ))}
      </div>
    </Stack>
  );
}
