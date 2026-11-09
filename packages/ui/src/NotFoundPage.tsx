import React from 'react';
import { Link } from 'react-router-dom';
import { EmptyState } from '@opsweave/ui/Ui';
import { PageHeader } from '@opsweave/ui/page-header';
import { buttonVariants } from '@opsweave/ui/button';
import { useT } from '@opsweave/platform-client/i18n';

export function NotFoundPage() {
  const t = useT();
  return <div className="page-stack"><PageHeader title={t('notFound.title')} /><EmptyState icon="search" title={t('notFound.empty.title')} description={t('notFound.empty.description')} action={<Link className={buttonVariants()} to="/">{t('notFound.action.backToOverview')}</Link>} /></div>;
}
