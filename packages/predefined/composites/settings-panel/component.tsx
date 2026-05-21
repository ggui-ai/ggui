import { useState } from 'react';
import { Card, Stack, Row, Text, Input, Select, Button, Divider } from '@ggui-ai/design/primitives';

interface SettingItem {
  key: string;
  label: string;
  description?: string;
  type: 'toggle' | 'select' | 'input';
  value: unknown;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
}

interface SettingSection {
  label: string;
  items: SettingItem[];
}

interface SettingsPanelProps {
  title?: string;
  sections: SettingSection[];
  showSaveButton?: boolean;
  onChange?: (key: string, value: unknown) => void;
  onSave?: (values: Record<string, unknown>) => void;
}

function ToggleSwitch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      style={{
        position: 'relative',
        width: 44,
        height: 24,
        borderRadius: 12,
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        backgroundColor: checked
          ? 'var(--ggui-color-primary-600, #2563eb)'
          : 'var(--ggui-color-neutral-300, #d4d4d4)',
        transition: 'background-color 0.2s',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 22 : 2,
          width: 20,
          height: 20,
          borderRadius: '50%',
          backgroundColor: '#ffffff',
          transition: 'left 0.2s',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.2)',
        }}
      />
    </button>
  );
}

export default function SettingsPanel({
  title = 'Settings',
  sections,
  showSaveButton = true,
  onChange,
  onSave,
}: SettingsPanelProps) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const section of sections) {
      for (const item of section.items) {
        initial[item.key] = item.value;
      }
    }
    return initial;
  });
  const [saved, setSaved] = useState(false);

  const handleChange = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    onChange?.(key, value);
    setSaved(false);
  };

  const handleSave = () => {
    onSave?.(values);
    setSaved(true);
  };

  const renderControl = (item: SettingItem) => {
    const currentValue = values[item.key] ?? item.value;

    switch (item.type) {
      case 'toggle':
        return (
          <ToggleSwitch
            checked={Boolean(currentValue)}
            onChange={(checked) => handleChange(item.key, checked)}
            ariaLabel={item.label}
          />
        );

      case 'select':
        return (
          <Select
            value={String(currentValue ?? '')}
            options={item.options ?? []}
            onChange={(value) => handleChange(item.key, value)}
            aria-label={item.label}
            style={{ minWidth: 150 }}
          />
        );

      case 'input':
        return (
          <Input
            value={String(currentValue ?? '')}
            placeholder={item.placeholder}
            onChange={(value) => handleChange(item.key, value)}
            aria-label={item.label}
            style={{ minWidth: 150, maxWidth: 240 }}
          />
        );
    }
  };

  return (
    <Card padding="lg" style={{ maxWidth: 600 }}>
      <Stack gap="lg">
        <Text variant="h3">{title}</Text>

        {sections.map((section, sectionIndex) => (
          <Stack key={section.label} gap="md">
            {sectionIndex > 0 && <Divider />}

            <Text
              variant="label"
              style={{
                color: 'var(--ggui-color-neutral-500, #737373)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {section.label}
            </Text>

            {section.items.map((item) => (
              <Row
                key={item.key}
                justify="between"
                align="center"
                style={{
                  padding: '8px 0',
                  minHeight: 44,
                }}
              >
                <Stack gap="xs" style={{ flex: 1, marginRight: 16 }}>
                  <Text variant="body" style={{ fontWeight: 500 }}>
                    {item.label}
                  </Text>
                  {item.description && (
                    <Text
                      variant="small"
                      style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}
                    >
                      {item.description}
                    </Text>
                  )}
                </Stack>
                {renderControl(item)}
              </Row>
            ))}
          </Stack>
        ))}

        {showSaveButton && (
          <>
            <Divider />
            <Row justify="end">
              <Button variant="primary" onPress={handleSave}>
                {saved ? 'Saved!' : 'Save Changes'}
              </Button>
            </Row>
          </>
        )}
      </Stack>
    </Card>
  );
}
