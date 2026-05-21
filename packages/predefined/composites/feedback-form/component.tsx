import { useState } from 'react';
import { Card, Stack, Row, Text, TextArea, Button, Select } from '@ggui-ai/design/primitives';

interface FeedbackFormProps {
  title?: string;
  categories?: string[];
  maxRating?: number;
  submitLabel?: string;
  showRating?: boolean;
  onSubmit?: (data: { rating: number | null; category: string; message: string }) => void;
}

function StarRating({
  value,
  max,
  onChange,
}: {
  value: number;
  max: number;
  onChange: (rating: number) => void;
}) {
  const [hovered, setHovered] = useState(0);

  return (
    <Row gap="xs" role="radiogroup" aria-label="Rating">
      {Array.from({ length: max }, (_, i) => {
        const starValue = i + 1;
        const isActive = starValue <= (hovered || value);
        return (
          <button
            key={starValue}
            type="button"
            onClick={() => onChange(starValue)}
            onMouseEnter={() => setHovered(starValue)}
            onMouseLeave={() => setHovered(0)}
            role="radio"
            aria-checked={starValue === value}
            aria-label={`${starValue} star${starValue > 1 ? 's' : ''}`}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 28,
              padding: 2,
              color: isActive
                ? 'var(--ggui-color-warning-500, #f59e0b)'
                : 'var(--ggui-color-neutral-300, #d4d4d4)',
              transition: 'color 0.15s, transform 0.15s',
              transform: hovered === starValue ? 'scale(1.15)' : 'scale(1)',
            }}
          >
            {isActive ? '\u2605' : '\u2606'}
          </button>
        );
      })}
    </Row>
  );
}

export default function FeedbackForm({
  title = 'Share Your Feedback',
  categories,
  maxRating = 5,
  submitLabel = 'Submit Feedback',
  showRating = true,
  onSubmit,
}: FeedbackFormProps) {
  const [rating, setRating] = useState(0);
  const [category, setCategory] = useState('');
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const validate = () => {
    const newErrors: Record<string, string> = {};

    if (showRating && rating === 0) {
      newErrors.rating = 'Please select a rating';
    }

    if (!message.trim()) {
      newErrors.message = 'Please provide your feedback';
    } else if (message.length < 10) {
      newErrors.message = 'Feedback must be at least 10 characters';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (validate()) {
      onSubmit?.({
        rating: showRating ? rating : null,
        category,
        message,
      });
      setSubmitted(true);
    }
  };

  if (submitted) {
    return (
      <Card padding="lg" style={{ maxWidth: 480, margin: '0 auto' }}>
        <Stack gap="md" style={{ textAlign: 'center', padding: '16px 0' }}>
          <Text variant="h3" style={{ color: 'var(--ggui-color-success-500, #22c55e)' }}>
            Thank you!
          </Text>
          <Text variant="body" style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}>
            Your feedback has been submitted successfully.
          </Text>
          <Button
            variant="secondary"
            onPress={() => {
              setSubmitted(false);
              setRating(0);
              setCategory('');
              setMessage('');
            }}
          >
            Submit more feedback
          </Button>
        </Stack>
      </Card>
    );
  }

  return (
    <Card padding="lg" style={{ maxWidth: 480, margin: '0 auto' }}>
      <Stack gap="lg">
        <Text variant="h2">{title}</Text>

        {showRating && (
          <Stack gap="xs">
            <Text variant="label">Rating</Text>
            <StarRating value={rating} max={maxRating} onChange={setRating} />
            {errors.rating && (
              <Text variant="caption" style={{ color: 'var(--ggui-color-error-500, #ef4444)' }}>
                {errors.rating}
              </Text>
            )}
          </Stack>
        )}

        {categories && categories.length > 0 && (
          <Stack gap="xs">
            <Text variant="label">Category</Text>
            <Select
              value={category}
              options={[
                { value: '', label: 'Select a category...' },
                ...categories.map((cat) => ({ value: cat, label: cat })),
              ]}
              onChange={setCategory}
              aria-label="Feedback category"
            />
          </Stack>
        )}

        <Stack gap="xs">
          <Text variant="label">Your Feedback</Text>
          <TextArea
            placeholder="Tell us what you think..."
            value={message}
            onChange={setMessage}
            rows={5}
            aria-label="Feedback message"
          />
          {errors.message && (
            <Text variant="caption" style={{ color: 'var(--ggui-color-error-500, #ef4444)' }}>
              {errors.message}
            </Text>
          )}
        </Stack>

        <Button variant="primary" onPress={handleSubmit} style={{ width: '100%' }}>
          {submitLabel}
        </Button>
      </Stack>
    </Card>
  );
}
