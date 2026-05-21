import { useState } from 'react';
import { Card, Stack, Text, Input, Button, Row } from '@ggui-ai/design/primitives';

interface LoginFormProps {
  title?: string;
  showForgotPassword?: boolean;
  submitLabel?: string;
  onSubmit?: (data: { email: string; password: string }) => void;
  onForgotPassword?: () => void;
}

export default function LoginForm({
  title = 'Sign In',
  showForgotPassword = true,
  submitLabel = 'Sign In',
  onSubmit,
  onForgotPassword,
}: LoginFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});

  const validate = () => {
    const newErrors: { email?: string; password?: string } = {};

    if (!email) {
      newErrors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      newErrors.email = 'Invalid email format';
    }

    if (!password) {
      newErrors.password = 'Password is required';
    } else if (password.length < 6) {
      newErrors.password = 'Password must be at least 6 characters';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (validate()) {
      onSubmit?.({ email, password });
    }
  };

  return (
    <Card padding="lg" style={{ maxWidth: 400, margin: '0 auto' }}>
      <Stack gap="lg">
        <Text variant="h2" style={{ textAlign: 'center' }}>
          {title}
        </Text>

        <Stack gap="md">
          <Stack gap="xs">
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

          <Stack gap="xs">
            <Text variant="label">Password</Text>
            <Input
              type="password"
              placeholder="Enter your password"
              value={password}
              onChange={setPassword}
              aria-label="Password"
            />
            {errors.password && (
              <Text variant="caption" style={{ color: '#ef4444' }}>
                {errors.password}
              </Text>
            )}
          </Stack>
        </Stack>

        {showForgotPassword && (
          <Row justify="end">
            <Button variant="ghost" size="sm" onPress={onForgotPassword}>
              Forgot password?
            </Button>
          </Row>
        )}

        <Button variant="primary" onPress={handleSubmit} style={{ width: '100%' }}>
          {submitLabel}
        </Button>
      </Stack>
    </Card>
  );
}
