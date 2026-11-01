import * as React from 'react';
import { Icon } from '../components/Icons';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n';
import { cn } from '../lib/utils';
import {
  EVIDENCE_TRUST_CODES,
  evidenceTrustGlyph,
  evidenceTrustKey,
  evidenceTrustTone,
  isKnownEvidenceTrust,
  type EvidenceAssurance,
} from '../incidents';

/**
 * How this page renders the evidence `trust` field, and why it never says "verified".
 *
 * The field is the slice's anti-forgery column (ADR-G11-001 §2.2), and on this build it is
 * also *unverified input*: `insert_evidence` checks the word against the closed set and stores
 * it (apps/kernel/src/incidents.rs). Nothing recomputes a digest, nothing checks a signature -
 * that path is on an unmerged branch. So a caller that posts `SOURCE_ATTESTED` gets
 * `SOURCE_ATTESTED` back, and a UI that paints it with a green tick is making a claim the
 * server never checked.
 *
 * Three rules follow, and all three are visible in this file rather than in a review comment:
 *
 *   1. **No level is painted as confirmed.** `evidenceTrustTone` gives `SOURCE_ATTESTED` the
 *      `info` tone, not `ok`; `ok` is this shell's green tick and it stays reserved for facts
 *      the kernel established. The three levels remain three distinct treatments, because a
 *      reader must still be able to tell a source claim from a hand-written note.
 *   2. **The wording describes who claimed it, not what was proven.** Every level's tooltip is
 *      a sentence about the writer ("the writer attributes this row to a source"), and the
 *      panel carries `incidents.trust.baselineNote` once, stating that this build does not
 *      check the field.
 *   3. **Shape carries the level too.** Each level has its own glyph and its own border
 *      treatment, so the three survive greyscale, a colour deficiency and the dark theme.
 *
 * When the kernel starts verifying attestations, the change is local: `evidenceTrustTone`
 * returns `ok` for the verified level and `incidents.trust.baselineNote` is deleted. Until
 * then, both stay.
 */

const DETAIL_KEYS: Record<string, MessageKey> = {
  SOURCE_ATTESTED: 'incidents.trust.sourceAttestedDetail',
  OPERATOR_ASSERTED: 'incidents.trust.operatorAssertedDetail',
  UNVERIFIED: 'incidents.trust.unverifiedDetail',
};

function detailKey(code?: string | null): MessageKey {
  if (!code) return 'incidents.trust.unknownDetail';
  return DETAIL_KEYS[code.toUpperCase()] ?? 'incidents.trust.unknownDetail';
}

/**
 * One evidence row's trust level: glyph, word, and a tooltip naming who claimed it.
 *
 * Not a `Badge`: the shell's badge variants map `ok` to the same green used for "the box is
 * up", and this value has not earned it. The chip below is its own token-built shape, so the
 * day the field becomes verifiable the vocabulary can change without a page rewrite.
 *
 * `data-trust` carries the wire code for tests and tooling; what the reader sees is catalog
 * copy. A code outside the closed set is shown as sent, in the `unknown` treatment, and is
 * never folded into a neighbouring level - the audit's seven-status-codes-to-one-branch defect
 * is exactly that fold.
 */
export function TrustChip({ code, className }: { code?: string | null; className?: string }) {
  const t = useT();
  const known = isKnownEvidenceTrust(code);
  const tone = evidenceTrustTone(code);
  const raw = (code ?? '').trim().toUpperCase();
  // An unreadable value still has to be reportable, so the tooltip carries the code itself.
  const detail = known ? t(detailKey(code)) : t('incidents.trust.unknownDetail') + (raw ? ' (' + raw + ')' : '');
  return (
    <span
      className={cn('ow-trust', className)}
      data-trust={raw || 'UNSET'}
      data-trust-tone={tone}
      data-trust-known={known ? 'true' : 'false'}
      title={detail}
    >
      <Icon name={evidenceTrustGlyph(code)} size={13} />
      <span className="ow-trust-word">{t(evidenceTrustKey(code))}</span>
      <span className="sr-only"> {detail}</span>
    </span>
  );
}

/**
 * What a whole evidence set is worth, led by its weakest row.
 *
 * A verdict rests on the set, not on its best member, so the summary a reader needs before
 * signing one is the floor. The breakdown beside it is per declared level, so "three rows" is
 * never mistaken for "three attested rows", and a value outside the contract gets its own
 * sentence instead of disappearing into a total.
 */
export function TrustSummary({ assurance }: { assurance: EvidenceAssurance }) {
  const t = useT();
  if (assurance.total === 0) return null;
  const breakdown = EVIDENCE_TRUST_CODES
    .filter((code) => (assurance.byCode[code] ?? 0) > 0)
    .map((code) => t(evidenceTrustKey(code)) + ' ' + assurance.byCode[code]);
  return (
    <div className="ow-trust-summary" data-testid="incident-evidence-assurance" data-weakest={assurance.weakest ?? ''}>
      <p className="ow-trust-summary-line">
        <span className="ow-trust-summary-label">{t('incidents.trust.weakestLabel')}</span>
        <TrustChip code={assurance.weakest} />
      </p>
      <p className="ow-note">
        {t('incidents.trust.setSummary', { total: assurance.total, breakdown: breakdown.join(' · ') })}
      </p>
      {assurance.hasUnknown ? (
        <p className="ow-note" data-testid="incident-evidence-unknown-trust">{t('incidents.trust.unknownPresent')}</p>
      ) : null}
      {/* Said once per panel, not once per row: M1's budget argument applies to sentences as
          much as to dashed boxes. This is the sentence the whole column depends on. */}
      <p className="ow-note ow-note--boundary" data-testid="incident-trust-baseline">{t('incidents.trust.baselineNote')}</p>
    </div>
  );
}

/**
 * What the three words mean, under the table that uses them.
 *
 * A closed set of three is small enough to state in full, and stating it is what stops the
 * column from being read as a quality score. The order is weakest-claim-last so the legend
 * reads as a descent from "attributed to a source" to "no provenance claimed", which is the
 * direction `evidenceTrustRank` orders them in.
 *
 * It renders only once per page, below the evidence table: the per-row tooltip carries the same
 * sentence for the row the reader is actually pointing at, and repeating the legend per row is
 * the repetition M1 budgets against.
 */
export function TrustLegend() {
  const t = useT();
  return (
    <div className="ow-trust-legend" data-testid="incident-trust-legend">
      <p className="ow-note">{t('incidents.trust.columnNote')}</p>
      <dl className="ow-trust-legend-list">
        {EVIDENCE_TRUST_CODES.map((code) => (
          <div key={code} className="ow-trust-legend-row">
            <dt><TrustChip code={code} /></dt>
            <dd className="ow-note">{t(detailKey(code))}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
