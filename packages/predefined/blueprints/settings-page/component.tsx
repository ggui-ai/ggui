import { useState } from 'react';
import {
  Container,
  Card,
  Stack,
  Row,
  Text,
  Input,
  Checkbox,
  Select,
  Button,
  Divider,
} from '@ggui-ai/design/primitives';

interface UserData {
  name?: string;
  email?: string;
  avatar?: string;
}

interface SettingsData {
  emailNotifications?: boolean;
  pushNotifications?: boolean;
  marketingEmails?: boolean;
  language?: string;
  timezone?: string;
  theme?: string;
}

interface SettingsPageProps {
  user?: UserData;
  settings?: SettingsData;
  sections?: Array<'profile' | 'notifications' | 'preferences' | 'security'>;
  onSave?: (data: { user: UserData; settings: SettingsData }) => void;
  onChange?: (key: string, value: unknown) => void;
}

export default function SettingsPage({
  user: initialUser = {},
  settings: initialSettings = {},
  sections = ['profile', 'notifications', 'preferences'],
  onSave,
  onChange,
}: SettingsPageProps) {
  const [user, setUser] = useState<UserData>(initialUser);
  const [settings, setSettings] = useState<SettingsData>({
    emailNotifications: true,
    pushNotifications: false,
    marketingEmails: false,
    language: 'en',
    timezone: 'UTC',
    theme: 'system',
    ...initialSettings,
  });
  const [saved, setSaved] = useState(false);

  const updateUser = (key: keyof UserData, value: string) => {
    setUser((prev) => ({ ...prev, [key]: value }));
    onChange?.(`user.${key}`, value);
    setSaved(false);
  };

  const updateSetting = (key: keyof SettingsData, value: unknown) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    onChange?.(`settings.${key}`, value);
    setSaved(false);
  };

  const handleSave = () => {
    onSave?.({ user, settings });
    setSaved(true);
  };

  return (
    <Container style={{ maxWidth: 800, padding: '32px 16px' }}>
      <Stack gap="xl">
        <Row justify="between" align="center">
          <Text variant="h1">Settings</Text>
          <Button variant="primary" onPress={handleSave}>
            {saved ? 'Saved!' : 'Save Changes'}
          </Button>
        </Row>

        {sections.includes('profile') && (
          <Card padding="lg">
            <Stack gap="lg">
              <Text variant="h3">Profile</Text>
              <Divider />
              <Stack gap="md">
                <Stack gap="xs">
                  <Text variant="label">Display Name</Text>
                  <Input
                    value={user.name || ''}
                    placeholder="Your name"
                    onChange={(value) => updateUser('name', value)}
                    aria-label="Display name"
                  />
                </Stack>
                <Stack gap="xs">
                  <Text variant="label">Email Address</Text>
                  <Input
                    type="email"
                    value={user.email || ''}
                    placeholder="you@example.com"
                    onChange={(value) => updateUser('email', value)}
                    aria-label="Email address"
                  />
                </Stack>
              </Stack>
            </Stack>
          </Card>
        )}

        {sections.includes('notifications') && (
          <Card padding="lg">
            <Stack gap="lg">
              <Text variant="h3">Notifications</Text>
              <Divider />
              <Stack gap="md">
                <Checkbox
                  label="Email notifications"
                  checked={settings.emailNotifications}
                  onChange={(checked) => updateSetting('emailNotifications', checked)}
                />
                <Checkbox
                  label="Push notifications"
                  checked={settings.pushNotifications}
                  onChange={(checked) => updateSetting('pushNotifications', checked)}
                />
                <Checkbox
                  label="Marketing emails"
                  checked={settings.marketingEmails}
                  onChange={(checked) => updateSetting('marketingEmails', checked)}
                />
              </Stack>
            </Stack>
          </Card>
        )}

        {sections.includes('preferences') && (
          <Card padding="lg">
            <Stack gap="lg">
              <Text variant="h3">Preferences</Text>
              <Divider />
              <Stack gap="md">
                <Stack gap="xs">
                  <Text variant="label">Language</Text>
                  <Select
                    value={settings.language}
                    options={[
                      { value: 'en', label: 'English' },
                      { value: 'es', label: 'Spanish' },
                      { value: 'fr', label: 'French' },
                      { value: 'de', label: 'German' },
                    ]}
                    onChange={(value) => updateSetting('language', value)}
                    aria-label="Language"
                  />
                </Stack>
                <Stack gap="xs">
                  <Text variant="label">Timezone</Text>
                  <Select
                    value={settings.timezone}
                    options={[
                      { value: 'UTC', label: 'UTC' },
                      { value: 'America/New_York', label: 'Eastern Time' },
                      { value: 'America/Los_Angeles', label: 'Pacific Time' },
                      { value: 'Europe/London', label: 'London' },
                    ]}
                    onChange={(value) => updateSetting('timezone', value)}
                    aria-label="Timezone"
                  />
                </Stack>
                <Stack gap="xs">
                  <Text variant="label">Theme</Text>
                  <Select
                    value={settings.theme}
                    options={[
                      { value: 'system', label: 'System Default' },
                      { value: 'light', label: 'Light' },
                      { value: 'dark', label: 'Dark' },
                    ]}
                    onChange={(value) => updateSetting('theme', value)}
                    aria-label="Theme"
                  />
                </Stack>
              </Stack>
            </Stack>
          </Card>
        )}

        {sections.includes('security') && (
          <Card padding="lg">
            <Stack gap="lg">
              <Text variant="h3">Security</Text>
              <Divider />
              <Stack gap="md">
                <Button variant="secondary">Change Password</Button>
                <Button variant="secondary">Enable Two-Factor Authentication</Button>
                <Button variant="ghost" style={{ color: '#ef4444' }}>
                  Delete Account
                </Button>
              </Stack>
            </Stack>
          </Card>
        )}
      </Stack>
    </Container>
  );
}
