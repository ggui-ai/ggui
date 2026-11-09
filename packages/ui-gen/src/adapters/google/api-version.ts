// packages/ui-gen/src/adapters/google/api-version.ts
//
// The Gemini Developer API version every @google/genai client in ui-gen is
// constructed with. Pinned rather than inherited: @google/genai 3.0 moves its
// default from 'v1beta' to 'v1', and the Interactions API plus the model ids
// routed here are verified on 'v1beta'. Moving to 'v1' is a deliberate change
// made here, after verifying both on that version.
export const GEMINI_API_VERSION = 'v1beta';
