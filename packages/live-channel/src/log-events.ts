/**
 * Every event the live-channel transports log through a {@link ChannelLogger} (#1383). One list, so a renamed or new
 * event is a changed list rather than a new free string: the logger methods take this list's union, and a test pins
 * that the list is exactly what the transports log. A card's telemetry sends each name as a health event with no
 * detail (the name is the signal: which transport failed), and a host that admits only a closed set of names checks
 * against the same list.
 *
 * The source of truth is `@ggui-ai/protocol/runtime-telemetry` (ggui#1381), beside the rest of the telemetry
 * vocabulary, so the emitter and a host's door import one list. This package re-exports it because it is its own
 * logger's parameter type, not a copy.
 */
export { CHANNEL_LOG_EVENTS, type ChannelLogEvent } from '@ggui-ai/protocol/runtime-telemetry';
