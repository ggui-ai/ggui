import { useState, type ReactNode } from 'react';
import { Container, Card, Stack, Row, Text, Button, Input } from '@ggui-ai/design/primitives';

interface OnboardingStep {
  title: string;
  description: string;
  content?: ReactNode;
}

const defaultSteps: OnboardingStep[] = [
  {
    title: 'Welcome',
    description: 'Let\'s get you set up. This will only take a few minutes.',
  },
  {
    title: 'Create Your App',
    description: 'Give your app a name and description so agents can connect to it.',
  },
  {
    title: 'Connect an Agent',
    description: 'Add your first AI agent by configuring MCP connection settings.',
  },
  {
    title: 'Generate Your First UI',
    description: 'Try generating a UI component by sending a natural language prompt.',
  },
  {
    title: 'All Set!',
    description: 'You\'re ready to go. Your agent can now create rich UIs on demand.',
  },
];

interface OnboardingFlowProps {
  steps?: OnboardingStep[];
  title?: string;
  onStepChange?: (step: number) => void;
  onComplete?: () => void;
  onSkip?: () => void;
}

export default function OnboardingFlow({
  steps = defaultSteps,
  title = 'Get Started',
  onStepChange,
  onComplete,
  onSkip,
}: OnboardingFlowProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [appName, setAppName] = useState('');

  const isFirst = currentStep === 0;
  const isLast = currentStep === steps.length - 1;
  const step = steps[currentStep];

  const goNext = () => {
    if (isLast) {
      onComplete?.();
      return;
    }
    const next = currentStep + 1;
    setCurrentStep(next);
    onStepChange?.(next);
  };

  const goBack = () => {
    if (isFirst) return;
    const prev = currentStep - 1;
    setCurrentStep(prev);
    onStepChange?.(prev);
  };

  // Default step content when custom content is not provided
  const renderDefaultContent = (stepIndex: number) => {
    switch (stepIndex) {
      case 0:
        return (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>{'\u2728'}</div>
            <Text variant="body" style={{ color: 'var(--ggui-color-neutral-600, #525252)' }}>
              Welcome to the platform. We'll guide you through the initial setup.
            </Text>
          </div>
        );
      case 1:
        return (
          <Stack gap="md" style={{ padding: '20px 0' }}>
            <div>
              <Text variant="small" style={{ fontWeight: 600, marginBottom: 4 }}>App Name</Text>
              <Input
                placeholder="My Awesome App"
                value={appName}
                onChange={setAppName}
                aria-label="App name"
              />
            </div>
            <div>
              <Text variant="small" style={{ fontWeight: 600, marginBottom: 4 }}>Description</Text>
              <Input
                placeholder="A brief description of your app"
                aria-label="App description"
              />
            </div>
          </Stack>
        );
      case 2:
        return (
          <div style={{ padding: '20px 0' }}>
            <Card
              padding="md"
              style={{
                backgroundColor: 'var(--ggui-color-neutral-50, #fafafa)',
                fontFamily: 'monospace',
                fontSize: 13,
              }}
            >
              <Stack gap="xs">
                <Text variant="small" style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}>
                  Add to your agent's MCP config:
                </Text>
                <div style={{ whiteSpace: 'pre', overflow: 'auto', color: 'var(--ggui-color-neutral-700, #404040)' }}>
{`{
  "mcpServers": {
    "ggui": {
      "type": "http",
      "url": "https://mcp.ggui.ai/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}`}
                </div>
              </Stack>
            </Card>
          </div>
        );
      case 3:
        return (
          <div style={{ padding: '20px 0', textAlign: 'center' }}>
            <Card padding="lg" style={{ backgroundColor: 'var(--ggui-color-primary-50, #f0f9ff)' }}>
              <Stack gap="sm">
                <Text variant="body" style={{ fontWeight: 600 }}>Try this prompt:</Text>
                <Text
                  variant="body"
                  style={{
                    fontStyle: 'italic',
                    color: 'var(--ggui-color-primary-600, #0284c7)',
                  }}
                >
                  "Show me a dashboard with my recent activity"
                </Text>
              </Stack>
            </Card>
          </div>
        );
      case 4:
        return (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>{'\u2705'}</div>
            <Text variant="body" style={{ color: 'var(--ggui-color-neutral-600, #525252)' }}>
              Your setup is complete. Start building amazing agent interfaces!
            </Text>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <Container style={{ maxWidth: 640, margin: '0 auto' }}>
      <Stack gap="lg">
        <Text variant="h2" style={{ textAlign: 'center' }}>{title}</Text>

        {/* Progress Steps */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '0 20px' }}>
          {steps.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', flex: i < steps.length - 1 ? 1 : 0 }}>
              {/* Step circle */}
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 14,
                  fontWeight: 600,
                  flexShrink: 0,
                  backgroundColor: i < currentStep
                    ? 'var(--ggui-color-success-500, #22c55e)'
                    : i === currentStep
                      ? 'var(--ggui-color-primary-600, #0284c7)'
                      : 'var(--ggui-color-neutral-200, #e5e5e5)',
                  color: i <= currentStep ? '#fff' : 'var(--ggui-color-neutral-500, #737373)',
                }}
              >
                {i < currentStep ? '\u2713' : i + 1}
              </div>

              {/* Connector line */}
              {i < steps.length - 1 && (
                <div
                  style={{
                    flex: 1,
                    height: 2,
                    backgroundColor: i < currentStep
                      ? 'var(--ggui-color-success-500, #22c55e)'
                      : 'var(--ggui-color-neutral-200, #e5e5e5)',
                    margin: '0 4px',
                  }}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step labels */}
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 8px' }}>
          {steps.map((s, i) => (
            <Text
              key={i}
              variant="small"
              style={{
                textAlign: 'center',
                width: `${100 / steps.length}%`,
                color: i === currentStep
                  ? 'var(--ggui-color-primary-600, #0284c7)'
                  : 'var(--ggui-color-neutral-400, #a3a3a3)',
                fontWeight: i === currentStep ? 600 : 400,
              }}
            >
              {s.title}
            </Text>
          ))}
        </div>

        {/* Step Content */}
        <Card padding="lg">
          <Stack gap="sm">
            <Text variant="h3" style={{ margin: 0 }}>{step.title}</Text>
            <Text variant="body" style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}>
              {step.description}
            </Text>
            {step.content || renderDefaultContent(currentStep)}
          </Stack>
        </Card>

        {/* Navigation */}
        <Row justify="between" align="center">
          {onSkip && !isLast ? (
            <Button variant="ghost" size="sm" onPress={onSkip}>
              Skip setup
            </Button>
          ) : (
            <div />
          )}
          <Row gap="sm">
            {!isFirst && (
              <Button variant="outline" onPress={goBack}>
                Back
              </Button>
            )}
            <Button variant="primary" onPress={goNext}>
              {isLast ? 'Finish' : 'Next'}
            </Button>
          </Row>
        </Row>
      </Stack>
    </Container>
  );
}
