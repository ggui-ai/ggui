/**
 * Eval pairs for the rerank quality probe.
 *
 * 25 hand-built pairs. Each pair has:
 *   - A user query (intent + contract summary)
 *   - 3-5 candidates (one or zero of which is the gold match)
 *   - The gold-standard label: `goldMatchId` or `null` for no-match
 *   - `kind`: 'should-match' | 'no-match' | 'adversarial'
 *
 * Adversarial pairs (n=10) are structurally identical to a candidate
 * but differ in load-bearing intent — the judge MUST reject them. If
 * the judge accepts adversarials, the adversarial false-positive rate
 * exceeds its quality gate.
 *
 * Eval-only — not exported from the package index.
 */
import type { RerankCandidate, RerankQuery } from '../llm-rerank.js';

export interface EvalPair {
  readonly id: string;
  readonly kind: 'should-match' | 'no-match' | 'adversarial';
  readonly query: RerankQuery;
  readonly candidates: readonly RerankCandidate[];
  readonly goldMatchId: string | null;
  readonly note?: string;
}

export const EVAL_PAIRS: readonly EvalPair[] = [
  // ─── should-match: paraphrases of the same UI ───
  {
    id: 'sm-notepad-1',
    kind: 'should-match',
    query: {
      intent: 'Build a notepad with a topic select and a note textarea',
      contractSummary:
        'interaction=collect; slots=noteText,topic; actions=∅; streams=∅',
    },
    candidates: [
      {
        id: 'bp-notepad',
        cachedIntent: 'Live notepad panel — topic enum + textarea — context-mirrored',
        cachedContractSummary:
          'interaction=collect; slots=noteText,topic; actions=∅; streams=∅',
        cosine: 0.92,
      },
      {
        id: 'bp-todo',
        cachedIntent: 'Todo list with add/remove items',
        cachedContractSummary:
          'interaction=collect; slots=items; actions=add,remove; streams=∅',
        cosine: 0.41,
      },
    ],
    goldMatchId: 'bp-notepad',
  },
  {
    id: 'sm-feedback-1',
    kind: 'should-match',
    query: {
      intent: 'Form to gather user feedback with a 5-star rating and a free-text comment',
      contractSummary:
        'interaction=collect; slots=∅; actions=submit; streams=∅; props=comment,rating',
    },
    candidates: [
      {
        id: 'bp-rate-comment',
        cachedIntent: 'Rate-and-comment feedback form — five-star rating, comment box, submit button',
        cachedContractSummary:
          'interaction=collect; slots=∅; actions=submit; streams=∅; props=comment,rating',
        cosine: 0.88,
      },
      {
        id: 'bp-survey',
        cachedIntent: 'Multi-step survey with NPS + open-ended question + tags',
        cachedContractSummary:
          'interaction=collect; slots=∅; actions=next,prev,submit; streams=∅; props=nps,openText,tags',
        cosine: 0.55,
      },
      {
        id: 'bp-login',
        cachedIntent: 'Login form with email + password',
        cachedContractSummary:
          'interaction=collect; slots=∅; actions=submit; streams=∅; props=email,password',
        cosine: 0.31,
      },
    ],
    goldMatchId: 'bp-rate-comment',
  },
  {
    id: 'sm-weather-1',
    kind: 'should-match',
    query: {
      intent: 'Weather card showing current conditions for Tokyo',
      contractSummary:
        'interaction=display; slots=∅; actions=∅; streams=∅; props=city,conditions,temp',
    },
    candidates: [
      {
        id: 'bp-weather',
        cachedIntent: 'Current weather widget — city name, temp, conditions',
        cachedContractSummary:
          'interaction=display; slots=∅; actions=∅; streams=∅; props=city,conditions,temp',
        cosine: 0.95,
      },
      {
        id: 'bp-stock',
        cachedIntent: 'Stock ticker — symbol + price',
        cachedContractSummary:
          'interaction=display; slots=∅; actions=∅; streams=∅; props=price,symbol',
        cosine: 0.45,
      },
    ],
    goldMatchId: 'bp-weather',
  },
  {
    id: 'sm-todo-1',
    kind: 'should-match',
    query: {
      intent: 'Todo list — user can add items, mark them complete, remove them',
      contractSummary:
        'interaction=collect; slots=items; actions=add,remove,toggle; streams=∅',
    },
    candidates: [
      {
        id: 'bp-todo-mvc',
        cachedIntent: 'Classic todo MVC — add input, items list with checkboxes, delete buttons',
        cachedContractSummary:
          'interaction=collect; slots=items; actions=add,remove,toggle; streams=∅',
        cosine: 0.91,
      },
      {
        id: 'bp-shopping',
        cachedIntent: 'Shopping cart with quantity + checkout',
        cachedContractSummary:
          'interaction=collect; slots=cart; actions=add,checkout,remove,setQty; streams=∅',
        cosine: 0.62,
      },
    ],
    goldMatchId: 'bp-todo-mvc',
  },
  {
    id: 'sm-search-1',
    kind: 'should-match',
    query: {
      intent: 'Search bar with autocomplete — typing suggests options live',
      contractSummary:
        'interaction=collect; slots=query; actions=select; streams=suggestions',
    },
    candidates: [
      {
        id: 'bp-autocomplete',
        cachedIntent: 'Search input with live-suggestion dropdown',
        cachedContractSummary:
          'interaction=collect; slots=query; actions=select; streams=suggestions',
        cosine: 0.94,
      },
      {
        id: 'bp-filter',
        cachedIntent: 'Filter panel with multi-select facets',
        cachedContractSummary:
          'interaction=collect; slots=filters; actions=apply,clear; streams=∅',
        cosine: 0.48,
      },
    ],
    goldMatchId: 'bp-autocomplete',
  },
  {
    id: 'sm-chat-1',
    kind: 'should-match',
    query: {
      intent: 'Chat interface — message list, input box, send button',
      contractSummary:
        'interaction=converse; slots=draft; actions=send; streams=messages',
    },
    candidates: [
      {
        id: 'bp-chat',
        cachedIntent: 'Chat panel — scrolling message list, composer textarea, send action',
        cachedContractSummary:
          'interaction=converse; slots=draft; actions=send; streams=messages',
        cosine: 0.93,
      },
      {
        id: 'bp-comments',
        cachedIntent: 'Comments thread with replies',
        cachedContractSummary:
          'interaction=converse; slots=draft; actions=post,reply; streams=messages',
        cosine: 0.7,
      },
    ],
    goldMatchId: 'bp-chat',
  },
  {
    id: 'sm-dashboard-1',
    kind: 'should-match',
    query: {
      intent: 'Dashboard with KPI cards — revenue, users, churn',
      contractSummary:
        'interaction=display; slots=∅; actions=∅; streams=∅; props=churn,revenue,users',
    },
    candidates: [
      {
        id: 'bp-kpi',
        cachedIntent: 'KPI dashboard — revenue card, user count card, churn percent',
        cachedContractSummary:
          'interaction=display; slots=∅; actions=∅; streams=∅; props=churn,revenue,users',
        cosine: 0.93,
      },
      {
        id: 'bp-table',
        cachedIntent: 'Data table with sortable columns',
        cachedContractSummary:
          'interaction=display; slots=∅; actions=sort; streams=∅; props=columns,rows',
        cosine: 0.42,
      },
    ],
    goldMatchId: 'bp-kpi',
  },
  {
    id: 'sm-settings-1',
    kind: 'should-match',
    query: {
      intent: 'Settings page with toggles for notifications, dark mode, autoplay',
      contractSummary:
        'interaction=collect; slots=autoplay,darkMode,notifications; actions=∅; streams=∅',
    },
    candidates: [
      {
        id: 'bp-settings',
        cachedIntent: 'User preferences panel — notification toggle, theme toggle, autoplay toggle',
        cachedContractSummary:
          'interaction=collect; slots=autoplay,darkMode,notifications; actions=∅; streams=∅',
        cosine: 0.9,
      },
      {
        id: 'bp-profile',
        cachedIntent: 'Profile edit form — name, email, avatar',
        cachedContractSummary:
          'interaction=collect; slots=∅; actions=save; streams=∅; props=avatar,email,name',
        cosine: 0.5,
      },
    ],
    goldMatchId: 'bp-settings',
  },
  {
    id: 'sm-modal-1',
    kind: 'should-match',
    query: {
      intent: 'Confirmation modal — "Delete this item?" with Cancel and Delete buttons',
      contractSummary:
        'interaction=approve; slots=∅; actions=cancel,confirm; streams=∅; props=message,title',
    },
    candidates: [
      {
        id: 'bp-confirm',
        cachedIntent: 'Confirmation dialog — title, message, two buttons (cancel + confirm)',
        cachedContractSummary:
          'interaction=approve; slots=∅; actions=cancel,confirm; streams=∅; props=message,title',
        cosine: 0.94,
      },
      {
        id: 'bp-alert',
        cachedIntent: 'Alert banner with single dismiss button',
        cachedContractSummary:
          'interaction=approve; slots=∅; actions=dismiss; streams=∅; props=message',
        cosine: 0.6,
      },
    ],
    goldMatchId: 'bp-confirm',
  },
  {
    id: 'sm-onboarding-1',
    kind: 'should-match',
    query: {
      intent: 'Multi-step onboarding wizard — welcome, profile, preferences, finish',
      contractSummary:
        'interaction=flow; slots=currentStep; actions=back,next,skip; streams=∅',
    },
    candidates: [
      {
        id: 'bp-wizard',
        cachedIntent: 'Step-by-step wizard with progress indicator',
        cachedContractSummary:
          'interaction=flow; slots=currentStep; actions=back,next,skip; streams=∅',
        cosine: 0.89,
      },
      {
        id: 'bp-stepper',
        cachedIntent: 'Linear stepper for checkout',
        cachedContractSummary:
          'interaction=flow; slots=step; actions=back,next; streams=∅',
        cosine: 0.78,
      },
    ],
    goldMatchId: 'bp-wizard',
  },

  // ─── no-match: queries with no good fit in candidates ───
  {
    id: 'nm-novel-1',
    kind: 'no-match',
    query: {
      intent: 'Periodic table viewer with hoverable element details',
      contractSummary:
        'interaction=display; slots=∅; actions=hover; streams=∅; props=elements',
    },
    candidates: [
      {
        id: 'bp-todo',
        cachedIntent: 'Todo list',
        cachedContractSummary:
          'interaction=collect; slots=items; actions=add,remove; streams=∅',
        cosine: 0.32,
      },
      {
        id: 'bp-form',
        cachedIntent: 'Generic form with text inputs',
        cachedContractSummary:
          'interaction=collect; slots=∅; actions=submit; streams=∅; props=fields',
        cosine: 0.28,
      },
    ],
    goldMatchId: null,
  },
  {
    id: 'nm-novel-2',
    kind: 'no-match',
    query: {
      intent: 'Code editor with syntax highlighting and line numbers',
      contractSummary:
        'interaction=collect; slots=code; actions=run; streams=output',
    },
    candidates: [
      {
        id: 'bp-notepad',
        cachedIntent: 'Plain notepad — single textarea, no syntax highlighting',
        cachedContractSummary:
          'interaction=collect; slots=text; actions=∅; streams=∅',
        cosine: 0.55,
      },
      {
        id: 'bp-search',
        cachedIntent: 'Search bar with autocomplete',
        cachedContractSummary:
          'interaction=collect; slots=query; actions=select; streams=suggestions',
        cosine: 0.3,
      },
    ],
    goldMatchId: null,
    note: 'notepad shares "type into a textarea" but lacks syntax/run/output — should not match',
  },
  {
    id: 'nm-novel-3',
    kind: 'no-match',
    query: {
      intent: 'Map view showing user location with nearby points of interest',
      contractSummary:
        'interaction=display; slots=∅; actions=panTo,zoom; streams=pois; props=center,zoom',
    },
    candidates: [
      {
        id: 'bp-list',
        cachedIntent: 'Generic list view',
        cachedContractSummary:
          'interaction=display; slots=∅; actions=∅; streams=∅; props=items',
        cosine: 0.36,
      },
    ],
    goldMatchId: null,
  },
  {
    id: 'nm-novel-4',
    kind: 'no-match',
    query: {
      intent: 'File uploader with drag-and-drop and progress bars',
      contractSummary:
        'interaction=collect; slots=files; actions=cancel,upload; streams=progress',
    },
    candidates: [
      {
        id: 'bp-form',
        cachedIntent: 'Login form',
        cachedContractSummary:
          'interaction=collect; slots=∅; actions=submit; streams=∅; props=email,password',
        cosine: 0.25,
      },
      {
        id: 'bp-feedback',
        cachedIntent: 'Feedback form',
        cachedContractSummary:
          'interaction=collect; slots=∅; actions=submit; streams=∅; props=comment,rating',
        cosine: 0.3,
      },
    ],
    goldMatchId: null,
  },
  {
    id: 'nm-novel-5',
    kind: 'no-match',
    query: {
      intent: 'Audio player with play/pause, seek, volume',
      contractSummary:
        'interaction=collect; slots=position; actions=pause,play,seek,setVolume; streams=∅',
    },
    candidates: [
      {
        id: 'bp-todo',
        cachedIntent: 'Todo list',
        cachedContractSummary:
          'interaction=collect; slots=items; actions=add,remove; streams=∅',
        cosine: 0.22,
      },
    ],
    goldMatchId: null,
  },

  // ─── adversarial: structurally identical, intent-divergent ───
  {
    id: 'ad-haiku-vs-tweet',
    kind: 'adversarial',
    query: {
      intent: 'Haiku composer with serif font and seasonal-mood placeholder',
      contractSummary: 'interaction=collect; slots=text; actions=∅; streams=∅',
    },
    candidates: [
      {
        id: 'bp-tweet-draft',
        cachedIntent: 'Tweet draft composer with character count and 280-char limit',
        cachedContractSummary:
          'interaction=collect; slots=text; actions=∅; streams=∅',
        cosine: 0.82,
      },
    ],
    goldMatchId: null,
    note: 'identical contract surface but the user intent is a HAIKU (visual style + framing matters)',
  },
  {
    id: 'ad-calendar-jan-vs-mar',
    kind: 'adversarial',
    query: {
      intent: 'Calendar showing March 2026 with selectable dates',
      contractSummary:
        'interaction=collect; slots=selectedDate; actions=∅; streams=∅; props=month,year',
    },
    candidates: [
      {
        id: 'bp-calendar-jan',
        cachedIntent: 'Calendar showing January 2026 with selectable dates',
        cachedContractSummary:
          'interaction=collect; slots=selectedDate; actions=∅; streams=∅; props=month,year',
        cosine: 0.96,
      },
    ],
    goldMatchId: null,
    note: 'load-bearing parameter (month) differs — generated UI would show wrong month',
  },
  {
    id: 'ad-login-vs-signup',
    kind: 'adversarial',
    query: {
      intent: 'Sign-up form for new account — email, password, confirm password, terms checkbox',
      contractSummary:
        'interaction=collect; slots=∅; actions=submit; streams=∅; props=confirmPassword,email,password,termsAccepted',
    },
    candidates: [
      {
        id: 'bp-login',
        cachedIntent: 'Login form — email + password fields, submit button',
        cachedContractSummary:
          'interaction=collect; slots=∅; actions=submit; streams=∅; props=email,password',
        cosine: 0.85,
      },
    ],
    goldMatchId: null,
    note: 'similar contract but signup needs confirmPassword + terms — login UI would miss them',
  },
  {
    id: 'ad-chat-vs-comments',
    kind: 'adversarial',
    query: {
      intent: 'Comments thread under a blog post — flat list, post a reply, no real-time',
      contractSummary:
        'interaction=converse; slots=draft; actions=post; streams=∅',
    },
    candidates: [
      {
        id: 'bp-chat',
        cachedIntent: 'Real-time chat panel with WebSocket-driven message stream',
        cachedContractSummary:
          'interaction=converse; slots=draft; actions=send; streams=messages',
        cosine: 0.79,
      },
    ],
    goldMatchId: null,
    note: 'chat has streamSpec.messages — comments do not. Different liveness model.',
  },
  {
    id: 'ad-light-vs-dark',
    kind: 'adversarial',
    query: {
      intent: 'Dashboard with metrics — render in dark mode for night ops use',
      contractSummary:
        'interaction=display; slots=∅; actions=∅; streams=∅; props=metrics',
    },
    candidates: [
      {
        id: 'bp-dashboard-light',
        cachedIntent: 'Marketing dashboard for executive review — bright, ornate, colorful KPI cards',
        cachedContractSummary:
          'interaction=display; slots=∅; actions=∅; streams=∅; props=metrics',
        cosine: 0.78,
      },
    ],
    goldMatchId: 'bp-dashboard-light',
    note: 'visual style alone (dark vs light) is NOT load-bearing per spec — should match',
    // NOTE: this is actually a should-match disguised as adversarial — verifies
    // the judge doesn't over-reject on cosmetic style. If precision drops here,
    // the prompt is over-strict.
  },
  {
    id: 'ad-form-fields-different',
    kind: 'adversarial',
    query: {
      intent: 'Contact form — name, email, message, subject',
      contractSummary:
        'interaction=collect; slots=∅; actions=submit; streams=∅; props=email,message,name,subject',
    },
    candidates: [
      {
        id: 'bp-feedback',
        cachedIntent: 'Feedback form with rating + comment',
        cachedContractSummary:
          'interaction=collect; slots=∅; actions=submit; streams=∅; props=comment,rating',
        cosine: 0.7,
      },
    ],
    goldMatchId: null,
    note: 'different fields (name/email/message/subject vs rating/comment) — different UI',
  },
  {
    id: 'ad-step-count',
    kind: 'adversarial',
    query: {
      intent: '5-step onboarding wizard — welcome, profile, preferences, integrations, finish',
      contractSummary:
        'interaction=flow; slots=currentStep; actions=back,next,skip; streams=∅; props=stepCount',
    },
    candidates: [
      {
        id: 'bp-3step-wizard',
        cachedIntent: '3-step setup wizard — name, plan, payment',
        cachedContractSummary:
          'interaction=flow; slots=currentStep; actions=back,next,skip; streams=∅; props=stepCount',
        cosine: 0.86,
      },
    ],
    goldMatchId: null,
    note: 'step count + step contents differ — wizard reuse forces wrong step labels',
  },
  {
    id: 'ad-list-vs-grid',
    kind: 'adversarial',
    query: {
      intent: 'Photo grid view — 3 columns, lightbox on click',
      contractSummary:
        'interaction=display; slots=∅; actions=open; streams=∅; props=items',
    },
    candidates: [
      {
        id: 'bp-list',
        cachedIntent: 'Linear text list with one item per row',
        cachedContractSummary:
          'interaction=display; slots=∅; actions=open; streams=∅; props=items',
        cosine: 0.72,
      },
    ],
    goldMatchId: null,
    note: 'grid vs list is a layout/visual difference — but a photo grid + lightbox is a different UI',
  },
  {
    id: 'ad-prop-types',
    kind: 'adversarial',
    query: {
      intent: 'Inventory table — columns: SKU, name, quantity, price, last-restocked',
      contractSummary:
        'interaction=display; slots=∅; actions=sort; streams=∅; props=columns,rows',
    },
    candidates: [
      {
        id: 'bp-user-table',
        cachedIntent: 'User directory table — columns: name, email, role, last-login',
        cachedContractSummary:
          'interaction=display; slots=∅; actions=sort; streams=∅; props=columns,rows',
        cosine: 0.84,
      },
    ],
    goldMatchId: null,
    note: 'same shape (sortable table) but the columns are different domain data — reuse misleads',
  },
  {
    id: 'ad-default-vs-explicit',
    kind: 'adversarial',
    query: {
      intent: 'Calculator with scientific functions — sin, cos, tan, log, exp, sqrt, pi',
      contractSummary:
        'interaction=collect; slots=display; actions=clear,evaluate,press; streams=∅',
    },
    candidates: [
      {
        id: 'bp-basic-calc',
        cachedIntent: 'Basic calculator — digits, +, -, ×, ÷, =, clear',
        cachedContractSummary:
          'interaction=collect; slots=display; actions=clear,evaluate,press; streams=∅',
        cosine: 0.9,
      },
    ],
    goldMatchId: null,
    note: 'same contract but scientific calc has way more buttons — basic-calc UI insufficient',
  },
];

export function pairsByKind(kind: EvalPair['kind']): readonly EvalPair[] {
  return EVAL_PAIRS.filter((p) => p.kind === kind);
}
