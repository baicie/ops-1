import * as React from 'react';
import { Icon } from '../components/Icons';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n';
import { cn } from '../lib/utils';
import type { IncidentEvidence } from '../types';
import {
  EVIDENCE_TRUST_CODES,
  evidenceTrustGlyph,
  evidenceTrustKey,
  evidenceTrustTone,
  isKnownEvidenceTrust,
  type EvidenceAssurance,
} from '../incidents';

/**
 * How this page renders evidence provenance, and what each word is allowed to mean.
 *
 * Since G12 the column is the Kernel's verdict, not the writer's claim (ADR-015). A request
 * cannot set `verifiedTrust`; it may only state `claimedTrust`, and the Kernel records both.
 * A row reaches `SOURCE_ATTESTED` only when it carried an HMAC-SHA256 attestation over this
 * exact evidence tuple, verified against a configured source adapter whose secret the client
 * never holds. `OPERATOR_ASSERTED` is an authenticated operator submitting in their own name.
 * `UNVERIFIED` is what anything else gets, including every pre-0017 row that claimed to be
 * attested — migration 0017 downgraded those and left a note saying so.
 *
 * Three rules follow, and all three are visible in this file rather than in a review comment:
 *
 *   1. **Only a verified level is painted as confirmed.** `evidenceTrustTone` gives
 *      `SOURCE_ATTESTED` the `ok` tone — the green this shell reserves for facts the server
 *      established — and withholds it from the other two.
 *   2. **The wording names the check that produced the level**, not who asked for it. The
 *      tooltip says what the Kernel did, because that is now the thing the field measures.
 *   3. **Shape carries the level too.** Each level has its own glyph and its own border
 *      treatment, so the three survive greyscale, a colour deficiency and the dark theme.
 *
 * The row also carries `verificationMethod` and, when the Kernel downgraded a claim, a
 * `verificationNote`. `TrustDetail` renders that note: a reader who sees `UNVERIFIED` beside a
 * claim of provenance deserves the sentence explaining the gap, and it is the row's own.
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
 * One evidence row's provenance: glyph, word, and a tooltip naming the check behind it.
 *
 * `data-trust` carries the wire code for tests and tooling; what the reader sees is catalog
 * copy. A code outside the closed set is shown as sent, in the `unknown` treatment, and is
 * never folded into a neighbouring level - the audit's seven-status-codes-to-one-branch defect
 * is exactly that fold.
 */
export function TrustChip({ code, title: extra, className, ...rest }: { code?: string | null; title?: string; className?: string } & Record<`data-${string}`, string | undefined>) {
  const t = useT();
  const known = isKnownEvidenceTrust(code);
  const tone = evidenceTrustTone(code);
  const raw = (code ?? '').trim().toUpperCase();
  // An unreadable value still has to be reportable, so the tooltip carries the code itself.
  const detail = known ? t(detailKey(code)) : t('incidents.trust.unknownDetail') + (raw ? ' (' + raw + ')' : '');
  // `extra` is the row's own verification method (and adapter id when there is one). It is
  // appended rather than replacing `detail`, because the level's meaning and this row's
  // evidence for it are different facts and a reader needs both.
  const title = extra ? detail + ' — ' + extra : detail;
  return (
    <span
      className={cn('ow-trust', className)}
      data-trust={raw || 'UNSET'}
      data-trust-tone={tone}
      data-trust-known={known ? 'true' : 'false'}
      title={title}
      {...rest}
    >
      <Icon name={evidenceTrustGlyph(code)} size={13} />
      <span className="ow-trust-word">{t(evidenceTrustKey(code))}</span>
      <span className="sr-only"> {title}</span>
    </span>
  );
}

/**
 * The sentence a row needs when the Kernel's verdict and the submitter's claim disagree.
 *
 * G12 A1 made these two fields separate on purpose: a caller may claim anything in
 * {OPERATOR_ASSERTED, UNVERIFIED}, the Kernel then decides, and the common case where they
 * differ is a pre-0017 row that claimed SOURCE_ATTESTED and was downgraded by the migration.
 * Showing only the verdict would silently discard the claim; showing both with no explanation
 * would look like a contradiction, so the Kernel's own `verificationNote` supplies the reason
 * and this component prints it verbatim when it exists.
 *
 * It renders nothing when the claim and the verdict agree, because then there is no gap to
 * explain and a line saying "these agree" is noise on every row of the table.
 */
export function TrustGap({ row }: { row: IncidentEvidence }) {
  const t = useT();
  const claimed = (row.claimedTrust ?? '').trim().toUpperCase();
  const verified = (row.verifiedTrust ?? '').trim().toUpperCase();
  if (!claimed || claimed === verified) return null;
  return (
    <p className="ow-trust-gap" data-testid="incident-evidence-trust-gap" data-claimed={claimed} data-verified={verified}>
      {t('incidents.trust.gap', { claimed: t(evidenceTrustKey(claimed)), verified: t(evidenceTrustKey(verified)) })}
      {row.verificationNote ? ' ' + row.verificationNote : null}
    </p>
  );
}

/**
 * What a whole evidence set is worth, led by its weakest row.
 *
 * A verdict rests on the set, not on its best member, so the summary a reader needs before
 * signing one is the floor. The breakdown beside it is per verified level, so "three rows" is
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
      <p className="ow-note ow-note--boundary" data-testid="incident-trust-baseline">{t('incidents.trust.columnNote')}</p>
    </div>
  );
}

/**
 * What the three words mean, under the table that uses them.
 *
 * A closed set of three is small enough to state in full, and stating it is what stops the
 * column from being read as a quality score. The order is weakest-verdict-last so the legend
 * reads as a descent from "the Kernel verified an adapter's signature" to "nothing was
 * verified", which is the direction `evidenceTrustRank` orders them in.
 *
 * It renders only once per page, below the evidence table: the per-row tooltip carries the same
 * sentence for the row the reader is actually pointing at, and repeating the legend per row is
 * the repetition M1 budgets against.
 *
 * The column-wide caveat is NOT repeated here: `TrustSummary` already states it once above the
 * table, and rendering it again under the same panel is the duplication M1 exists to prevent.
 */
export function TrustLegend() {
  const t = useT();
  return (
    <div className="ow-trust-legend" data-testid="incident-trust-legend">
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
