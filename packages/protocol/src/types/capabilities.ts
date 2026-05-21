/**
 * Component capability permissions and quality metadata.
 *
 * Components run in a sandboxed context with all capabilities denied by default.
 * Capabilities can be granted by the app developer (per-app) or by the end-user (per-session).
 */

// =============================================================================
// Component Capabilities
// =============================================================================

/**
 * Software capabilities that can be granted to sandboxed components.
 *
 * Hardware access flows through gadget hooks (`clientCapabilities.gadgets`)
 * — each gadget descriptor declares a `permission` that threads to the
 * iframe's `Permissions-Policy` header. There is no separate
 * `adapters[]` model.
 */
export type ComponentCapability =
  | 'network'    // fetch(), XMLHttpRequest, WebSocket
  | 'storage'    // localStorage, sessionStorage, cookies
  | 'dom'        // document.*, innerHTML, dangerouslySetInnerHTML
  | 'eval'       // eval(), Function(), dynamic import()
  | 'navigation' // location.*, history.*
  | 'device';    // navigator.* (device info)

/**
 * Capability permissions for a component.
 * Default posture: all capabilities denied (granted: []).
 */
export interface CapabilityPermissions {
  /** Capabilities this component is allowed to use. Default: [] (all denied) */
  granted: ComponentCapability[];
}

// =============================================================================
// Quality Metadata
// =============================================================================

/**
 * Quality evaluation metadata attached to produced components.
 * Producers MAY attach quality scores. Renderers MAY display quality indicators.
 */
export interface QualityMetadata {
  evaluationRounds: number;
  finalScore: number; // 0-100
  dimensions: {
    completeness: number;
    visualPolish: number;
    interactivity: number;
    accessibility: number;
    codeQuality: number;
  };
  passed: boolean;
}

// =============================================================================
// Hardware grant model
// =============================================================================
//
// Hardware-capability hooks (camera, microphone, geolocation, etc.) flow
// through the gadget catalog at `DataContract.clientCapabilities.gadgets`.
// Each gadget descriptor declares a `permission` field whose value is the
// Web Permissions API name (`KNOWN_PERMISSION_NAMES`); the server projects
// every declared permission onto the iframe's `Permissions-Policy` header.
//
// There is no `adapters[]` allow-list (voice / camera / location /
// bluetooth). Per-gadget permission threading IS the grant model.
