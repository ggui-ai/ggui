/**
 * NativeRegistry - Built-in React Native component mappings
 *
 * Maps server-side component type names to React Native components.
 * Used by the descriptor-based rendering path of DynamicComponent.
 *
 * Server component types → React Native equivalents:
 * - div, View → View
 * - span, Text, p, h1-h6, label → Text (with styling)
 * - input, TextInput → TextInput
 * - button, Button → Pressable
 * - img, Image → Image
 * - ScrollView → ScrollView
 * - Switch → Switch
 * - separator, hr → View with border styling
 * - card → View with shadow + border radius
 */

import React from 'react';
import {
  View,
  Text,
  TextInput,
  Image,
  ScrollView,
  Switch,
  Pressable,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
  type ImageStyle,
} from 'react-native';
import { registerComponent } from './DynamicComponent';
import { rnSpacingNamed, rnFontSize, rnRadius, rnShadow, rnColors } from '../theme';

type StyleProp = ViewStyle | TextStyle | ImageStyle;

/**
 * Convert CSS-like style properties to React Native compatible styles
 */
function translateStyle(webStyle?: Record<string, unknown>): StyleProp {
  if (!webStyle) return {};

  const rnStyle: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(webStyle)) {
    if (value === undefined || value === null) continue;

    // Skip CSS-only properties
    if (['cursor', 'transition', 'animation', 'boxSizing', 'float', 'clear'].includes(key)) {
      continue;
    }

    // Convert px string values to numbers
    if (typeof value === 'string' && value.endsWith('px')) {
      rnStyle[key] = parseFloat(value);
      continue;
    }

    // Convert percentage for width/height/etc.
    if (typeof value === 'string' && value.endsWith('%')) {
      rnStyle[key] = value; // RN supports percentage strings
      continue;
    }

    // Convert 'auto' for margin
    if (value === 'auto' && key.startsWith('margin')) {
      rnStyle[key] = 'auto';
      continue;
    }

    // Font weight must be a string in RN
    if (key === 'fontWeight' && typeof value === 'number') {
      rnStyle[key] = String(value);
      continue;
    }

    rnStyle[key] = value;
  }

  return rnStyle as StyleProp;
}

// --- Component Wrappers ---

function NativeView({ style, children, ...props }: Record<string, unknown>) {
  return (
    <View style={translateStyle(style as Record<string, unknown>) as ViewStyle} {...props}>
      {children as React.ReactNode}
    </View>
  );
}

function NativeText({ style, children, ...props }: Record<string, unknown>) {
  return (
    <Text style={translateStyle(style as Record<string, unknown>) as TextStyle} {...props}>
      {children as React.ReactNode}
    </Text>
  );
}

function NativeHeading({ level = 1, style, children }: Record<string, unknown>) {
  const sizes: Record<number, number> = {
    1: rnFontSize['4xl'],
    2: rnFontSize['3xl'],
    3: rnFontSize['2xl'],
    4: rnFontSize.xl,
    5: rnFontSize.lg,
    6: rnFontSize.base,
  };
  const lvl = typeof level === 'number' ? level : 1;
  return (
    <Text
      style={[
        { fontSize: sizes[lvl] || sizes[1], fontWeight: '700', marginBottom: rnSpacingNamed.sm },
        translateStyle(style as Record<string, unknown>) as TextStyle,
      ]}
      accessibilityRole="header"
    >
      {children as React.ReactNode}
    </Text>
  );
}

function NativeTextInput({
  style,
  placeholder,
  value,
  onChangeText,
  secureTextEntry,
  keyboardType,
  multiline,
  ...props
}: Record<string, unknown>) {
  return (
    <TextInput
      style={[
        nativeStyles.textInput,
        translateStyle(style as Record<string, unknown>) as TextStyle,
      ]}
      placeholder={placeholder as string}
      value={value as string}
      onChangeText={onChangeText as (text: string) => void}
      secureTextEntry={secureTextEntry as boolean}
      keyboardType={keyboardType as TextInput['props']['keyboardType']}
      multiline={multiline as boolean}
      {...props}
    />
  );
}

function NativeButton({
  title,
  onPress,
  disabled,
  variant,
  style,
  children,
}: Record<string, unknown>) {
  const isPrimary = variant !== 'secondary' && variant !== 'outline';
  return (
    <Pressable
      onPress={onPress as () => void}
      disabled={disabled as boolean}
      style={({ pressed }) => [
        nativeStyles.button,
        isPrimary ? nativeStyles.buttonPrimary : nativeStyles.buttonSecondary,
        pressed && { opacity: 0.8 },
        disabled ? { opacity: 0.5 } : undefined,
        translateStyle(style as Record<string, unknown>) as ViewStyle,
      ]}
      accessibilityRole="button"
    >
      <Text
        style={[
          nativeStyles.buttonText,
          isPrimary ? nativeStyles.buttonTextPrimary : nativeStyles.buttonTextSecondary,
        ]}
      >
        {(title as string) || (children as React.ReactNode)}
      </Text>
    </Pressable>
  );
}

function NativeImage({ source, src, style, alt, ...props }: Record<string, unknown>) {
  const uri = (source as { uri?: string })?.uri || (src as string);
  if (!uri) return null;
  return (
    <Image
      source={{ uri }}
      style={[nativeStyles.image, translateStyle(style as Record<string, unknown>) as ImageStyle]}
      accessibilityLabel={alt as string}
      {...props}
    />
  );
}

function NativeScrollView({ style, children, ...props }: Record<string, unknown>) {
  return (
    <ScrollView
      style={translateStyle(style as Record<string, unknown>) as ViewStyle}
      showsVerticalScrollIndicator={false}
      {...props}
    >
      {children as React.ReactNode}
    </ScrollView>
  );
}

function NativeSwitch({ value, onValueChange, ...props }: Record<string, unknown>) {
  return (
    <Switch
      value={value as boolean}
      onValueChange={onValueChange as (value: boolean) => void}
      trackColor={{ false: rnColors.gray[300], true: rnColors.primary[400] }}
      thumbColor={value ? rnColors.primary[600] : rnColors.gray[50]}
      {...props}
    />
  );
}

function NativeSeparator({ style }: Record<string, unknown>) {
  return (
    <View
      style={[
        nativeStyles.separator,
        translateStyle(style as Record<string, unknown>) as ViewStyle,
      ]}
    />
  );
}

function NativeCard({ style, children }: Record<string, unknown>) {
  return (
    <View
      style={[
        nativeStyles.card,
        translateStyle(style as Record<string, unknown>) as ViewStyle,
      ]}
    >
      {children as React.ReactNode}
    </View>
  );
}

function NativeBadge({ style, children, variant }: Record<string, unknown>) {
  const variantColors: Record<string, { bg: string; text: string }> = {
    success: { bg: rnColors.success[100], text: rnColors.success[700] },
    warning: { bg: rnColors.warning[100], text: rnColors.warning[700] },
    error: { bg: rnColors.error[100], text: rnColors.error[700] },
    info: { bg: rnColors.info[100], text: rnColors.info[700] },
    default: { bg: rnColors.gray[100], text: rnColors.gray[700] },
  };
  const colors = variantColors[(variant as string) || 'default'] || variantColors.default;
  return (
    <View
      style={[
        nativeStyles.badge,
        { backgroundColor: colors.bg },
        translateStyle(style as Record<string, unknown>) as ViewStyle,
      ]}
    >
      <Text style={[nativeStyles.badgeText, { color: colors.text }]}>
        {children as React.ReactNode}
      </Text>
    </View>
  );
}

// --- Register all built-in components ---

export function registerBuiltinComponents(): void {
  // Layout
  registerComponent('div', NativeView);
  registerComponent('View', NativeView);
  registerComponent('view', NativeView);
  registerComponent('section', NativeView);
  registerComponent('article', NativeView);
  registerComponent('main', NativeView);
  registerComponent('header', NativeView);
  registerComponent('footer', NativeView);
  registerComponent('nav', NativeView);
  registerComponent('aside', NativeView);
  registerComponent('form', NativeView);

  // Text
  registerComponent('span', NativeText);
  registerComponent('Text', NativeText);
  registerComponent('text', NativeText);
  registerComponent('p', NativeText);
  registerComponent('label', NativeText);
  registerComponent('strong', NativeText);
  registerComponent('em', NativeText);

  // Headings
  for (let i = 1; i <= 6; i++) {
    const level = i;
    registerComponent(`h${i}`, (props) => NativeHeading({ ...props, level }));
  }

  // Input
  registerComponent('input', NativeTextInput);
  registerComponent('TextInput', NativeTextInput);
  registerComponent('textarea', NativeTextInput);

  // Button
  registerComponent('button', NativeButton);
  registerComponent('Button', NativeButton);
  registerComponent('Pressable', NativeButton);

  // Image
  registerComponent('img', NativeImage);
  registerComponent('Image', NativeImage);

  // Scrolling
  registerComponent('ScrollView', NativeScrollView);

  // Toggle
  registerComponent('Switch', NativeSwitch);

  // Divider
  registerComponent('hr', NativeSeparator);
  registerComponent('separator', NativeSeparator);
  registerComponent('Separator', NativeSeparator);

  // Card
  registerComponent('card', NativeCard);
  registerComponent('Card', NativeCard);

  // Badge
  registerComponent('badge', NativeBadge);
  registerComponent('Badge', NativeBadge);
}

const nativeStyles = StyleSheet.create({
  textInput: {
    borderWidth: 1,
    borderColor: rnColors.gray[300],
    borderRadius: rnRadius.md,
    padding: rnSpacingNamed.sm,
    fontSize: rnFontSize.base,
    color: rnColors.gray[900],
    backgroundColor: '#ffffff',
    minHeight: 44,
  },
  button: {
    paddingVertical: rnSpacingNamed.sm,
    paddingHorizontal: rnSpacingNamed.md,
    borderRadius: rnRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  buttonPrimary: {
    backgroundColor: rnColors.primary[600],
  },
  buttonSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: rnColors.gray[300],
  },
  buttonText: {
    fontSize: rnFontSize.base,
    fontWeight: '600',
  },
  buttonTextPrimary: {
    color: '#ffffff',
  },
  buttonTextSecondary: {
    color: rnColors.gray[700],
  },
  image: {
    width: '100%' as unknown as number,
    height: 200,
    borderRadius: rnRadius.md,
  },
  separator: {
    height: 1,
    backgroundColor: rnColors.gray[200],
    marginVertical: rnSpacingNamed.sm,
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: rnRadius.xl,
    padding: rnSpacingNamed.md,
    ...rnShadow.md,
  },
  badge: {
    paddingHorizontal: rnSpacingNamed.sm,
    paddingVertical: 2,
    borderRadius: rnRadius.full,
    alignSelf: 'flex-start',
  },
  badgeText: {
    fontSize: rnFontSize.xs,
    fontWeight: '500',
  },
});
