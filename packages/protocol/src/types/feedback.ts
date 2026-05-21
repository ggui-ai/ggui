/**
 * UI Feedback types -- end-user ratings for generated UIs.
 *
 * Users can rate each rendered page with love/dislike/other.
 * Feedback is sent via WebSocket and stored server-side.
 */

/**
 * Feedback rating options for a generated UI page.
 */
export type FeedbackRating = 'love' | 'dislike' | 'other';

/**
 * Input payload for submitting UI feedback via WebSocket.
 */
export interface UIFeedbackPayload {
  /** Page (stack item) being rated */
  stackItemId: string;
  /** Session the page belongs to */
  sessionId: string;
  /** Rating type */
  rating: FeedbackRating;
  /** Free-text comment (required when rating is 'other', optional otherwise) */
  comment?: string;
}
