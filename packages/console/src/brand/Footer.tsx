/**
 * `Footer` — brand-kit bottom lockup.
 *
 * Two columns on wide viewports, stacked on narrow. Left: compact
 * meta block (long-form + short-form name, version chip, package
 * attribution). Right: small wordmark for visual rhyme with the hero.
 * Uppercase is intentionally banned for both forms per kit §10 /
 * Naming rule 01.
 */
import type { ReactElement } from 'react';
import { Wordmark } from '../routes/Wordmark.js';

export function Footer(): ReactElement {
  return (
    <footer className="ggui-footer">
      <div className="ggui-footer__inner">
        <div className="ggui-footer__meta">
          <div>
            <strong>ggui</strong> — generative graphical user interface
          </div>
          <div>@ggui-ai/console</div>
          <div>served by your local ggui serve — same origin only</div>
        </div>
        <div className="ggui-footer__mark">
          <Wordmark width={160} />
        </div>
      </div>
    </footer>
  );
}
