/**
 * Manifest-capabilities fixture blueprint source.
 *
 * Paired with the colocated `ggui.ui.json` manifest. Declared in the
 * fixture's `ggui.json#blueprints.include` glob so `LocalUiRegistry`
 * (from `@ggui-ai/dev-stack`) discovers the id + compile-on-demands
 * this file via esbuild when `ggui_render_blueprint` is invoked.
 *
 * Keep the component trivial — the render happy-path assertion only
 * checks that the compile produces non-empty JS + the wire carries it
 * back. Any valid TSX with a default export works; the shape used
 * below gives the E2E spec a distinctive DOM anchor it can match.
 */
export default function WeatherCardFixture(): JSX.Element {
  return (
    <article data-testid="weather-card-fixture">
      <h1>Weather Card Fixture</h1>
      <p>Rendered from a manifest-registered blueprint.</p>
    </article>
  );
}
