/**
 * Every event the live-channel transports log through a {@link ChannelLogger} (#1383). One list, so a renamed or new
 * event is a changed list rather than a new free string: the logger methods take this list's union, and a test pins
 * that the list is exactly what the transports log. A card's telemetry sends each name as a health event with no
 * detail (the name is the signal: which transport failed), and a host that admits only a closed set of names checks
 * against the same list.
 */
export const CHANNEL_LOG_EVENTS = [
  'channel_failover_send_dropped_post_swap',
  'channel_failover_swap',
  'channel_handler_throw',
  'channel_polling_budget_exhausted',
  'channel_polling_fetch_failed',
  'channel_polling_invalid_carrier',
  'channel_polling_no_fetch',
  'channel_polling_no_handler',
  'channel_polling_non_ok',
  'channel_polling_parse_failed',
  'channel_sse_construct_failed',
  'channel_sse_fail_fast',
  'channel_sse_watchdog_expired',
  'channel_status_listener_throw',
  'channel_ws_construct_failed',
  'channel_ws_fail_fast',
  'channel_ws_refused_terminal',
  'channel_ws_send_failed',
  'channel_ws_subscribe_send_failed',
] as const;

/** One of the transports' log events. */
export type ChannelLogEvent = (typeof CHANNEL_LOG_EVENTS)[number];
