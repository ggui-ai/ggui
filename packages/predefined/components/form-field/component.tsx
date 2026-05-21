import { Stack, Text, Input } from '@ggui-ai/design/primitives';

interface FormFieldProps {
  label: string;
  value?: string;
  placeholder?: string;
  type?: 'text' | 'email' | 'password' | 'number' | 'tel' | 'url';
  error?: string;
  helperText?: string;
  required?: boolean;
  onChange?: (value: string) => void;
}

export default function FormField({
  label,
  value = '',
  placeholder,
  type = 'text',
  error,
  helperText,
  required = false,
  onChange,
}: FormFieldProps) {
  const id = `field-${label.toLowerCase().replace(/\s+/g, '-')}`;

  return (
    <Stack gap="xs">
      <Text
        variant="label"
        style={{ fontWeight: 500 }}
      >
        {label}
        {required && (
          <span style={{ color: '#ef4444', marginLeft: 4 }}>*</span>
        )}
      </Text>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={onChange}
        aria-label={label}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : helperText ? `${id}-helper` : undefined}
        style={{
          borderColor: error ? '#ef4444' : undefined,
        }}
      />
      {error && (
        <Text
          id={`${id}-error`}
          variant="caption"
          style={{ color: '#ef4444' }}
          role="alert"
        >
          {error}
        </Text>
      )}
      {!error && helperText && (
        <Text
          id={`${id}-helper`}
          variant="caption"
          style={{ color: '#737373' }}
        >
          {helperText}
        </Text>
      )}
    </Stack>
  );
}
