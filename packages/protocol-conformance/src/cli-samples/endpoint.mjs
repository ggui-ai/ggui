/**
 * Sample `--transport-projector` module: the per-app endpoint's answer
 * to a refusal — `{ httpStatus, error }` for a code that has a transport
 * envelope, `null` for one that does not. A default export is accepted
 * in place of a named `project`.
 */
export default function project(refusal) {
  if (refusal.code !== "app_deprovisioned") return null;
  return {
    httpStatus: 403,
    error: { code: -32003, message: "App not found", data: { refusal } },
  };
}
