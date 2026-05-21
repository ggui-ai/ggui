import { useState } from 'react';
import { Card, Stack, Row, Text, Input, TextArea, Button } from '@ggui-ai/design/primitives';

interface ContactFormProps {
  title?: string;
  submitLabel?: string;
  showSubject?: boolean;
  onSubmit?: (data: { name: string; email: string; subject?: string; message: string }) => void;
}

export default function ContactForm({
  title = 'Contact Us',
  submitLabel = 'Send Message',
  showSubject = false,
  onSubmit,
}: ContactFormProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const validate = () => {
    const newErrors: Record<string, string> = {};

    if (!name.trim()) {
      newErrors.name = 'Name is required';
    }

    if (!email.trim()) {
      newErrors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      newErrors.email = 'Invalid email format';
    }

    if (!message.trim()) {
      newErrors.message = 'Message is required';
    } else if (message.length < 10) {
      newErrors.message = 'Message must be at least 10 characters';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (validate()) {
      onSubmit?.({ name, email, subject: showSubject ? subject : undefined, message });
      setSubmitted(true);
    }
  };

  if (submitted) {
    return (
      <Card padding="lg" style={{ maxWidth: 500, margin: '0 auto' }}>
        <Stack gap="md" style={{ textAlign: 'center' }}>
          <Text variant="h3" style={{ color: '#22c55e' }}>
            Thank you!
          </Text>
          <Text variant="body">
            Your message has been sent. We'll get back to you soon.
          </Text>
          <Button variant="secondary" onPress={() => setSubmitted(false)}>
            Send another message
          </Button>
        </Stack>
      </Card>
    );
  }

  return (
    <Card padding="lg" style={{ maxWidth: 500, margin: '0 auto' }}>
      <Stack gap="lg">
        <Text variant="h2">{title}</Text>

        <Row gap="md" style={{ flexWrap: 'wrap' }}>
          <Stack gap="xs" style={{ flex: 1, minWidth: 200 }}>
            <Text variant="label">Name</Text>
            <Input
              placeholder="Your name"
              value={name}
              onChange={setName}
              aria-label="Your name"
            />
            {errors.name && (
              <Text variant="caption" style={{ color: '#ef4444' }}>
                {errors.name}
              </Text>
            )}
          </Stack>

          <Stack gap="xs" style={{ flex: 1, minWidth: 200 }}>
            <Text variant="label">Email</Text>
            <Input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={setEmail}
              aria-label="Email address"
            />
            {errors.email && (
              <Text variant="caption" style={{ color: '#ef4444' }}>
                {errors.email}
              </Text>
            )}
          </Stack>
        </Row>

        {showSubject && (
          <Stack gap="xs">
            <Text variant="label">Subject</Text>
            <Input
              placeholder="Message subject"
              value={subject}
              onChange={setSubject}
              aria-label="Message subject"
            />
          </Stack>
        )}

        <Stack gap="xs">
          <Text variant="label">Message</Text>
          <TextArea
            placeholder="How can we help you?"
            value={message}
            onChange={setMessage}
            rows={5}
            aria-label="Your message"
          />
          {errors.message && (
            <Text variant="caption" style={{ color: '#ef4444' }}>
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
