import { useState, type ReactNode } from 'react';
import {
  Container,
  Card,
  Row,
  Stack,
  Text,
  Button,
  Divider,
} from '@ggui-ai/design/primitives';

interface Step {
  id: string;
  title: string;
  description?: string;
  isValid?: () => boolean;
}

interface FormWizardBlueprintProps {
  steps: Step[];
  initialStep?: number;
  showReview?: boolean;
  submitButtonText?: string;
  onStepChange?: (stepIndex: number, step: Step) => void;
  onSubmit?: (data: Record<string, unknown>) => void;
  onCancel?: () => void;
  // Slot content - render prop pattern for step content
  stepContent?: (step: Step, stepIndex: number) => ReactNode;
  reviewContent?: () => ReactNode;
  children?: ReactNode;
}

export default function FormWizardBlueprint({
  steps,
  initialStep = 0,
  showReview = true,
  submitButtonText = 'Submit',
  onStepChange,
  onSubmit,
  onCancel,
  stepContent,
  reviewContent,
  children,
}: FormWizardBlueprintProps) {
  const [currentStep, setCurrentStep] = useState(initialStep);
  const [formData, _setFormData] = useState<Record<string, unknown>>({});

  const totalSteps = showReview ? steps.length + 1 : steps.length;
  const isReviewStep = showReview && currentStep === steps.length;
  const isLastStep = currentStep === totalSteps - 1;
  const isFirstStep = currentStep === 0;

  const currentStepData = isReviewStep ? null : steps[currentStep];

  const handleNext = () => {
    if (isLastStep) {
      onSubmit?.(formData);
      return;
    }

    // Validate current step if validator exists
    if (currentStepData?.isValid && !currentStepData.isValid()) {
      return; // Don't proceed if validation fails
    }

    const nextStep = currentStep + 1;
    setCurrentStep(nextStep);
    if (!isReviewStep && steps[nextStep]) {
      onStepChange?.(nextStep, steps[nextStep]);
    }
  };

  const handleBack = () => {
    if (isFirstStep) {
      onCancel?.();
      return;
    }

    const prevStep = currentStep - 1;
    setCurrentStep(prevStep);
    if (steps[prevStep]) {
      onStepChange?.(prevStep, steps[prevStep]);
    }
  };

  const goToStep = (index: number) => {
    if (index < currentStep && index >= 0 && index < steps.length) {
      setCurrentStep(index);
      onStepChange?.(index, steps[index]);
    }
  };

  return (
    <Container
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: 24,
        backgroundColor: '#f9fafb',
      }}
    >
      <Card
        padding="none"
        style={{
          width: '100%',
          maxWidth: 640,
          boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
        }}
      >
        {/* Progress Bar */}
        <div style={{ padding: '24px 24px 0' }}>
          <Row gap="sm" align="center" style={{ marginBottom: 16 }}>
            {steps.map((step, index) => (
              <div key={step.id} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
                {/* Step Circle */}
                <button
                  onClick={() => goToStep(index)}
                  disabled={index >= currentStep}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    border: 'none',
                    backgroundColor:
                      index < currentStep
                        ? '#22c55e' // Completed - green
                        : index === currentStep
                          ? '#6366f1' // Current - primary
                          : '#e5e7eb', // Future - gray
                    color: index <= currentStep ? '#ffffff' : '#6b7280',
                    fontWeight: 600,
                    fontSize: 14,
                    cursor: index < currentStep ? 'pointer' : 'default',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  aria-label={`Step ${index + 1}: ${step.title}`}
                  aria-current={index === currentStep ? 'step' : undefined}
                >
                  {index < currentStep ? '✓' : index + 1}
                </button>

                {/* Connector Line */}
                {index < steps.length - 1 && (
                  <div
                    style={{
                      flex: 1,
                      height: 2,
                      marginLeft: 8,
                      marginRight: 8,
                      backgroundColor: index < currentStep ? '#22c55e' : '#e5e7eb',
                    }}
                  />
                )}
              </div>
            ))}

            {/* Review Step Indicator */}
            {showReview && (
              <>
                <div
                  style={{
                    flex: 1,
                    height: 2,
                    marginLeft: 8,
                    marginRight: 8,
                    backgroundColor: isReviewStep ? '#22c55e' : '#e5e7eb',
                  }}
                />
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    backgroundColor: isReviewStep ? '#6366f1' : '#e5e7eb',
                    color: isReviewStep ? '#ffffff' : '#6b7280',
                    fontWeight: 600,
                    fontSize: 14,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  ✓
                </div>
              </>
            )}
          </Row>

          {/* Step Labels */}
          <Row justify="between" style={{ marginBottom: 8 }}>
            {steps.map((step, index) => (
              <Text
                key={step.id}
                variant="small"
                style={{
                  color: index === currentStep ? '#6366f1' : '#6b7280',
                  fontWeight: index === currentStep ? 600 : 400,
                  textAlign: 'center',
                  flex: 1,
                }}
              >
                {step.title}
              </Text>
            ))}
            {showReview && (
              <Text
                variant="small"
                style={{
                  color: isReviewStep ? '#6366f1' : '#6b7280',
                  fontWeight: isReviewStep ? 600 : 400,
                  textAlign: 'center',
                  flex: 1,
                }}
              >
                Review
              </Text>
            )}
          </Row>
        </div>

        <Divider />

        {/* Step Content */}
        <div style={{ padding: 24, minHeight: 300 }}>
          {isReviewStep ? (
            <Stack gap="md">
              <Text variant="h3">Review Your Information</Text>
              <Text variant="body" style={{ color: '#6b7280' }}>
                Please review your information before submitting.
              </Text>
              {reviewContent?.() ?? (
                <Card style={{ backgroundColor: '#f9fafb', padding: 16 }}>
                  <Text variant="small" style={{ color: '#6b7280' }}>
                    Review content will appear here.
                  </Text>
                </Card>
              )}
            </Stack>
          ) : (
            <Stack gap="md">
              <div>
                <Text variant="h3">{currentStepData?.title}</Text>
                {currentStepData?.description && (
                  <Text variant="body" style={{ color: '#6b7280', marginTop: 4 }}>
                    {currentStepData.description}
                  </Text>
                )}
              </div>
              {stepContent?.(currentStepData!, currentStep) ?? children ?? (
                <Card style={{ backgroundColor: '#f9fafb', padding: 16 }}>
                  <Text variant="small" style={{ color: '#6b7280' }}>
                    Step content will appear here.
                  </Text>
                </Card>
              )}
            </Stack>
          )}
        </div>

        <Divider />

        {/* Navigation Buttons */}
        <Row justify="between" style={{ padding: 24 }}>
          <Button
            variant="ghost"
            onPress={handleBack}
            aria-label={isFirstStep ? 'Cancel' : 'Go back'}
          >
            {isFirstStep ? 'Cancel' : 'Back'}
          </Button>

          <Button
            variant="primary"
            onPress={handleNext}
            aria-label={isLastStep ? submitButtonText : 'Continue to next step'}
          >
            {isLastStep ? submitButtonText : 'Next'}
          </Button>
        </Row>
      </Card>
    </Container>
  );
}
