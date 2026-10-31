import type { BenchmarkMeta } from '@ggui-ai/shared';
import type { CommitSummary } from '../types';
import { formatJudge } from '../format';
import { rawDataIndexHref } from '../data-source';

interface Props {
  /**
   * Report meta — carries the judge panel disclosure. Optional so the
   * static methodology renders before/without a loaded report; the
   * judge-panel line fills in once a report is present.
   */
  meta?: BenchmarkMeta;
  /**
   * The run's corpus — one entry per prompt/commit. Optional for the
   * same reason; the corpus list renders only when a report is loaded.
   */
  commits?: CommitSummary[];
  /**
   * Base the reader-facing "raw data" link resolves against — the directory
   * holding index.json and the per-day reports, absolute or root-relative
   * (`/data/`), with a trailing slash. When provided, the link is rendered.
   * Omitted → no link.
   */
  rawDataUrl?: string;
}

/**
 * The 5 aesthetic dimensions the judge panel scores, with the definitions
 * transcribed verbatim from `AESTHETIC_EVAL_PROMPT` in
 * `oss/misc/benchmark/src/multi-sdk/post-eval.ts`. Kept in sync by hand —
 * the prompt is the source of truth; if it changes, update this list.
 */
const DIMENSIONS: ReadonlyArray<{ label: string; definition: string }> = [
  {
    label: 'layout',
    definition:
      'Is the layout correct? Proper grid/flex usage, responsive, no overflow or clipping issues, appropriate spacing between elements.',
  },
  {
    label: 'designTokens',
    definition:
      "Do colour and spacing come from the ggui design system? The primitives' typed variants first (Button/Badge/Alert variant, Text/Heading tones); raw CSS only through var(--ggui-color-*) roles (container/onContainer, sunken/onSunken, outline, link, primary-*) and var(--ggui-spacing-*) — no hardcoded hex colors, no rgba()/hsl(), no custom gradients, no literal fallbacks, no raw pixel values for spacing. (Runs judged with aesthetic-eval.v4-panel or v5-panel, which share this definition. Earlier runs used the definition quoted in the 2026-09-25 changelog entry.)",
  },
  {
    label: 'hierarchy',
    definition:
      'Clear visual hierarchy? Proper heading sizes, section separation, scannable structure, good use of whitespace.',
  },
  {
    label: 'polish',
    definition:
      'Interactive polish? Hover/focus states on buttons/links, transitions, disabled states on forms, loading indicators where appropriate.',
  },
  {
    label: 'dataPresentation',
    definition:
      'Does it render data from props correctly? No placeholder text like "Lorem ipsum", no hardcoded example data in the component body (defaults in props are OK), proper formatting of numbers/dates.',
  },
];

/**
 * Methodology changes, newest first. House rule: methodology never changes
 * silently — cadence, matrix, panel, prompt, and scoring changes are all
 * announced here, dated, because run-to-run comparability is the product.
 */
const CHANGELOG: ReadonlyArray<{ date: string; text: string }> = [
  {
    date: '2026-10-31',
    text:
      'Instrument change (internal issue #1652): in short, the report-only pending-state field ' +
      '(the 2026-10-01 entries) now also measures an action whose own press took its control ' +
      'away, such as a Save button that closes its own editor; before, such an action read 0 ' +
      'of 0, which means not measured. Only that field moves: no score, verdict, judge, ' +
      'prompt, time limit or other probe finding changes, except in the one case the ' +
      '2026-10-01 entry describes, a card that breaks the probe itself while pending, which ' +
      'can now also happen on these actions because the probe now marks them pending. The ' +
      'field is still not scored and the dashboard does not show it. On the five prompts whose ' +
      'contracts declare an action, compare the field only between runs on runner images built ' +
      'with this change, because there cells that read 0 of 0 for this reason can now read 1 ' +
      'of 1 or 0 of 1, so `dispatched` can rise. No published run carries the change yet: ' +
      'benchmark runs are paused, and the first run after the pause on a runner image built ' +
      'with it is the first that does. The details: right after the press that fired an ' +
      'action, the probe now records whether the pressed control was already no longer that ' +
      'action\'s control, because it had left the page or now names another of the contract\'s ' +
      'actions (a Send button that turns into Cancel). At the action\'s turn, if such an ' +
      'action\'s control cannot be found again (an action fired by a click is looked for by ' +
      'its name or label; a form that fired one and has left the page is not looked for), the ' +
      'probe reads the whole card instead of one control: it compares the card just before ' +
      'marking the action pending, that is after the press and after every other check, with ' +
      'the card while it is pending. It reads `visible` when more of the card\'s elements are ' +
      'disabled, or more are aria-busy, than before the mark, or when the card\'s text changed ' +
      '(whitespace at its start and end aside); fewer disabled or busy elements does not ' +
      'count. Because the comparison starts after the press, an editor that closed itself when ' +
      'pressed is already gone from both looks and does not count. A new list, `card`, names ' +
      'the actions read this way; each is counted in `dispatched` and in `visible` or ' +
      '`missing` like any other. Rows published before this change have no `card` list. A ' +
      'limit to read it with: a card read counts any change in the card\'s text while the ' +
      'action is pending, not only a pending indicator, so a card whose text changes on its ' +
      'own, such as a displayed clock, can read `visible` without showing a pending state, and ' +
      'so can a change still under way from the action read just before it, such as a timed ' +
      'confirmation message, which is then credited to the next action; for actions in `card`, ' +
      '`visible` is an upper bound. `gone` still holds an action whose control stayed in the ' +
      'page after its own press but could not be found at its turn, for example because ' +
      'another action\'s pending state had replaced the card, and, as before, an action the ' +
      'probe did not reach because an earlier pending read crashed the card or did not settle ' +
      'in time, or the probe\'s time ran out. A Send that turns into Cancel used to read ' +
      '`gone`; it is now read on the card, and reads `missing` when the card shows nothing.',
  },
  {
    date: '2026-10-28',
    text:
      'Wording change, no score change: twelve entries are reworded so that they describe each ' +
      'change by what we measured or expect it to move on this page, not by how the generator works ' +
      'inside. They are the entries dated 2026-10-26 (#2010), 2026-10-24 (#1981), 2026-10-22 ' +
      '(#1981), 2026-10-20 (#1765), the 2026-10-18 run note, the 2026-10-16 arm change, 2026-10-14 ' +
      '(#1846 to #1848) and its correction (#1849), 2026-10-13 (#1849), the 2026-10-12 reading ' +
      'note, and 2026-10-12 (#1761 and #1791). Every published score, every measured effect on it, ' +
      'every regression, and every caveat on a measurement still reported here stands. What is ' +
      'removed is description of how the generator works, and two kinds of count with it: the ' +
      '2026-10-26 entry\'s replay of a check the benchmark runs never exercise and of the blind ' +
      'reading built on it, whose outcome stays in that entry as a caveat, and a character count in ' +
      'the 2026-10-24 entry. No number on this page depends on them. Where a reworded entry called ' +
      'the benchmark runs nightly, it now says benchmark runs: they are change-triggered (see ' +
      '2026-08-21 and 2026-09-30). All other entries are unchanged.',
  },
  {
    date: '2026-10-26',
    text:
      'Generator change (internal issue #2010). No number on this page changes: the benchmark runs ' +
      'behind the tables never run one part of this change, and for the ten prompts behind the ' +
      'tables the prompts sent to the model are byte-identical before and after it. The one ' +
      'benchmark prompt whose prompt changes, a to-do list, is not among those ten. A blind reading ' +
      'of rendered cards from the ten prompts, made on 2026-10-26 with the generator of that day, ' +
      'found cut control labels on some of them, periodic tables among them. The reader saw the ' +
      'cards under shuffled ids; she recognised 3 of them from an earlier set, and found cut labels ' +
      'on cards outside those 3 as well. Content below the bottom of a tall card was read as ' +
      'undecidable, not as cut, and text that wraps inside a control counted as whole. The scores ' +
      'on this page read code, not screenshots, so they do not see this. The cards read were ' +
      'chosen, not drawn at random, so this is not a rate, and they were rendered on macOS, whose ' +
      'fonts differ from those of the Linux the generator renders on.',
  },
  {
    date: '2026-10-24',
    text:
      'Correction (internal issue #1981): the 2026-10-22 entry below says the change deletes one ' +
      'sentence from the constrained prompt and one from text both prompts share. Only the first ' +
      'reaches the model: the deleted shared-text sentence was never part of what the model reads, ' +
      'so what the model reads of the shared text is byte for byte the same with and without the ' +
      'change, in every run of the A/B. The whole treatment the model received was one sentence of ' +
      'the constrained prompt, 123 bytes. The A/B ran the constrained prompt, as the benchmark ' +
      'does, and measured exactly that sentence, so its result stands as a result about those 123 ' +
      'bytes. The free prompt changed only through the shared text, so nothing it sends changed and ' +
      'nothing about it was tested. The rest of the change the entry describes is unaffected.',
  },
  {
    date: '2026-10-23',
    text:
      'Contract re-check result (internal issues #1765 and #1981), the measurement the correction ' +
      'below promised: we re-ran the contract check on the generations both A/Bs stored, with the ' +
      'same check the nightly uses, on each stored source compiled again, and it ran on all 15 ' +
      'action-prompt cells of every run. #1765 was decided by a replication with four runs per ' +
      'side, registered with its outcomes set before it ran: 2 contract failures with the change ' +
      'and 2 without, within the registered allowance. It was run because the round before it, on ' +
      'the same builds, failed a different bar (turns); that round also reads 3 with the change ' +
      'and 1 without here, outside the contract allowance. The original first round reads 2 and ' +
      '2, and all of #1765\'s rounds together read 7 with the change and 5 without, at the edge ' +
      'of the allowance. #1981\'s deciding A/B, its two rounds read together, reads 2 with the ' +
      'change and 3 without, within the allowance; the earlier version of that change, which did ' +
      'not land, reads 0 with the change and 1 without. Across every run here, the failures are 9 ' +
      'in each arm, on the same two cells: a kanban board\'s task update and a chat\'s message ' +
      'send that had no effect when clicked, plus one chat control that could not be reached. ' +
      'These are prompts and kinds of failure the nightly also records. So the withdrawn ' +
      'sentences\' counts were wrong, and their conclusion is replaced by a narrower one: both ' +
      'A/Bs pass the registered contract bar, with 2 vs 2 and 2 vs 3 failures rather than 0 vs 0. ' +
      'In simulation, a bar of this size catches a tripling of the failure rate about four times ' +
      'in five and a doubling a little better than half the time, so passing it shows no large ' +
      'rise in contract failures, not that the change is harmless. The check ran on the stored ' +
      'generations after the fact, with its harness fixed before any result was read and checked ' +
      'against a card known to pass and the same card with its action disabled, which it failed.',
  },
  {
    date: '2026-10-23',
    text:
      'Correction (internal issues #1765 and #1981): two entries below report a contract-check ' +
      'result that was not measured. The 2026-10-20 entry (#1765) says "Contract failures 0 vs ' +
      '0", and the 2026-10-22 entry (#1981) says contract failures "passed in both rounds". Two ' +
      'faults combined. The A/Bs ran on a local runner that did not enable the browser the ' +
      'contract check needs, so on the five prompts whose contracts declare an action the check ' +
      'was skipped in every run. And our reading counted a skipped check as a failure on both ' +
      'sides, so it compared skips with skips and reported a pass, and its coverage line counted ' +
      'results present, not checks run. Those two sentences say nothing about contract behaviour; ' +
      'read them as withdrawn. The other results in both entries (turns, probe failures, median ' +
      'turns and the panel score) do not depend on that check and stand. We are re-running the ' +
      'contract check on the generations both A/Bs stored, and will add the result here, dated. ' +
      'The nightly runs behind this page\'s tables run the check in every run (55 of 55 ' +
      'action-prompt cells on each published night from 2026-10-13 to 2026-10-18) and are not ' +
      'affected; no nightly has run since 2026-10-18, so none has yet measured the changes those ' +
      'two entries describe, and the re-run above will be the first measurement.',
  },
  {
    date: '2026-10-22',
    text:
      'Generator change (internal issue #1981), in effect from the first run on a runner image ' +
      'built with this change. One sentence is deleted from the constrained prompt and one from ' +
      'text both prompts share; nothing is added. One part of the change came into play in none of ' +
      'the 63 feedback rounds of the A/B below (29 of them with the change), so it added no turn. ' +
      'Before it landed we ran a same-session A/B against the same build without the change: the ' +
      'three fast arms, the ten prompts, alternating order, with bars registered before the first ' +
      'run. An earlier version of the change failed its registered bar (generations needing six or ' +
      'more turns, 1 vs 3 against a limit of 2) and did not land. For this version we changed how ' +
      'turns are judged, and we say so here: instead of counting generations at six or more turns, ' +
      'which a no-change run fails about one time in five, we compare the average number of turns ' +
      'per generation, paired by arm and prompt, and keep the count as a guard. A no-change run ' +
      'fails that comparison about one time in sixteen and needs a second round about one time in ' +
      'seven. The first round could not resolve; as registered, a second round was run and read ' +
      'together with it. Turns changed by -0.12 per generation (95% interval -0.85 to +0.57): no ' +
      'detectable rise at the registered precision of 0.75 turns per generation. Contract failures, ' +
      'probe failures and median turns passed in both rounds; the panel score moved +0.93 and ' +
      '+0.63, both within noise (each 95% interval includes zero). One prompt sits at the guard\'s ' +
      'limit: on google-fast, product-page needed six or more turns in two runs with the change (20 ' +
      'and 8 turns) and at most four without. This measures cost, not the benefit: the benefit, ' +
      'which affects how cards are laid out, is checked on rendered cards outside this benchmark. ' +
      'The landed commits equal the measured ones; only the surrounding context of a changelog line ' +
      'differs.',
  },
  {
    date: '2026-10-20',
    text:
      'Generator change (internal issue #1765), in effect from the first run on a runner image ' +
      'built with this change. Before it landed we ran a same-session A/B against the previous ' +
      'build: the three fast arms, the ten prompts, four runs per side in alternating order, with ' +
      'pass bars registered before the first run. It passed every bar. Contract failures 0 vs 0, ' +
      'probe failures 6 vs 6, median turns 2 vs 2. Generations needing six or more turns were 4 vs ' +
      '6, at the edge of the registered allowance (6 against a limit of 4 plus 2). The panel score ' +
      'moved -0.40 points (95% interval -1.63 to +0.74) as registered, on the first two runs per ' +
      'side; read over all eight runs after the fact, -0.65 (-1.63 to +0.22). One prompt does get ' +
      'worse, and we report it: on google-fast, stock-ticker needed six or more turns in all 6 runs ' +
      'with the change and in none of the 6 without it, pooled from this A/B and the round before ' +
      'it. In those runs the model wrote layout and text properties the design system does not ' +
      'have, and spent turns removing them. This measures no harm on the bars above. It does not ' +
      'measure the change\'s visual result: the page\'s scores read code, not screenshots, so that ' +
      'is checked on rendered cards outside this benchmark. The version that landed differs from ' +
      'the one measured by a three-line wording change in the generation prompt, which replaces a ' +
      'name with a description of the same thing. The measured runs never used that name (0 of 180 ' +
      'generations), so we did not re-run. It lands together with the judge change below, so the ' +
      'first run after both cannot separate their effects.',
  },
  {
    date: '2026-10-20',
    text:
      'Cost metering (internal issue #1957): from the first run on a runner image built with ' +
      'this change, the cost of OpenAI generations includes prompt-cache writes. OpenAI bills ' +
      'cache writes on GPT-5.6 and later models at 1.25 times the input rate, and our metering ' +
      'counted those tokens as plain input. The bills did not change; the published cost of ' +
      'the OpenAI arms (all of them run GPT-5.6 or later models) rises slightly to match them. ' +
      'Generation itself is unchanged. The first run on the new image will be published with ' +
      'those arms\' cost both ways, so the step is visible. Read it as metering catching up, not ' +
      'as a regression. Cost history is not rewritten.',
  },
  {
    date: '2026-10-20',
    text:
      'Judge change (internal issue #1798): from the first run on a runner image built with this ' +
      'change, the judge panel\'s Anthropic seat is Claude Opus 5.5 instead of Claude Haiku 4.5. ' +
      'The OpenAI and Google seats and the scoring prompt are unchanged; the panel is now named ' +
      'aesthetic-eval.v5-panel. The switch is bridged: on 150 stored generations from six arms, ' +
      'the old and new panels scored the same code in the same session. The new panel scores ' +
      'lower by 1.9 points on average (95% interval 0.9 to 2.6). Per arm: claude-balanced -0.4, ' +
      'openai-fast -0.8, openai-balanced -1.0, claude-fast -2.1, google-balanced -2.6, ' +
      'google-fast -3.1. Only google-fast moves by more than our same-session noise. One of the 150 ' +
      'generations crosses the pass line, from pass to fail. The new judge is stricter mainly on ' +
      'data presentation and polish, and slightly more lenient on design tokens. Scores are not ' +
      'comparable across this date; read a step at the switch as the judge, not the generators. ' +
      'History is not rewritten. Cost moves too: each generation\'s published cost includes the ' +
      'judge panel\'s own calls, and the new seat costs more. Re-judging the same 150 generations, ' +
      'the Anthropic seat cost 0.5 cents per generation before the switch and 2.8 cents after; ' +
      'the other two seats are unchanged. So every arm\'s published cost steps up by about 2.3 ' +
      'cents per generation at the switch. That step is judging, not generation. Two things to know. First, the 2026-10-10 entry said we would ' +
      'choose a judge that is not a generator under test. Claude Opus 5.5 is a generator under ' +
      'test (it is the claude-premium arm), so that promise is not kept here. Instead we measured ' +
      'whether it scores its own arm higher, on 30 new ' +
      'premium-tier generations. On its own arm, it scores relative to the other two judges between ' +
      '2.8 points lower and 1.9 points higher (95% interval). We found no preference for its own ' +
      'arm, but this sample can only reliably detect one of about 5 points, so a smaller one is ' +
      'not ruled out. Second, it scores claude-balanced (Claude Sonnet 5.5) 4.8 points higher than ' +
      'the other two judges do (95% interval 2.5 to 6.7), which is about 1.6 points on that arm\'s ' +
      'published score. Every newer Anthropic model we tried in this seat leans the same way, by ' +
      '1.7 to 5.4 points. Read claude-balanced\'s place in the ranking with that in mind. Also, ' +
      'a judge\'s instructions move scores more than most effects we report: one added sentence ' +
      'moved a judge about 7 points on identical screenshots in a separate test. So any change to ' +
      'the judges\' instructions is announced here, never folded in.',
  },
  {
    date: '2026-10-18',
    text:
      'Runner change (internal issue #1853): from the first run on a runner image built with ' +
      'this change, the browsers come from the lockfile, and the fonts are fixed files ' +
      'checked by their content. Until now the runner installed the operating system\'s ' +
      'Chromium, which was not pinned: it moved from 154 to 155 between two runner images ' +
      'with no change on our side. Now the contract check, which clicks through each ' +
      'generated interface, runs the headless Chromium build its own browser library names, ' +
      '151.0.7922.34. That is an older build than before, by choice: it is the one the library ' +
      'is released and tested against. The screenshot judge, which does not score the nightly ' +
      'results on this page, runs the headless Chrome build its library names, 151.0.7922.77, ' +
      'derived the same way as the hosted service\'s own renderer. The Liberation fonts move from the ' +
      'operating system\'s package to the 2.1.5 release, and DejaVu is named as the fallback face. ' +
      'The contract check reads behaviour, not pixels, so we expect little movement in the ' +
      'contract pass rate. What it does not fix are the libraries the browsers load from the operating system, which are ' +
      'recorded, not pinned. No prompt, arm, judge or scoring rule changes, and history is ' +
      'not rewritten.',
  },
  {
    date: '2026-10-18',
    text:
      'Run note (internal issues #1743 and #1869): the 18 October run is the first on the image ' +
      'described in the first 16 October entry, so the arms named there start their new series ' +
      'here. It is not a comparison with 16 October. Benchmark runs were paused from 16 October, so ' +
      'there is no 17 October run, and this one was started by hand. It ran on a rebuild of that ' +
      'image, not the build we named before the run: the source is the same, and the one difference ' +
      'is a patch update to the Chromium browser, from 155.0.8059.39 to 155.0.8059.79. In this run ' +
      'Chromium executes the contract-behaviour check and is also used during generation, so the ' +
      'update is a small term, which we have not measured, in those results, in turn counts, and in ' +
      'run times and cost. The judges score the code, not screenshots. Against the seven runs ' +
      'before it, mean turns and the number of runs needing six or more turns are within their ' +
      'range. Pass rate, score and polish are above it, and that includes the six arms whose models ' +
      'did not change. On those arms the step comes from two of the three judges, and this run ' +
      'cannot tell its possible causes apart: the generator change in the same image, the Chromium ' +
      'update, or a change on the judges\' side. We do not read it as an improvement. On the six ' +
      'unchanged arms, the generator fix described on 16 October came into play no more often than ' +
      'on the two runs before it.',
  },
  {
    date: '2026-10-16',
    text:
      'Arm change (internal issue #1743): from the first run on a runner image built with this ' +
      'change, four arms move to their provider\'s latest model: claude-balanced from Claude Sonnet ' +
      '5 to Sonnet 5.5, claude-premium from Claude Opus 5 to Opus 5.5, openai-fast from GPT-5.6 ' +
      'Luna to GPT-6 Luna, and openai-premium from GPT-5.6 Sol to GPT-6.1 Sol. Each move crossed a ' +
      'same-session comparison first: 10 prompts, run twice, with the judge panel unchanged. Three ' +
      'bars were set before the run, each a set margin: on score, on the share of runs needing six ' +
      'or more turns, and on contract failures. Each new model met all three, and none needed six ' +
      'or more turns, or failed its contract, more often than the model it replaces. The new models ' +
      'scored between 0.6 points lower and 1.6 points higher. A control pair of one model against ' +
      'itself spread about as wide as the score margin, so meeting the bar at this size means "not ' +
      'shown worse", not "shown equal". On generation cost per run, Sonnet 5.5 cost about the same, ' +
      'Opus 5.5 0.73 times as much, GPT-6 Luna 0.61 times and GPT-6.1 Sol 0.33 times. ' +
      'google-balanced is relabelled from Gemini 3.7 Flash to Gemini 3.8 Flash, which is the model ' +
      'that has actually answered it since about 10 October (see the next entry); its results do ' +
      'not change. Each of these arms starts a new series here. The six other arms keep their ' +
      'models. The same image also carries a fix to the generator. That can lower turns on every ' +
      'arm, on prompts that pre-fill a form or seed a list from data. Several other changes in this ' +
      'image only change its source hash, and nothing the benchmark runs. No prompt, judge ' +
      'instruction or scoring rule changes, and history is not rewritten.',
  },
  {
    date: '2026-10-16',
    text:
      'Disclosure, provider change (internal issue #1889): Google retired two model names we ' +
      'use and, from about 10 October, answered requests for them with newer models, without ' +
      'an error. Its release notes are dated 8 October. Requests for Gemini 3.5 Flash, our ' +
      'judge panel\'s Google seat, have been answered by Gemini 3.6 Flash, and requests for ' +
      'Gemini 3.7 Flash, the google-balanced arm, by Gemini 3.8 Flash. We confirmed both with ' +
      'our own calls, which report the model that answered, and our published results show ' +
      'the change from the 10 October run on. The Google judge\'s scores step down by about ' +
      'one point, which on its own lowers the published score by about 0.4. The Anthropic ' +
      'and OpenAI judges\' scores do not step, but the OpenAI judge\'s rose at the same time, ' +
      'so the published score moved less than that across the same boundary. Score ' +
      'comparisons across 10 October are not exact. The results published from 10 to 15 October name the model we asked for, not ' +
      'the one that answered, and they priced each Google judge call at the retired model\'s ' +
      'rates, two to 2.4 times what it cost. ' +
      'From this entry on, the panel names Gemini 3.6 Flash, the judge that has been scoring ' +
      'since 10 October, and prices it as such. That is a label correction: the panel\'s ' +
      'behaviour and version are unchanged. We will record the model that answers every call from a ' +
      'later run on, so a change like this shows on the day it happens. History is not ' +
      'rewritten.',
  },
  {
    date: '2026-10-15',
    text:
      'Runner change (internal issue #1853): from the first run on a runner image built with ' +
      'this change, the software packages the benchmark runs on come exactly from the ' +
      'repository\'s lockfile, the set the hosted service ships and its tests run. Until now ' +
      'the runner re-resolved them to newer releases each time its image was built, and over ' +
      'time it had moved well ahead of what ships: on the generation path, the OpenAI client ' +
      'library was 7.32 where the service runs 7.9, React was 19.3 where it runs 19.2, and the ' +
      'schema library was 4.6 where it runs 4.4, among about two hundred others. The library ' +
      'that drives the browser for the contract check moves with them, from 1.64 to 1.62, and ' +
      'drives the same browser as before. So the results ' +
      'published before this entry measured the generator on library versions newer than the ' +
      'ones it is served on; from this entry on they measure it on the same ones. That is a ' +
      'correction of the instrument, not of the generator, and it can move any score, latency ' +
      'or cost, on any arm. A change to those packages now moves the image\'s source hash, and ' +
      'the image records every package it carries. What it does not yet fix are the operating ' +
      'system\'s own packages, which come from the base image\'s package manager when the ' +
      'image is built; they are recorded, not pinned. No prompt, arm, judge or scoring rule changes, the browser and fonts ' +
      'are unchanged by this entry, and history is not rewritten.',
  },
  {
    date: '2026-10-14',
    text:
      'Design and generator change (internal issues #1846, #1847, #1848), in effect from the first ' +
      'run on a runner image built with this change. This can move scores, turns and cost on ' +
      'prompts that tell categories apart, the periodic table above all, and what the judges see in ' +
      'some colour schemes, where a colour defect in earlier runs is fixed; the judges\' own ' +
      'instructions are unchanged. The benchmark\'s prompts, arms, judges and scoring rules do not ' +
      'change, and history is not rewritten.',
  },
  {
    date: '2026-10-14',
    text:
      'Correction to the 2026-10-13 entry on a generator change (internal issue #1849): that entry, ' +
      'as first published, overstated how much the generator\'s checking had missed before the ' +
      'change; part of what the change covers was already checked before it. Logs from a second ' +
      'runner on the same images show it: failures in one part of the newly covered scope read none ' +
      'on each of the four nights before the change and 22 on the first night after it, while ' +
      'failures in the part already covered stayed between 35 and 65 a night throughout. The ' +
      'earlier entry\'s other statements stand: the change can raise turn counts and cost, and its ' +
      'effect is read from the published runs.',
  },
  {
    date: '2026-10-13',
    text:
      'Generator change (internal issue #1849): from the first run on a runner image built with ' +
      'this change, the generator\'s own check again catches a class of errors it had silently ' +
      'stopped catching. That can raise turn counts and cost, and lower how often a generation ' +
      'passes its own check, on any prompt. Re-checking 173 previously generated components that we ' +
      'kept, 9 gain such an error, and each is a real defect the old check let through. So the move ' +
      'should be small, but it is read from the published runs, not assumed. One night can rule out ' +
      'a large move, not a small one: the count of generations at six or more turns already varies ' +
      'from 3 to 11 between nights, so a shift of one or two would not show. No arm, prompt, judge ' +
      'or scoring rule changes, and history is not rewritten.',
  },
  {
    date: '2026-10-12',
    text:
      'Reading note, not a method change: the first run after the generator change that can end a ' +
      'generation early (internal issue #1791, 2026-10-12) had fewer generations at six or more ' +
      'turns than the run before it (4 against 7) and no generation marked as ended early. Those ' +
      'two facts are consistent: the change ended no generation that night, so the drop is not its ' +
      'work. The cells that left the six-or-more group finished in one to three turns, too few for ' +
      'the change to have ended them, and over the eleven published runs before it the count of ' +
      'such generations ranged from 3 to 11 a night, so 4 is within the usual night-to-night ' +
      'spread. One night is not a trend; read the change\'s effect from the runs it marks.',
  },
  {
    date: '2026-10-12',
    text:
      'Generator change (internal issue #1761), separate from the change announced below it, in ' +
      'effect from the first run on a runner image built with this change. That can move turn ' +
      'counts, cost and scores on prompts whose generations it applies to (for example, the kanban ' +
      'board), and leaves the others as they were. It ships one benchmark run after the previous ' +
      'change, so the two can be read apart. No arm, prompt, judge or scoring rule changes, and ' +
      'history is not rewritten.',
  },
  {
    date: '2026-10-12',
    text:
      'Generator change (internal issue #1791): from the first run on a runner image built with ' +
      'this change, two generator changes apply, and both can move turn counts, cost and scores. ' +
      'The first applies only to prompts whose contract declares context slots. None of this ' +
      'page\'s prompts declares context slots, so the first change should not move them. The second ' +
      'can end any looping run sooner, so expect fewer runs at six or more turns and lower cost and ' +
      'latency on the runs that looped. That is a cost and latency change, not a quality one: a run ' +
      'this change ends sooner is still a run whose last attempt failed; it ships an earlier ' +
      'version of its own, the same fallback a run that reaches the turn cap ships, and each such ' +
      'run is marked in its result. Runs before this entry were measured without either change. No ' +
      'arm, prompt, judge or scoring rule changes, and history is not rewritten.',
  },
  {
    date: '2026-10-11',
    text:
      'Arm change (internal issues #1743, #1803): from the first run on a runner image built ' +
      'with this change, the fast Anthropic arm (claude-fast) runs Claude Haiku 5.5 instead of ' +
      'Claude Haiku 4.5. The series continues across the change on a measured bridge, not just ' +
      'a new label: on 2026-10-10 both models ran in the same session on this page\'s ten ' +
      'prompts, three times each, judged by the same panel. Haiku 5.5 scored 3.1 points higher ' +
      'on the paired per-prompt comparison (one-sided 95% lower bound +0.9). The share of runs ' +
      'that needed six or more turns was the same (2 of 30 each), as were contract-behaviour ' +
      'failures (2 of 30 each), and its cost per generation was about a fifth. That comparison ' +
      'was judged by the current panel, whose Anthropic judge is Claude Haiku 4.5. Its ' +
      'family-level excess (the 2026-10-10 entry) lifts both models of this pair equally and ' +
      'cancels in the difference; what the comparison cannot exclude is an asymmetry between ' +
      'the judge scoring its own exact model and its successor, a same-model effect whose ' +
      'direction is unknown. That comparison ran on a laptop, so its timings are not comparable ' +
      'to this page\'s; read latency on this arm afresh from the change on. Read claude-fast\'s ' +
      'scores across the change with that +3.1 in mind: part of any step up on this arm at the ' +
      'change is the model, measured. The judge panel is unchanged by this entry; its Anthropic ' +
      'seat is still Claude Haiku 4.5 (see the 2026-10-10 entry), and moving it will be bridged ' +
      'and announced separately. No other arm, prompt or scoring rule changes, and history is ' +
      'not rewritten.',
  },
  {
    date: '2026-10-10',
    text:
      'Disclosure, no change (internal issue #1798): each judge scores its own provider\'s ' +
      'generations slightly higher. Every published score is the mean of three judges, one from ' +
      'each provider: Claude Haiku 4.5, GPT-5.4-mini and Gemini 3.5 Flash. We checked whether a ' +
      'judge treats generations from its own provider differently. On the same cells, we ' +
      'compared each judge\'s score with the mean of the other two judges, on its own provider\'s ' +
      'arms and on the other providers\' arms. All three judges score their own provider\'s arms ' +
      'higher than the other two judges do: Claude Haiku 4.5 by +1.1 points (95% interval +0.4 ' +
      'to +1.8), GPT-5.4-mini by +1.3 (+0.5 to +2.1) and Gemini 3.5 Flash by +2.4 (+1.5 to ' +
      '+3.2). The intervals resample whole nights and whole prompt-nights, because cells from ' +
      'the same night and prompt are not independent. Gemini\'s excess is the largest in 96-98% ' +
      'of resamples. What this means for the published numbers: each judge is one third of the ' +
      'mean, so the effect on a published score is about +0.4 for Anthropic arms, +0.4 for ' +
      'OpenAI arms and +0.8 for Google arms. It is roughly balanced, which is why the panel has ' +
      'one judge per provider. Google\'s arms sit about 0.4 points higher than the other two as ' +
      'a result. When comparing a Google arm with an Anthropic or OpenAI arm, read differences ' +
      'smaller than about a point with that in mind. Anthropic-vs-OpenAI comparisons carry ' +
      'almost no net tilt (+0.36 vs +0.42). What this cannot tell apart: a judge that prefers ' +
      'its own provider\'s output, and a judge that is more sensitive to its own provider\'s ' +
      'style, produce exactly this result. These measurements do not separate them. What ' +
      'changes: no published score changes. The panel\'s Anthropic judge, Claude Haiku 4.5, is ' +
      'the same model as the Anthropic fast arm (claude-fast), so today one judge scores its ' +
      'own model. We intend to re-choose that seat with a model that is not a generator under ' +
      'test. The switch, if made, will be bridged (old and new panel scoring the same cells, ' +
      'with the shift published per arm) and announced here before it takes effect. Data: ' +
      'published nights 2026-09-29 to 2026-10-09 (8 nights, 878 cells with a full panel), ' +
      'reproducible from the public data/<date>/multi-sdk.json files. Cells are the per-prompt, ' +
      'per-arm, per-night scores; the intervals cover sampling of nights and prompts, not a ' +
      'change of judge models.',
  },
  {
    date: '2026-10-01',
    text:
      'Instrument change (internal issue #1652): in short, the runtime probe\'s action check now ' +
      'walks through a card\'s screens in a copy of the card of its own, so an action whose ' +
      'control appears only on a later screen, such as a wizard\'s last step, an Edit button that ' +
      'turns into Save, or a form a button opens, can now be found and its wiring verified. An ' +
      '"unverified" action-wiring result now means that no press the walk could reach within its ' +
      'bounds fired the action, and its published description says how far the walk got. Across ' +
      'this change, nothing changes on the five prompts that declare no action, so their counts, ' +
      'verdicts, times and warning texts remain comparable; on the five prompts whose contracts ' +
      'declare an action, compare only runs on runner images built with this change, because ' +
      'there the probe\'s warning and failure counts, its verdict, the pending-state field and the ' +
      'generation time move, and through the generation loop the cards and their scores can move ' +
      'too. The details: before, the check pressed each candidate control of the card\'s first ' +
      'screen once and reported an action it could not reach that way as "unverified". Because ' +
      'the walk has its own copy, the copy the probe\'s other checks read is no longer pressed by ' +
      'the action check (its empty fields are still filled first, as before). On the five action ' +
      'prompts, what can move is the action-wiring warnings; the report-only pending-state field ' +
      '(the earlier 2026-10-01 entry), now measured on more cells where it read 0 of 0; and the ' +
      'prop-coverage, prop-sensitivity and stream checks, which now read a card the action check ' +
      'has not pressed. Of the probe\'s findings, only a render crash of a kind the loop knows how ' +
      'to fix and a prop-sensitivity failure can be fed back to the generation loop, each once; ' +
      'warnings are recorded, never fed back. Prop sensitivity can now flag a displayed prop ' +
      'whose value the card ignores on a card where the old check\'s presses had changed its text, ' +
      'and such a failure counts in the probe\'s verdict and can be fed back, so there the card ' +
      'can change, and with it its scores, turns, time and cost; the walk\'s own time also counts ' +
      'directly in the generation time of every cell of those prompts. On the other five prompts ' +
      'no walk runs and nothing changes. For each action whose wiring the probe can trace, it ' +
      'mounts a fresh copy of the card and walks it screen by screen, pressing its buttons and ' +
      'links (for an action wired to the Enter key, each is clicked and then given Enter; for one ' +
      'wired to a form submit or a change, its forms and submit buttons, or its fields, get that ' +
      'trigger first, and then every button and link is clicked to move between screens, which ' +
      'the old pass did not do), with every screen\'s empty fields filled first (text, date and ' +
      'number fields, selects and radio groups; checkboxes are left alone). A screen is told ' +
      'apart by its controls: each one\'s tag, type, label (its aria-label, placeholder or text) ' +
      'and whether it is disabled, never typed values, selections, or element names and ids. ' +
      'Choosing an answer is the same screen unless it adds, removes, relabels, enables or ' +
      'disables a control. Each control is pressed once per screen, and when a screen has none ' +
      'left the walk returns, through presses it has already made, to the nearest screen that ' +
      'still has one. A press that leads back to a screen already seen is not progress, so Back ' +
      'and Next cannot loop, in any language; there is no list of labels. The walk stops at the ' +
      'first press that fires the action. Each action\'s walk stops at 60 presses in all, 3 ' +
      'seconds after it began, or 7 seconds before the probe\'s deadline (the pending phase\'s ' +
      '5-second reserve plus 2), but none of these bounds applies while it is on the first screen ' +
      'with a control there still unpressed, including when it returns there. A first-screen ' +
      'control left unpressed when a press leads elsewhere is pressed only if it is still shown ' +
      'on the next screen or a known route leads back to it (a one-way wizard has none), where ' +
      'the old single pass pressed every candidate. An action the walk cannot fire stays ' +
      '"unverified"; in the published report its issue (subcategory ' +
      '`runtime:action-wiring:<action>`) now ends with the walk\'s account (presses, screens, why ' +
      'it stopped, whether any screen named the action, the last presses) instead of naming the ' +
      'first control the old pass tried, which, where no control named the action, was the first ' +
      'clickable on the page (on the 2026-10-01 survey cells, a disabled Back button). An action ' +
      'wired only through a component prop the probe cannot trace (a design-system Select\'s ' +
      'change, for example) or to dragging is not walked and stays "unverified", as before; so ' +
      'does one clicked from an element that is not a button or link, such as a checkbox, a row ' +
      'or a span, and a step gated on a checkbox cannot be passed. An action declared but wired ' +
      'to nothing still fails. The pending-state field still marks only an action the probe\'s own ' +
      'click or form submit fired, and now reads the control in the copy whose press fired it. A ' +
      'submit-wired action can now also be fired by a plain click on a button that submits its ' +
      'form; that button is then the control read, as for any pressed control that is not a form, ' +
      'and it reads as gone if it has left the page; and a crash in any copy of the card while ' +
      'the action is pending now reads 0 of 1. Prop coverage counts a required prop as shown when ' +
      'its value appears on the copy the other checks read or on any screen a walk reached, so a ' +
      'value shown on a later step counts; on a card a walk ran on, a prop-coverage warning now ' +
      'says it also looked on the screens the walk reached. The walk costs a fresh copy of the ' +
      'card per action and, past the first screen, up to 3 seconds; the first screen has no time ' +
      'bound, and for an action wired to a submit or a change it is now pressed more than before. ' +
      'That leaves less time for the probe\'s later checks: the pending-state field can be absent ' +
      'where it was present before, and a slow card, or one that hangs on a screen only the walk ' +
      'reaches, can run the probe out of time, which leaves that probe with no verdict and no ' +
      'findings, no pending-state field and no feedback to the loop that round, as the earlier ' +
      'entry describes. The change was checked by replaying the old and the new check on six ' +
      'freshly generated cards of the survey, kanban and onboarding prompts; that replay is not ' +
      'published, so its figures are not given here. The published measurement is the first runs ' +
      'on a runner image built with this change (which may come later than this entry\'s date), ' +
      'and they will be read against the 2026-09-30 and 2026-10-01 runs. The corpus, the judge ' +
      'panel and every arm are unchanged, and no scoring rule changes. History is not rewritten.',
  },
  {
    date: '2026-10-01',
    text:
      'Instrument change (internal issue #1398): in short, a new report-only field records the ' +
      'control\'s reaction to the runtime\'s pending state: for a cell of one of the five prompts ' +
      'whose contracts declare an action (one each), whether that action\'s control changed when the ' +
      'probe put the action into the pending state the served runtime sets while it waits for the ' +
      'agent\'s answer (the state a card reads with `useActionPending`): it became disabled or busy, ' +
      'changed its text, or was removed or replaced. The comparison is with the control as it stood ' +
      'after the press, so a change the card makes on its own when pressed, such as its own ' +
      '"sending" flag, does not count. It reads as `visible` of `dispatched`: 1 of 1 (it changed); ' +
      '0 of 1 (it did not, or while pending the card crashed in a way React\'s error boundary ' +
      'catches, or its update was still unsettled after two seconds); or 0 of 0, which means not ' +
      'measured. A cell whose card did not mount, or whose probe did not finish or ran short of ' +
      'time, carries no field at all, and a missing field is not a zero. The field is not scored, ' +
      'and the dashboard does not show it. The check reaches past the field in one case: a card ' +
      'that breaks the probe itself while pending (see below) loses that probe\'s verdict and ' +
      'findings, in the report and in the generation loop, so on such a cell the probe verdict can ' +
      'move and, through that round\'s feedback, so can the card and its scores. The details: from ' +
      'the first run on a runner image built with this change (which may come later than this ' +
      'entry\'s date), a cell of one of the five action prompts carries ' +
      '`runtimeProbePendingAffordance` when its runtime probe finished with the card mounted and ' +
      'had at least five seconds of its time limit left for this check. After every other check, ' +
      'the probe marks the action as pending, as the served runtime does until the agent answers, ' +
      'if its own click or form submit fired it (an action fired through a change or the Enter key, ' +
      'or one the probe\'s click did not fire, is not marked and reads 0 of 0), and compares the ' +
      'action\'s control with how it looked just before that mark, that is after the press and after ' +
      'every other check. The control is, for a click, the element that was pressed, while it is ' +
      'still in the page (if it has left the page, a control naming the action by its name or label ' +
      'is looked for instead); for a form submit, the form\'s clickable that names the action, else ' +
      'its first submit-type control, else the form itself. `dispatched` is 1 when the probe marked ' +
      'the action. `visible` is 1 when the control became disabled or aria-disabled, became ' +
      'aria-busy, changed its text (an input button\'s value included), or was removed or replaced; ' +
      'a change of style or class alone does not count, nor does a text-free icon added beside ' +
      'unchanged text; anything added that carries text counts, including an emoji and the design ' +
      'system\'s `Spinner` (its inline animation stylesheet is part of the control\'s text), and an ' +
      'icon that replaces the label counts because the text changed. Otherwise `missing` holds the ' +
      'action\'s name, including when the card crashed while pending in a way React\'s error boundary ' +
      'catches (a throw during rendering or in an effect) or the read did not settle within two ' +
      'seconds. `gone` holds the action\'s name when its control could not be read at its turn (the ' +
      'pressed element or form had left the page and, for a click, no control naming the action was ' +
      'found); a gone action is not marked, so it reads 0 of 0. The field is absent on every other ' +
      'cell, including one whose card failed to mount, whose probe did not finish, or whose probe ' +
      'had less than five seconds left. The check adds no probe finding, and the probe\'s verdict ' +
      'and its warning and failure counts do not include it. Each read waits at most two seconds ' +
      'and never past the probe\'s deadline. But a card that breaks the probe itself once pending, ' +
      'for example by hanging in an endless synchronous loop, throwing where React\'s error boundary ' +
      'cannot catch it (in a timer or an unhandled promise), flooding the probe\'s output or ' +
      'exhausting its memory, ends the probe as it would at any other moment: the probe times out ' +
      '(its verdict reads "probe did not run (timed-out: …)") or ends with one render-no-throw ' +
      'warning or failure in place of its findings, this field is absent, and the generation loop\'s ' +
      'probe feedback for that round is replaced the same way. The corpus, the judge panel and ' +
      'every arm are unchanged, and no scoring rule changes; on a cell whose card breaks the probe ' +
      'while pending, the probe verdict can move, and through the loop the card and its scores can ' +
      'move. History is not rewritten.',
  },
  {
    date: '2026-09-30',
    text:
      'Run-trigger change, not a score change (internal issue #1310): in short, from the first run ' +
      'on a runner image built with this change (which may come later than this entry\'s date), an ' +
      'edit to any non-test file of the first-party code the image ships, or to its root build ' +
      'files, starts a run at the next daily probe unless a hold is open; that includes the model ' +
      'registry that prices the cost column. The image\'s Node.js base is pinned by digest, so a ' +
      'run\'s runner commit now also fixes its Node.js release. The details: the source hash ' +
      '(`multiSdk.sourceHash` on each run\'s index row) now covers every tracked file of every ' +
      'first-party package the image ships, except files named as tests (`*.test.*` and `*.spec.*` ' +
      'scripts and anything under `__tests__/`; test fixtures, helpers and configuration stay in, ' +
      'so an edit to one also starts a run). Those packages are the runner and every workspace ' +
      'package it depends on, found by following its workspace dependencies in the lockfile instead ' +
      'of from a hand-kept list. The hash also covers the files outside them that their build ' +
      'scripts run, and the root workspace and build files (package.json, pnpm-workspace.yaml with ' +
      'its override list, .npmrc, turbo.json, the Makefile and the image workflow). With the base ' +
      'pinned by digest, a run\'s runner commit (`meta.version`) now also fixes its Node.js patch ' +
      'release and the OS packages the base image starts with, except any that apt upgrades when it ' +
      'installs the browser, and a bump moves the hash too. The first run under these rules reads ' +
      'as an update whatever else changed, because earlier rows\' hashes were computed under the old ' +
      'rule and cannot match; like any run, it also carries whatever else changed since the ' +
      'previous one. Earlier rows keep the hashes they were published with. Three things are still ' +
      'outside the hash: the exact third-party npm versions the image\'s deploy step resolves on its ' +
      'build day; the lockfile, which the deploy does not read (see the 2026-09-30 Disclosure) but ' +
      'the first-party packages are compiled from, so it fixes the versions of the compilers and of ' +
      'the React bundled into the contract-behaviour check\'s page runtime (internal issue #1641); ' +
      'and the Chromium browser, its fonts and the system packages apt installs or upgrades with ' +
      'them from Debian 12\'s package archive as it stands on the build day. The corpus, the judge ' +
      'panel and every arm are unchanged, and no scoring rule changes; history is not rewritten.',
  },
  {
    date: '2026-09-30',
    text:
      'Disclosure (internal issues #743 and #1310): in short, a run\'s runner commit does not pin ' +
      'the third-party parts of the image the run used (its npm packages, its Node.js base image ' +
      'and, from the 2026-09-10 run on, its browser), so two images built from one commit can ' +
      'differ in them. One effect is confirmed: the model registry\'s price cut for GPT-5.6 Sol ' +
      'reached the 2026-09-02 run\'s image and accounts for about half of openai-premium\'s cost fall ' +
      'at that run. An audit of the rest is open (internal issue #1636), and what it confirms will ' +
      'be published here as dated corrections. The details: every run this page has published ' +
      '(2026-06-15 onward) used a container image that took its third-party parts when it was ' +
      'built. Its npm packages resolve on the build day to the newest versions allowed by their ' +
      'declared ranges and by the override list in the development repository\'s root ' +
      'pnpm-workspace.yaml, which pins a few exactly. The step that installs the image\'s packages ' +
      '(a legacy `pnpm deploy`) does not read the lockfile, the repository\'s record of exact ' +
      'versions, and does not apply the public mirror\'s own, much longer pin list. The Node.js base ' +
      'image comes from its current release the same way, and so, from the 2026-09-10 run on, do ' +
      'the Chromium browser and fonts in which the contract-behaviour check renders and clicks the ' +
      'components of the five prompts whose contracts declare actions. (The judge panel scores ' +
      'source code, not a rendering; no published run has used the visual judge some earlier ' +
      'entries mention.) A run\'s runner commit (`meta.version` in its report) therefore identifies ' +
      'the first-party code its image was built from, not those versions: two images built from one ' +
      'commit can differ in them. The source hash (`multiSdk.sourceHash` on each run\'s row in the ' +
      'published index, data/index.json, from the 2026-09-03 run on; the dashboard does not display ' +
      'it, though some changelog entries quote values) has so far covered the version ranges and ' +
      'tags written in the files it lists. It has not covered the root override list, the ranges in ' +
      'the package.json of the shipped packages it does not list, the versions any range or tag ' +
      'resolves to (listed or not), or the source of most first-party packages the image ships: ' +
      'besides the runner\'s own, it has hashed only ui-gen\'s, ui-visual-tester\'s (from the ' +
      '2026-09-10 run) and design\'s (from the 2026-09-14 run) (internal issue #1310), and the ' +
      'protocol package, whose model registry prices the cost column, only by its package.json. ' +
      'Since 2026-09-03 a change in those alone has not started a run, and a move between two runs\' ' +
      'readings can include changes picked up when the later run\'s image was built. The five runs ' +
      'of 2026-08-24 to 2026-09-01 that the 2026-09-03 entry calls "honest re-measurements of an ' +
      'unchanged harness" ran an unchanged harness, but not necessarily unchanged dependencies (its ' +
      '"declared dependencies" are ranges, not resolved versions) or unchanged first-party packages ' +
      'outside its hash, some of which changed; nor were they all "caused only by unrelated ' +
      'dependency-lockfile changes": version-number and build-script edits in files that entry\'s ' +
      'hash covers moved that hash at the 2026-08-24, 08-26 and 09-01 runs, so under it those three ' +
      'would still have started a run. The 2026-09-13 entry\'s "a different instrument on the page, ' +
      'never a silent one" promised more than the page gives: no published run used a judge that ' +
      'paints, the source hash it relies on is in data/index.json, not on the page, and it moves ' +
      'only for changes inside the files it lists, not for the parts above. This entry changes no ' +
      'corpus, matrix, judge model or prompt. One move of this kind is known: the image the ' +
      '2026-09-02 run used carried the model registry\'s price cut for GPT-5.6 Sol (input $5 to $4, ' +
      'output $30 to $20 per 1M tokens), so from that run on openai-premium\'s tokens are priced ' +
      'about a fifth lower overall with no change in its model. That accounts for about half of the ' +
      'arm\'s fall in cost per cell at that run ($0.78 on 2026-09-01, $0.50 on 2026-09-02), and ' +
      'lower token use for the rest. The 2026-09-02 matrix entry\'s "prior rows stay comparable" ' +
      'therefore does not hold for that arm\'s cost, and it is not established for the other arms: ' +
      'the same image changed the generation harness, and five other arms\' cost per cell rose 35 to ' +
      '56 percent at that run with no price change. Whether any other reading moved because of a ' +
      'change of this kind is not yet established; an audit of this page\'s history against its data ' +
      'is open in the development repository (internal issue #1636), and what it confirms will be ' +
      'published here as a dated correction. History is not rewritten.',
  },
  {
    date: '2026-09-30',
    text:
      'Correction to this page\'s receipts and its cadence claim, not a score change: a run\'s runner ' +
      'commit and the git commit ids and issue numbers in this changelog belong to ggui\'s ' +
      'development repository, which is not public. Its commit ids are not the public mirror\'s ' +
      '(github.com/ggui-ai/ggui carries the open code under other ids and without the `oss/` path ' +
      'prefix), and its issue numbers are not the mirror\'s issues. The 2026-09-25 corpus entry\'s ' +
      'commit 34039b416 is that change\'s id before it landed and is on no branch of either ' +
      'repository: it landed as e4fbeaeb3, which runner images carry from the 2026-09-25 run on. ' +
      'The 2026-08-21 entry\'s "every published run corresponds to an actual update", which this ' +
      'page\'s header repeated, promised more than the gate checks: the daily probe compares one key ' +
      '(the runner commit until 2026-09-03, the source hash since, which an edit that changes ' +
      'nothing measured also moves), and a run an operator starts by hand skips the gate. Nothing ' +
      'in its index row marks it; its report\'s run id carries its start time, and the probe\'s own ' +
      'runs start within two minutes after 03:00 UTC. Since 2026-09-02 the probe also skips while a ' +
      'hold is open on the development repository\'s main branch (marked by data/HOLD.json); no ' +
      'entry announced that rule, and it has not yet skipped a firing. A second run on the same UTC ' +
      'date replaces that date\'s row and report, and one has: the published 2026-08-19 row and ' +
      'report are that day\'s second run (started 11:36 UTC, 79 of 90 cells generated), which ' +
      'replaced its 03:00 UTC run (0 of 90), the run the 2026-08-19 entry\'s "0% success" describes. ' +
      'This entry changes no published row or report.',
  },
  {
    date: '2026-09-25',
    text:
      'Methodology change, announced (issue #1350): from the first run judged with panel prompt ' +
      'aesthetic-eval.v4-panel (each row\'s judge disclosure names its prompt version), the ' +
      'design-tokens dimension reads what the generator is taught: the design system\'s typed ' +
      'variants first, and raw CSS only through its current colour roles. Before it, the judges ' +
      'were asked "Does it use ggui design tokens? var(--ggui-color-*) for colors (especially ' +
      'semantic: surface, onSurface, outline)" — two of those roles were retired on 2026-09-10 ' +
      '(issue #989), and a component taking every colour through a variant read as a miss. ' +
      'Measured before the switch by re-judging 96 generations both ways in one session: design ' +
      'tokens +3.2 points (95% interval 1.2 to 5.3), overall score +1.0 (0.3 to 1.7), data ' +
      'presentation +0.9 (0.4 to 1.5), and no generation changed between pass and fail. Each ' +
      'shift is within the noise of re-judging a single generation (3.8 points for design ' +
      'tokens, 1.4 overall). Design-tokens and overall scores are not comparable across this ' +
      'change; the other four dimensions\' definitions, the corpus and the judge models are ' +
      'unchanged; history is not rewritten.',
  },
  {
    date: '2026-09-25',
    text:
      'Corpus change, announced (issue #1325): from the first run on a runner image carrying ' +
      'commit 34039b416, the Chat Interface prompt asks for other participants\' messages on "a ' +
      'muted neutral background" instead of naming surfaceVariant, a colour role the design ' +
      'system retired on 2026-09-10 (issue #989). Between those dates every Chat Interface cell ' +
      'was asked for a token that no longer existed: the generator\'s own token check rejected ' +
      'it while the judges still asked for it, so that commit measured a contradiction in its ' +
      'prompt as well as the model. Chat Interface results are not comparable across this ' +
      'change; every other commit, the judge panel and every arm are unchanged; history is not ' +
      'rewritten.',
  },
  {
    date: '2026-09-23',
    text:
      'Instrument change, announced (issue #1299): from the first run on a runner image carrying ' +
      'commit cc1480e35, a runtime-render probe that runs out of its wall-clock bound is recorded ' +
      'as timed out — with its elapsed time and the host\'s load — instead of as a component ' +
      'crash. Before it, a probe that simply ran out of time on a busy machine published in the ' +
      'cell\'s runtime-probe verdict as a crash the model caused; from that run such a cell\'s ' +
      'verdict reads "probe did not run (timed-out: \u2026)", neither a pass nor a failure, and a ' +
      'component that genuinely throws still reads as a crash. The generation loop changes with ' +
      'it: a timeout is no longer handed to the model as a crash to fix, so on a heavily loaded ' +
      'run a cell can spend fewer turns and less time than it would have. The per-cell probe ' +
      'verdicts move; the score and pass columns do not read the probe. Corpus, judge panel and ' +
      'every arm unchanged; history is not rewritten.',
  },
  {
    date: '2026-09-23',
    text:
      'Report field added, not a method change (issue #404): from the first run on a runner image ' +
      'carrying commit 3cccad688, a cell\'s generation record in the published report carries ' +
      'sameExchangeBreak — the tool the model kept repeating and how many times — when the ' +
      'harness\'s same-exchange guard ended the coding loop, and no such field otherwise. It is ' +
      'reported, never scored: no bar, no page view, and scores and pass do not move. It says the ' +
      'loop ended, not that nothing shipped — the loop falls back to an earlier successful build ' +
      'when one exists — so a count reads it beside the cell\'s compiled size. Rows before that run ' +
      'do not carry the field, and a missing field there is not a zero. Corpus, judge panel and ' +
      'every arm unchanged; history is not rewritten.',
  },
  {
    date: '2026-09-23',
    text:
      'Evaluation-call cache accounting, announced (issue #1281): from the first run on a runner ' +
      'image carrying commit a6f3a7e5b, a cell\'s token counts and cost include the in-loop ' +
      'evaluation calls\' prompt-cache reads and writes. Before it, those calls contributed only ' +
      'their non-cached input and their output, so the row\'s total and cached counts left out the ' +
      'evaluator\'s cached prefix and the cost column priced none of it. From that run the ' +
      '2026-09-19 convention — total = non-cached input + cache reads + cache creations + output, ' +
      'cached = total − input − output — holds for the evaluation calls as well as the coding ' +
      'turns. Totals and cached counts move up on every arm whose provider reports cache on those ' +
      'calls, and costs move up by those tokens priced at the registry\'s cache rates, so token and ' +
      'cost readings are not comparable across that run; the first run on the new image names ' +
      'itself in its own receipt. Scores, corpus and judge panel unchanged; history is not ' +
      'rewritten.',
  },
  {
    date: '2026-09-20',
    text:
      'Google cache accounting, announced (issue #1186): from the first run on a runner image ' +
      'carrying commit a1278994d, a Google arm\'s "input tokens" excludes the cached part of the ' +
      'prompt \u2014 which Gemini reports and the runner had been counting as ordinary input \u2014 and ' +
      'the row\'s cached count (total \u2212 input \u2212 output) is real for those arms. google-fast and ' +
      'google-balanced re-price that part at their registry cache-read rates (0.03 and 0.075 per ' +
      '1M tokens, a tenth of their input rates), so their cost readings move down from that run ' +
      'and are not comparable across it; google-premium carries no cache-read rate in the ' +
      'registry, so its cost stays what it was \u2014 an upper bound \u2014 while its token stats move; a ' +
      'sourced rate for that row is the registry owner\'s to cite. Anthropic and OpenAI arms ' +
      'unchanged; scores, corpus and judge panel unchanged; history is not rewritten.',
  },
  {
    date: '2026-09-19',
    text:
      'Token counts completed, announced (issue #1186): from the first run on a runner image ' +
      'carrying commit 0bf89728c, a cell\'s "total tokens" is the provider\'s full footprint \u2014 ' +
      'non-cached input, cache reads, cache creations and output \u2014 on every arm. Before it, the ' +
      'runner\'s path left cache reads and creations out of the total: an OpenAI cell on the ' +
      '2026-09-19 run read a total in the hundreds where the provider processed tens of ' +
      'thousands, and Anthropic cells had left out their cache reads and creations all along. ' +
      'Costs do not move \u2014 pricing already used those counters \u2014 so what changes is the token ' +
      'stats, not the cost column: OpenAI totals return to the provider\'s footprint (about ' +
      '37,000 on a warm first turn of this corpus) and Anthropic totals grow by their cache reads ' +
      'and creations. From that run, on every arm, cached tokens (reads plus creations) equal ' +
      'total \u2212 input \u2212 output, and that is the receipt; the first run on the new image names ' +
      'itself in its own receipt. Scores, corpus and judge panel unchanged; history is not ' +
      'rewritten.',
  },
  {
    date: '2026-09-19',
    text:
      'Cause read, and the first run that moved (issue #1186): the runner\'s coding loop takes its ' +
      'token counts from a path the 2026-09-17 change did not reach, which is why the 2026-09-18 ' +
      'run read a cached prefix of zero on every OpenAI cell. Commit 19863264d routes that path ' +
      'through the same split, and the 2026-09-19 run is the first on a runner image carrying it: ' +
      'the OpenAI arms\' cost per generation read 42 to 67 percent lower than the day before with ' +
      'no model change \u2014 the cached prefix priced at the provider\'s cache-read rate instead of the ' +
      'input rate \u2014 so OpenAI cost readings from runs before 2026-09-19 are upper bounds and are ' +
      'not comparable across it. On the row, an OpenAI arm\'s "input tokens" and "total tokens" ' +
      'now count only the non-cached prompt tokens and the output; the cached prefix is priced in ' +
      'the cost but not shown, so those counts understate what the provider processed by the size ' +
      'of the cached prefix (about 36,000 tokens on a first turn of this corpus) until the row ' +
      'carries the cached count. The judge panel\'s OpenAI judge likewise reports only its ' +
      'non-cached input, so the panel\'s share of the cost column (about a cent a cell) omits its ' +
      'cached prefix. Anthropic and Google arms\' pricing is untouched; scores, corpus and judge ' +
      'panel unchanged; history is not rewritten.',
  },
  {
    date: '2026-09-18',
    text:
      'Instrument fix, announced (issue #1187): from the first run on a runner image carrying ' +
      'commit 27e7e1bda, the runtime-render check fills a cell\'s inputs before it clicks a wired ' +
      'action, the way a user types before pressing Send. Before this, a control that does ' +
      'nothing on an empty form \u2014 the chat-interface shape \u2014 read "synthetic click did not ' +
      'dispatch it" on every such cell: the instrument\'s limit, published as a finding against ' +
      'the model. That line is no longer emitted for a control that dispatches once its inputs ' +
      'are filled; a control that is genuinely unwired still reads as such. Rows carrying the ' +
      'old line on 2026-09-18 passed with it, so scores and pass are not what this moves \u2014 the ' +
      'per-cell issues list is; the first run on the new image says which rows in its own ' +
      'receipt. Corpus, judge panel and every arm unchanged; history is not rewritten.',
  },
  {
    date: '2026-09-18',
    text:
      'Reading, not a change: the 2026-09-18 run \u2014 the first on a runner image carrying commit ' +
      'b601ede80 (source hash 7c86a28b6ab5) \u2014 read a cached prefix of zero on every OpenAI cell ' +
      '(40 of 40, 24 of them multi-turn), so its OpenAI cost readings are priced exactly as the ' +
      '2026-09-17 run\'s and are comparable with them. The provider does cache and does report ' +
      'the field on a direct probe; why the runner\'s own responses read zero is being read on ' +
      'the runner\'s path. The first run whose ' +
      'OpenAI cells carry a non-zero cached count is named in its own receipt, and OpenAI cost ' +
      'readings are not comparable across that run. Scores, corpus and judge panel unchanged; ' +
      'history is not rewritten.',
  },
  {
    date: '2026-09-17',
    text:
      'OpenAI cost readings change meaning, announced (issue #1186): from the first run on a ' +
      'runner image carrying commit b601ede80 (baked 2026-09-17), the OpenAI adapters report the ' +
      'cached prompt prefix separately \u2014 OpenAI counts it inside input_tokens and names it in ' +
      'input_tokens_details.cached_tokens \u2014 and the estimated cost prices it at the provider\'s ' +
      'cache-read rate carried by the model registry, 10% of the input rate on all four OpenAI arms ' +
      'at this line (luna $0.02, terra $0.20, sol $0.40, astra $1.00 per 1M tokens), instead of at ' +
      'the full input rate. Rows before this line priced every OpenAI input token at the input ' +
      'rate \u2014 an upper bound. Where the provider reports a cached prefix, a reading after this ' +
      'line is lower than the same generation would have read before it, with no model change ' +
      '\u2014 the drop is the instrument, not the model \u2014 and OpenAI cost readings across this line ' +
      'are not comparable; where it reports none, nothing moves. For an OpenAI arm, "input ' +
      'tokens" now excludes the cached prefix. The Anthropic arms were already ' +
      'priced this way and do not move; the Google arms are untouched by the commit. The cost ' +
      'column is still generation plus the judge panel\'s own tokens. Scores, corpus and judge ' +
      'panel unchanged; each run\'s receipt names the cached count it read; history is not ' +
      'rewritten.',
  },
  {
    date: '2026-09-16',
    text:
      'Contract-behaviour probe walks multi-step forms. The probe now primes date-typed inputs ' +
      '(date, time, month, week, datetime-local) like text inputs, re-primes after a click reveals ' +
      'or enables controls, and may click that control again once everything it revealed has been tried ' +
      '(a wizard\'s Next; bounded to 8 re-clicks per control). Before this, a form whose Submit ' +
      'or Complete rendered only on its last step read as "action-not-rendered" or ' +
      '"action-no-effect" after the probe stopped at step one — the instrument\'s limit, published ' +
      'as the model\'s failure. Rows the probe previously could not walk MAY now be measured; the ' +
      'first run on the new image says which, in its own receipt. Scores, corpus and judge panel ' +
      'unchanged; history is not rewritten.',
  },
  {
    date: '2026-09-14',
    text:
      'Reading change, announced (issue #1040): from the first run on a runner ' +
      'image carrying it, a cell whose terminal control the static ' +
      'contract-behaviour probe cannot reach — it rendered disabled after the ' +
      'probe primed the inputs, or it sits behind step navigation the probe ' +
      'does not walk — reads "action-unreachable" with that reason, and it ' +
      'means NOT MEASURED: never a failure of the model, never "not rendered". ' +
      'Where the probe finds the control only disabled — the survey-form and ' +
      'onboarding-wizard readings of 2026-09-12 to 09-14 were of this shape — ' +
      'the row reads "not measured" from this run on; the run\'s own receipt ' +
      'says which rows did. An enabled control that is clicked and does ' +
      'nothing is still "action-no-effect" — the miss the check exists to find. Symmetric across arms by construction; the ' +
      'row keeps the diagnostic; the report shape is unchanged (one more word ' +
      'in the failure kinds). Scores and the judge panel are unaffected; ' +
      'history is not rewritten.',
  },
  {
    date: '2026-09-14',
    text:
      'One batch, two things, from the first run on a runner image carrying ' +
      'commit c2f7a4e63 (Track A of #1075): the generator now takes its copy ' +
      'from the props — no invented eyebrow, kicker, helper or status text — ' +
      'which is a change in what the bench measures, not in how; and the ' +
      'in-loop evaluation gained a universal check (a caps-label rule) that ' +
      'feeds the published pass, which IS an instrument change: a cell can ' +
      'fail that check today that passed yesterday with no model having ' +
      'changed, so pass readings before and after this line are not ' +
      'comparable on that check. The judge panel prompts and the visual ' +
      'judge prompt are byte-identical; the source hash on the row moves as ' +
      'the recipe says. History is not rewritten.',
  },
  {
    date: '2026-09-13',
    text:
      'Recipe change, not a score change: from the next run the source hash ' +
      'printed on each row also covers the design package the runner renders ' +
      'with (its tokens and theme-to-CSS rules), and a change to that package ' +
      'now rebuilds the runner image — so a judge that paints differently is ' +
      'a different instrument on the page, never a silent one. Earlier rows ' +
      'keep the hashes they were published with; a design-only change before ' +
      'this line did not move them. Scores, the corpus, the judge panel and ' +
      'every arm are unaffected; history is not rewritten.',
  },
  {
    date: '2026-09-12',
    text:
      'Instrument reading, not a score change: the 2026-09-12 run (source hash ' +
      '187de87f53cf, runner f30ad85) is the first on the primed contract-behaviour ' +
      'check announced below. chat-interface reads as a measurement again (11/11 ' +
      'arms ok). survey-form (0/11) and onboarding-wizard (1/11) now read ' +
      '"action-no-effect" on every arm: the check primes inputs and clicks, but ' +
      'those components put Submit and Complete behind form completion or step ' +
      'navigation the static probe does not perform. That is a limit of the ' +
      'instrument, symmetric across every arm — not a finding about any model — ' +
      'and issue #1040 tracks it. Read those two rows as "not measured" until it ' +
      'closes. Scores, the corpus, the judge panel and every arm are unaffected; ' +
      'history is not rewritten.',
  },
  {
    date: '2026-09-11',
    text:
      'Instrument reading, not a score change: the 2026-09-11 run (source hash ' +
      '072705e0b79e) is the first on the fixed contract-behaviour check, and it ' +
      'shows the next limit of a click-only probe — chat-interface, survey-form ' +
      'and onboarding-wizard read "no clickable control" on every arm because ' +
      'those components disable Send, Submit and Complete until something is ' +
      'typed or chosen, and the check skipped disabled controls and never typed ' +
      '(issue #1021). product-page and kanban-board readings on that row stand. ' +
      'The check now primes inputs first — a value in each empty text field and ' +
      'textarea, the first option of each select, the first radio of an ' +
      'unchosen group — and, when every control is still disabled, says so ' +
      'in words instead of "not rendered". Those three commits read as ' +
      'measurements again from the first run on a runner image carrying the ' +
      'fix; that run\'s row will show the new source hash. Scores, the corpus, ' +
      'the judge panel and every arm are unaffected; history is not rewritten.',
  },
  {
    date: '2026-09-10',
    text:
      'Instrument reading, not a score change: the contract-behaviour check ' +
      'introduced with benchmark-report.v2 reads "action-not-rendered" on 53 of ' +
      'the 55 action-commit cells of the 2026-09-10 run, near-identically across ' +
      'all 11 arms and three providers. That uniformity is the validator, not the ' +
      'models: it locates the control by the action label\'s text and never ' +
      'clicks unnamed controls (issue #996; fix mirrors the harness\'s own ' +
      '"click every clickable, judge by the observed dispatch" rule). The column ' +
      'is not rendered on this page; it is present, self-described by kind and ' +
      'diagnostic, in the public report JSON. Treat it as an instrument reading ' +
      'until an entry here announces the fix. Quality scores, the corpus, the ' +
      'judge panel and every arm are unaffected; history is not rewritten. ' +
      'Same day, the fix: the validator now finds the control the way the ' +
      'generation harness does — controls that name the action first ' +
      '(data-action, aria-label, text), then every clickable, judged by the ' +
      'dispatch actually observed for that action (#996). A second defect found ' +
      'beneath it the same day: the check rendered each component with NO ' +
      'props, so a board or list that draws its controls from props was empty ' +
      'and had nothing to click; it now renders with the commit\'s fixture ' +
      'props — the same props the visual judge receives — and re-collects the ' +
      'live controls after every click, because a filter or an opened editor ' +
      're-renders the tree and a control found earlier may no longer exist. The ' +
      'column reads as a measurement again from the first run on a runner ' +
      'image carrying these ' +
      'fixes — the change-triggered run that follows their landing; that ' +
      'run\'s row will show the new source hash.',
  },
  {
    date: '2026-09-09',
    text:
      'Matrix: an OpenAI frontier arm added — openai-frontier = GPT-6 astra ' +
      '($10 / $50 per MTok), alongside the existing fast, balanced and premium ' +
      'OpenAI arms; the matrix is now 11 arms. As with claude-frontier, the arm ' +
      'carries the "premium" tier label (the tier vocabulary has no frontier ' +
      'value) and is a separate row. Scores for the new arm start with its first ' +
      'run on or after this date; every existing arm, the corpus, and the judge ' +
      'panel are unchanged, so prior rows stay comparable. Reports from this ' +
      'date also carry per-cell fields — the runtime-probe verdict and a ' +
      'contract-behaviour check re-run in-task for every cell — under ' +
      'meta.schemaVersion = "benchmark-report.v2"; these add disclosure and ' +
      'change no score. History is not rewritten.',
  },
  {
    date: '2026-09-07',
    text:
      'Generator identities de-modeled: the two generation harnesses are now ' +
      'identified as `ui-gen-default` and `ui-gen-advanced` (previously ' +
      '`ui-gen-default-haiku-4-5` and `ui-gen-advanced-opus-4-7`). A harness is ' +
      'not a model — the model under test is each arm’s own field — so the ids ' +
      'no longer carry one. Reports published from this date carry the new ids ' +
      'and `meta.schemaVersion = "benchmark-report.v1"`; earlier reports keep ' +
      'their ids unchanged (history is not rewritten). Scores, corpus, matrix, ' +
      'and the judge panel are unchanged.',
  },
  {
    date: '2026-09-03',
    text:
      'Disclosure: the in-loop evaluator’s per-criterion coverage now also ' +
      'counts the cells it bypassed by design (same-image low-risk cells, where ' +
      'no criterion applies). Those cells were always outside the coverage ' +
      'denominator and still are; the change is that a run whose every cell ' +
      'was bypassed now reads "no cell required the in-loop evaluator" instead ' +
      'of carrying no coverage disclosure at all — which was indistinguishable ' +
      'from a run that predates the instrument. Scores, corpus, matrix, and ' +
      'the judge panel are unchanged.',
  },
  {
    date: '2026-09-03',
    text:
      'Cadence refinement: the change detector now keys on a hash of the ' +
      'generation harness and runner source (and their declared ' +
      'dependencies), not on the runner image’s commit. Between ' +
      '2026-08-24 and 2026-09-01, five of the published runs were triggered ' +
      'by image rebuilds caused only by unrelated dependency-lockfile changes ' +
      '— honest re-measurements of an unchanged harness. Those rows stand; ' +
      'from this date such rebuilds no longer trigger a run. Scoring, corpus, ' +
      'matrix, and the judge panel are unchanged.',
  },
  {
    date: '2026-09-02',
    text:
      'Matrix: a Claude frontier arm added — claude-frontier = Claude Fable 5.1 ' +
      '($10 / $50 per MTok), alongside the existing fast (Haiku 4.5), balanced ' +
      '(Sonnet 5), and premium (Opus 5) arms. Both Opus 5 and Fable 5.1 carry ' +
      'the "premium" tier label (the tier vocabulary has no frontier value); ' +
      'they are separate arms with separate rows. Scores for the new arm ' +
      'start with the first run on or after this date; every existing arm, the ' +
      'corpus, and the judge panel are unchanged, so prior rows stay ' +
      'comparable. History is not rewritten.',
  },
  {
    date: '2026-09-02',
    text:
      'Judge disclosure now records the sampling each judge ACTUALLY ran with. ' +
      'The panel requests temperature 0 for reproducibility; the router ' +
      'strips sampling parameters for model families that reject them and ' +
      'reports what it applied. All three pinned judges accept temperature 0, ' +
      'so no published score changes — the line under each run simply says so ' +
      'per judge instead of asserting it.',
  },
  {
    date: '2026-08-25',
    text:
      'Post-hoc finding on the 2026-08-19 judge-coverage collapse: a second ' +
      'candidate cause surfaced — a billing suspension on the account behind ' +
      'the Gemini judge key overlapped that window (all 30 google-variant ' +
      'cells generated but zero were judged; generation preceded judging in ' +
      'each cell). Retroactively indistinguishable from judge rate limiting ' +
      'because failures were silently swallowed at the time — the defect the ' +
      '2026-08-20 resilience change fixed. No scores changed; billing alerts ' +
      'now exist on that account, so a repeat fails loudly.',
  },
  {
    date: '2026-08-21',
    text:
      'Cadence: weekly → change-triggered. The full matrix now fires only ' +
      'when the generation harness, model matrix, or runner changes (a daily ' +
      '03:00 UTC probe checks and exits otherwise), with a 28-day long-stop ' +
      'so provider-side model drift still gets caught. Run dates are ' +
      'therefore irregular by design — every published run corresponds to ' +
      'an actual update. Scoring and corpus are unchanged.',
  },
  {
    date: '2026-08-20',
    text:
      'Per-cell generation timeout for the published weekly run: 300s → 600s. ' +
      'On 2026-08-19, 7 heavy-prompt cells hit the 300s limit and produced no ' +
      'data; success rates on or after this change are measured under the ' +
      'longer budget. Generation wall time is still recorded per cell, so ' +
      'slowness remains visible.',
  },
  {
    date: '2026-08-20',
    text:
      'Judge-panel resilience: judge calls now retry with backoff and are ' +
      'concurrency-capped, and every report discloses its judge coverage ' +
      '(scored cells / generated cells) with a low-coverage flag under 80%. ' +
      'The 2026-08-19 run predates the disclosure fields: only 24 of its 79 ' +
      'generated cells (30%) carry a panel score — its aggregate scores are ' +
      'not representative. Scoring itself is unchanged (panel v3, same ' +
      'prompt); coverage disclosure is additive, not a comparability break.',
  },
  {
    date: '2026-08-19',
    text:
      'Cadence: daily → weekly (Mondays 03:00 UTC). Model matrix refreshed to ' +
      'the current standard lineups — Claude balanced/premium → Sonnet 5 / Opus 5, ' +
      'OpenAI balanced/premium → GPT-5.6 Terra / Sol, Google balanced → ' +
      'Gemini 3.7 Flash (premium stays 3.1 Pro Preview; no higher tier exists). ' +
      'Judge panel: the Google judge moved from a retired preview id to ' +
      'Gemini 3.5 Flash (panel version v2 → v3). Scores on or after this date ' +
      'are not comparable with earlier dates.',
  },
  {
    date: '2026-08-19',
    text:
      'Runs dated 2026-06-15 through 2026-08-19 show 0% success across every ' +
      'cell. That was a pipeline credential outage (the runner fired with ' +
      'unpopulated API-key secrets), not a model failure — no generation was ' +
      'ever attempted. Those runs are kept, honestly, as pipeline history.',
  },
];

/**
 * Standing methodology disclosure for the benchmark dashboard.
 *
 * Renders the static parts (what we measure / how we score / noise band)
 * always; the judge-panel and corpus parts fill in once a report is
 * loaded. This is the credibility surface — it explains the scale, the
 * panel, the variance, and — load-bearing — that we publish per-cell
 * scores, NOT a provider ranking.
 */
export function MethodologySection({ meta, commits, rawDataUrl }: Props) {
  const judges = meta?.judges;
  return (
    <section className="rule-line pt-6 mt-12 max-w-3xl">
      <p className="eyebrow mb-4">methodology</p>

      <div className="space-y-8 text-sm text-ink-3 leading-relaxed">
        <div>
          <h3 className="text-ink font-semibold mb-3">What we measure</h3>
          <dl className="space-y-2">
            {DIMENSIONS.map((d) => (
              <div key={d.label}>
                <dt className="font-mono text-ink inline">{d.label}</dt>
                <dd className="inline"> — {d.definition}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div>
          <h3 className="text-ink font-semibold mb-2">How we score</h3>
          <p>
            Each dimension is scored 0–100. The 5 dimensions are equally
            weighted (20% each) into a single 0–100 quality score. A cell
            passes at a threshold of 70.
          </p>
        </div>

        <div>
          <h3 className="text-ink font-semibold mb-2">Judge panel</h3>
          <p>
            Every score is the mean of a 3-model LLM judge panel — one model
            each from Anthropic, OpenAI, and Google — scored at temperature 0.
            Averaging across providers neutralizes single-model bias (no model
            grades only its own family), and we report the per-cell spread
            (max−min of the panel) as a disagreement signal.
          </p>
          {judges && judges.length > 0 && (
            <p className="font-mono text-xs text-ink-3 mt-2 text-wrap">
              panel: {judges.map(formatJudge).join(', ')}
            </p>
          )}
        </div>

        <div>
          <h3 className="text-ink font-semibold mb-2">Noise band</h3>
          <p>
            LLM-judge scores carry inherent variance — the same component can
            score a few points apart across runs. We surface the per-cell
            spread so you can see where the panel disagreed.{' '}
            <strong className="text-ink font-semibold">
              We publish per-cell scores, not a provider ranking.
            </strong>{' '}
            Small score gaps between providers are within the noise band and
            should not be read as one model being "better".
          </p>
        </div>

        {commits && commits.length > 0 && (
          <div>
            <h3 className="text-ink font-semibold mb-2">Corpus</h3>
            <p className="mb-2">
              {commits.length} fixed prompt{commits.length === 1 ? '' : 's'},
              run identically across every variant:
            </p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-ink-3">
              {commits.map((c) => (
                <li key={c.commitId} className="text-wrap">
                  {c.name} <span className="text-ink-3">({c.commitId})</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <h3 className="text-ink font-semibold mb-2">Methodology changes</h3>
          <ul className="space-y-2">
            {CHANGELOG.map((entry, i) => (
              <li key={`${entry.date}-${i}`}>
                <span className="font-mono text-xs text-ink-3 mr-2">
                  {entry.date}
                </span>
                {entry.text}
              </li>
            ))}
          </ul>
        </div>

        {rawDataUrl && (
          <div>
            <h3 className="text-ink font-semibold mb-2">Raw data</h3>
            <p>
              Every report on this dashboard is served as plain JSON.{' '}
              <a
                href={rawDataIndexHref(rawDataUrl)}
                className="font-mono text-ink underline underline-offset-2 hover:text-ink-3"
                target="_blank"
                rel="noreferrer"
              >
                index.json
              </a>{' '}
              lists every run; each links its per-day report.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
