/**
 * GguiNavigator — Android-style bottom nav bar for React Native.
 *
 * Uses simple text/unicode icons to avoid requiring @expo/vector-icons
 * as a dependency in the gadget package. Consumers can pass a custom
 * renderItem if they want richer icons.
 *
 * Uses Animated for the stack overview slide-up and FlatList for
 * performant scrolling.
 */

import React, { useCallback, useRef, useEffect, type ReactNode } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  Animated,
  StyleSheet,
  Dimensions,
} from 'react-native';
import type { StackItem } from '@ggui-ai/protocol';
import type { BridgeEvent } from './WebViewRenderer';
import { StackItemRenderer } from './DynamicComponent';
import { useStackNavigation } from '../hooks/useStackNavigation';
import type { UseStackNavigationOptions } from '../hooks/useStackNavigation';
import { useTheme } from '../theme';

export interface GguiNavigatorProps {
  /** Stack items from GguiSession */
  stack: StackItem[];
  /** Navigation options (e.g., autoFollow) */
  navigationOptions?: UseStackNavigationOptions;
  /** Custom renderer for a stack item */
  renderItem?: (item: StackItem, index: number) => ReactNode;
  /** Content shown when the stack is empty */
  emptyState?: ReactNode;
  /** Error handler for render errors */
  onError?: (error: Error) => void;
  /** Bridge event handler (for WebView events) */
  onEvent?: (event: BridgeEvent) => void;
  /** Callback when the user navigates to a different item */
  onNavigate?: (index: number, item: StackItem) => void;
  /** Whether to show the bottom nav bar (default: true) */
  showNavBar?: boolean;
}

const NAV_BAR_HEIGHT = 56;
const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const OVERVIEW_MAX_HEIGHT = SCREEN_HEIGHT * 0.5;

export function GguiNavigator({
  stack,
  navigationOptions,
  renderItem,
  emptyState,
  onError,
  onEvent,
  onNavigate,
  showNavBar = true,
}: GguiNavigatorProps) {
  const theme = useTheme();
  const nav = useStackNavigation(stack, navigationOptions);
  const slideAnim = useRef(new Animated.Value(0)).current;

  // Animate the overview panel slide
  useEffect(() => {
    Animated.timing(slideAnim, {
      toValue: nav.overviewOpen ? 1 : 0,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [nav.overviewOpen, slideAnim]);

  const handleGoToIndex = useCallback(
    (index: number) => {
      nav.goToIndex(index);
      const item = stack[index];
      if (item && onNavigate) onNavigate(index, item);
    },
    [nav, stack, onNavigate],
  );

  const handleGoHome = useCallback(() => {
    nav.goHome();
    const item = stack[0];
    if (item && onNavigate) onNavigate(0, item);
  }, [nav, stack, onNavigate]);

  const handleGoBack = useCallback(() => {
    if (!nav.canGoBack) return;
    const newIndex = nav.currentIndex - 1;
    nav.goBack();
    const item = stack[newIndex];
    if (item && onNavigate) onNavigate(newIndex, item);
  }, [nav, stack, onNavigate]);

  const { currentItem, currentIndex, stackLength } = nav;

  // Empty state
  if (stack.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.contentArea}>
          {emptyState ?? (
            <View style={styles.emptyState}>
              <Text style={[styles.emptyIcon, { color: theme.semantic.textMuted }]}>
                {'\u25A6'}
              </Text>
              <Text style={[styles.emptyText, { color: theme.semantic.textMuted }]}>
                No items in stack
              </Text>
            </View>
          )}
        </View>
      </View>
    );
  }

  const translateY = slideAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [OVERVIEW_MAX_HEIGHT, 0],
  });

  const backdropOpacity = slideAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.3],
  });

  return (
    <View style={styles.container}>
      {/* Content area — renders the current stack item */}
      <View style={styles.contentArea}>
        {currentItem ? (
          renderItem ? (
            renderItem(currentItem, currentIndex)
          ) : currentItem.error ? (
            <View style={styles.itemError}>
              <Text style={[styles.errorIcon, { color: theme.semantic.error }]}>
                {'\u26A0'}
              </Text>
              <Text style={[styles.itemErrorText, { color: theme.semantic.error }]}>
                {currentItem.error}
              </Text>
            </View>
          ) : (
            <StackItemRenderer
              stackItem={currentItem}
              onEvent={onEvent}
              onError={onError}
            />
          )
        ) : null}
      </View>

      {/* Stack overview overlay */}
      {nav.overviewOpen && (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={nav.closeOverview}
        >
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: '#000', opacity: backdropOpacity },
            ]}
          />
        </Pressable>
      )}

      {nav.overviewOpen && (
        <Animated.View
          style={[
            styles.overviewPanel,
            {
              backgroundColor: theme.semantic.bgPrimary,
              borderTopColor: theme.semantic.borderLight,
              maxHeight: OVERVIEW_MAX_HEIGHT,
              bottom: NAV_BAR_HEIGHT,
              transform: [{ translateY }],
            },
          ]}
        >
          <View style={[styles.overviewHeader, { borderBottomColor: theme.semantic.borderLight }]}>
            <Text style={[styles.overviewHeaderText, { color: theme.semantic.textSecondary }]}>
              Stack ({stackLength} items)
            </Text>
          </View>
          <FlatList
            data={stack}
            keyExtractor={(item) => item.id}
            renderItem={({ item, index }) => {
              const isActive = index === currentIndex;
              return (
                <Pressable
                  style={[
                    styles.overviewItem,
                    {
                      borderBottomColor: theme.semantic.borderLight,
                      backgroundColor: isActive
                        ? theme.colors.primary['50'] ?? '#f0f9ff'
                        : 'transparent',
                    },
                  ]}
                  onPress={() => handleGoToIndex(index)}
                >
                  <View
                    style={[
                      styles.overviewIndex,
                      {
                        backgroundColor: isActive
                          ? theme.colors.primary['600'] ?? '#0284c7'
                          : theme.semantic.bgTertiary,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.overviewIndexText,
                        {
                          color: isActive
                            ? theme.colors.white
                            : theme.semantic.textSecondary,
                        },
                      ]}
                    >
                      {index + 1}
                    </Text>
                  </View>
                  <View style={styles.overviewPromptContainer}>
                    <Text
                      style={[styles.overviewPrompt, { color: theme.semantic.textPrimary }]}
                      numberOfLines={2}
                    >
                      {item.prompt || `Item ${index + 1}`}
                    </Text>
                    {item.error && (
                      <Text style={[styles.overviewErrorHint, { color: theme.semantic.error }]}>
                        (error)
                      </Text>
                    )}
                  </View>
                </Pressable>
              );
            }}
          />
        </Animated.View>
      )}

      {/* Bottom nav bar */}
      {showNavBar && stackLength > 0 && (
        <View
          style={[
            styles.navBar,
            {
              backgroundColor: theme.semantic.bgPrimary,
              borderTopColor: theme.semantic.borderLight,
            },
          ]}
        >
          {/* Stack button */}
          <Pressable style={styles.navButton} onPress={nav.toggleOverview}>
            <View style={styles.navIconContainer}>
              <Text style={[styles.navIcon, { color: theme.semantic.textSecondary }]}>
                {'\u2261'}
              </Text>
              {stackLength > 1 && (
                <View style={[styles.badge, { backgroundColor: theme.colors.primary['600'] ?? '#0284c7' }]}>
                  <Text style={styles.badgeText}>{stackLength}</Text>
                </View>
              )}
            </View>
            <Text style={[styles.navLabel, { color: theme.semantic.textSecondary }]}>Stack</Text>
          </Pressable>

          {/* Home button + position text */}
          <Pressable
            style={[styles.navButton, nav.isHome && styles.navButtonDisabled]}
            onPress={handleGoHome}
            disabled={nav.isHome}
          >
            <Text
              style={[
                styles.navIcon,
                { color: nav.isHome ? theme.semantic.disabled : theme.semantic.textSecondary },
              ]}
            >
              {'\u2302'}
            </Text>
            <Text style={[styles.positionText, { color: theme.semantic.textMuted }]}>
              {currentIndex + 1} of {stackLength}
            </Text>
          </Pressable>

          {/* Back button */}
          <Pressable
            style={[styles.navButton, !nav.canGoBack && styles.navButtonDisabled]}
            onPress={handleGoBack}
            disabled={!nav.canGoBack}
          >
            <Text
              style={[
                styles.navIcon,
                { color: nav.canGoBack ? theme.semantic.textSecondary : theme.semantic.disabled },
              ]}
            >
              {'\u2190'}
            </Text>
            <Text
              style={[
                styles.navLabel,
                { color: nav.canGoBack ? theme.semantic.textSecondary : theme.semantic.disabled },
              ]}
            >
              Back
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentArea: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    padding: 32,
  },
  emptyIcon: {
    fontSize: 40,
  },
  emptyText: {
    fontSize: 15,
    textAlign: 'center',
  },
  itemError: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    padding: 32,
  },
  errorIcon: {
    fontSize: 32,
  },
  itemErrorText: {
    fontSize: 14,
    textAlign: 'center',
  },
  overviewPanel: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderTopWidth: 1,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    zIndex: 30,
    elevation: 10,
  },
  overviewHeader: {
    padding: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  overviewHeaderText: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  overviewItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  overviewIndex: {
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 1,
  },
  overviewIndexText: {
    fontSize: 11,
    fontWeight: '600',
  },
  overviewPromptContainer: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 4,
  },
  overviewPrompt: {
    fontSize: 13,
    lineHeight: 18,
    flex: 1,
  },
  overviewErrorHint: {
    fontSize: 11,
  },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    height: NAV_BAR_HEIGHT,
    borderTopWidth: 1,
  },
  navButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    paddingHorizontal: 16,
    gap: 2,
  },
  navButtonDisabled: {
    opacity: 0.35,
  },
  navIconContainer: {
    position: 'relative',
  },
  navIcon: {
    fontSize: 22,
    lineHeight: 26,
    textAlign: 'center',
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -10,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '600',
  },
  navLabel: {
    fontSize: 10,
    fontWeight: '500',
  },
  positionText: {
    fontSize: 10,
    fontWeight: '500',
  },
});
