import { useState } from 'react';
import {
  Container,
  Card,
  Row,
  Stack,
  Text,
  Input,
  Button,
  Divider,
} from '@ggui-ai/design/primitives';

type AuthView = 'login' | 'signup' | 'reset';

interface SocialProvider {
  id: string;
  name: string;
  icon?: string;
}

interface AuthFlowBlueprintProps {
  initialView?: AuthView;
  logo?: string;
  appName?: string;
  socialProviders?: SocialProvider[];
  showSignup?: boolean;
  onLogin?: (data: { email: string; password: string }) => void;
  onSignup?: (data: { name: string; email: string; password: string }) => void;
  onPasswordReset?: (data: { email: string }) => void;
  onSocialLogin?: (provider: string) => void;
}

export default function AuthFlowBlueprint({
  initialView = 'login',
  logo,
  appName = 'App',
  socialProviders = [],
  showSignup = true,
  onLogin,
  onSignup,
  onPasswordReset,
  onSocialLogin,
}: AuthFlowBlueprintProps) {
  const [view, setView] = useState<AuthView>(initialView);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const resetForm = () => {
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setName('');
    setError('');
    setSuccess('');
  };

  const handleViewChange = (newView: AuthView) => {
    resetForm();
    setView(newView);
  };

  const handleLogin = () => {
    if (!email || !password) {
      setError('Please fill in all fields');
      return;
    }
    setError('');
    onLogin?.({ email, password });
  };

  const handleSignup = () => {
    if (!name || !email || !password) {
      setError('Please fill in all fields');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setError('');
    onSignup?.({ name, email, password });
  };

  const handlePasswordReset = () => {
    if (!email) {
      setError('Please enter your email address');
      return;
    }
    setError('');
    setSuccess('If an account exists with this email, you will receive a password reset link.');
    onPasswordReset?.({ email });
  };

  const socialIcons: Record<string, string> = {
    google: 'G',
    github: '⌘',
    facebook: 'f',
    twitter: '𝕏',
    apple: '',
  };

  return (
    <Container
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: 24,
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      }}
    >
      <Card
        padding="none"
        style={{
          width: '100%',
          maxWidth: 400,
          boxShadow: '0 25px 50px -12px rgb(0 0 0 / 0.25)',
        }}
      >
        {/* Header */}
        <div style={{ padding: '32px 32px 24px', textAlign: 'center' }}>
          {logo ? (
            <img src={logo} alt={appName} style={{ height: 48, marginBottom: 16 }} />
          ) : (
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 12,
                backgroundColor: '#6366f1',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 16px',
                color: '#ffffff',
                fontWeight: 700,
                fontSize: 20,
              }}
            >
              {appName[0]}
            </div>
          )}
          <Text variant="h2">
            {view === 'login'
              ? `Welcome back`
              : view === 'signup'
                ? `Create account`
                : `Reset password`}
          </Text>
          <Text variant="body" style={{ color: '#6b7280', marginTop: 4 }}>
            {view === 'login'
              ? `Sign in to ${appName}`
              : view === 'signup'
                ? `Get started with ${appName}`
                : `Enter your email to reset`}
          </Text>
        </div>

        {/* Tabs (only for login/signup) */}
        {view !== 'reset' && showSignup && (
          <Row style={{ borderBottom: '1px solid #e5e7eb' }}>
            <button
              onClick={() => handleViewChange('login')}
              style={{
                flex: 1,
                padding: '12px 16px',
                border: 'none',
                backgroundColor: 'transparent',
                color: view === 'login' ? '#6366f1' : '#6b7280',
                fontWeight: view === 'login' ? 600 : 400,
                borderBottom: view === 'login' ? '2px solid #6366f1' : '2px solid transparent',
                cursor: 'pointer',
              }}
            >
              Sign In
            </button>
            <button
              onClick={() => handleViewChange('signup')}
              style={{
                flex: 1,
                padding: '12px 16px',
                border: 'none',
                backgroundColor: 'transparent',
                color: view === 'signup' ? '#6366f1' : '#6b7280',
                fontWeight: view === 'signup' ? 600 : 400,
                borderBottom: view === 'signup' ? '2px solid #6366f1' : '2px solid transparent',
                cursor: 'pointer',
              }}
            >
              Sign Up
            </button>
          </Row>
        )}

        {/* Form Content */}
        <div style={{ padding: 32 }}>
          {/* Error/Success Messages */}
          {error && (
            <div
              style={{
                padding: 12,
                marginBottom: 16,
                backgroundColor: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: 8,
                color: '#dc2626',
                fontSize: 14,
              }}
            >
              {error}
            </div>
          )}
          {success && (
            <div
              style={{
                padding: 12,
                marginBottom: 16,
                backgroundColor: '#f0fdf4',
                border: '1px solid #bbf7d0',
                borderRadius: 8,
                color: '#16a34a',
                fontSize: 14,
              }}
            >
              {success}
            </div>
          )}

          {view === 'login' && (
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
              </Stack>
              <Row justify="end">
                <button
                  onClick={() => handleViewChange('reset')}
                  style={{
                    border: 'none',
                    backgroundColor: 'transparent',
                    color: '#6366f1',
                    fontSize: 14,
                    cursor: 'pointer',
                  }}
                >
                  Forgot password?
                </button>
              </Row>
              <Button variant="primary" onPress={handleLogin} style={{ width: '100%' }}>
                Sign In
              </Button>
            </Stack>
          )}

          {view === 'signup' && (
            <Stack gap="md">
              <Stack gap="xs">
                <Text variant="label">Name</Text>
                <Input
                  type="text"
                  placeholder="Your name"
                  value={name}
                  onChange={setName}
                  aria-label="Full name"
                />
              </Stack>
              <Stack gap="xs">
                <Text variant="label">Email</Text>
                <Input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={setEmail}
                  aria-label="Email address"
                />
              </Stack>
              <Stack gap="xs">
                <Text variant="label">Password</Text>
                <Input
                  type="password"
                  placeholder="Create a password"
                  value={password}
                  onChange={setPassword}
                  aria-label="Password"
                />
              </Stack>
              <Stack gap="xs">
                <Text variant="label">Confirm Password</Text>
                <Input
                  type="password"
                  placeholder="Confirm your password"
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  aria-label="Confirm password"
                />
              </Stack>
              <Button variant="primary" onPress={handleSignup} style={{ width: '100%' }}>
                Create Account
              </Button>
            </Stack>
          )}

          {view === 'reset' && (
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
              </Stack>
              <Button variant="primary" onPress={handlePasswordReset} style={{ width: '100%' }}>
                Send Reset Link
              </Button>
              <button
                onClick={() => handleViewChange('login')}
                style={{
                  border: 'none',
                  backgroundColor: 'transparent',
                  color: '#6366f1',
                  fontSize: 14,
                  cursor: 'pointer',
                  textAlign: 'center',
                }}
              >
                ← Back to sign in
              </button>
            </Stack>
          )}

          {/* Social Login */}
          {socialProviders.length > 0 && view !== 'reset' && (
            <>
              <Row align="center" gap="md" style={{ margin: '24px 0' }}>
                <Divider style={{ flex: 1 }} />
                <Text variant="small" style={{ color: '#9ca3af' }}>
                  or continue with
                </Text>
                <Divider style={{ flex: 1 }} />
              </Row>
              <Row gap="sm">
                {socialProviders.map((provider) => (
                  <Button
                    key={provider.id}
                    variant="secondary"
                    onPress={() => onSocialLogin?.(provider.id)}
                    style={{ flex: 1 }}
                    aria-label={`Sign in with ${provider.name}`}
                  >
                    <span style={{ marginRight: 8 }}>
                      {provider.icon || socialIcons[provider.id] || provider.name[0]}
                    </span>
                    {provider.name}
                  </Button>
                ))}
              </Row>
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '16px 32px',
            borderTop: '1px solid #e5e7eb',
            textAlign: 'center',
          }}
        >
          <Text variant="small" style={{ color: '#9ca3af' }}>
            By continuing, you agree to our Terms of Service and Privacy Policy.
          </Text>
        </div>
      </Card>
    </Container>
  );
}
