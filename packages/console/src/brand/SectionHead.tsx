/**
 * `SectionHead` — brand-kit §01–§10 section heading.
 *
 * A 100px left rail stamps the numbered mono eyebrow ("02 / Pairing");
 * the right rail carries a title + optional intro paragraph + muted
 * tail text. Titles split a bold lead from a muted tail, mirroring the
 * kit's "headline. <mute>continuation.</mute>" pattern.
 */
import type { ReactElement, ReactNode } from 'react';

export interface SectionHeadProps {
  /** Numbered eyebrow, e.g. `"02"` or `"02 / Pairing"`. Uppercased by CSS. */
  readonly num: string;
  /** Primary title (bold, ink). */
  readonly title: ReactNode;
  /** Optional muted tail appended to `title` on the same line. */
  readonly mute?: ReactNode;
  /** Optional paragraph under the title. */
  readonly intro?: ReactNode;
}

export function SectionHead({
  num,
  title,
  mute,
  intro,
}: SectionHeadProps): ReactElement {
  return (
    <header className="ggui-section__head">
      <div className="ggui-section__num">{num}</div>
      <div>
        <h2 className="ggui-section__title">
          {title}
          {mute ? <span className="ggui-mute"> {mute}</span> : null}
        </h2>
        {intro ? <p className="ggui-section__intro">{intro}</p> : null}
      </div>
    </header>
  );
}
