import { useState, useEffect } from 'react';
import { Row, Input, Button } from '@ggui-ai/design/primitives';

interface SearchFieldProps {
  placeholder?: string;
  value?: string;
  showClear?: boolean;
  onChange?: (value: string) => void;
  onSearch?: (value: string) => void;
  onClear?: () => void;
}

export default function SearchField({
  placeholder = 'Search...',
  value: controlledValue,
  showClear = true,
  onChange,
  onSearch,
  onClear,
}: SearchFieldProps) {
  const [internalValue, setInternalValue] = useState('');
  const value = controlledValue !== undefined ? controlledValue : internalValue;

  useEffect(() => {
    if (controlledValue !== undefined) {
      setInternalValue(controlledValue);
    }
  }, [controlledValue]);

  const handleChange = (newValue: string) => {
    setInternalValue(newValue);
    onChange?.(newValue);
  };

  const handleSearch = () => {
    onSearch?.(value);
  };

  const handleClear = () => {
    setInternalValue('');
    onChange?.('');
    onClear?.();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      handleSearch();
    }
  };

  return (
    <Row gap="sm" align="center">
      <Input
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        aria-label="Search"
        style={{ flex: 1 }}
      />
      {showClear && value && (
        <Button
          variant="ghost"
          size="sm"
          onPress={handleClear}
          aria-label="Clear search"
        >
          ✕
        </Button>
      )}
      <Button variant="primary" onPress={handleSearch} aria-label="Submit search">
        Search
      </Button>
    </Row>
  );
}
