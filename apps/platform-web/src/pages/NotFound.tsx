import React from 'react';
import { Link } from 'react-router-dom';
import { EmptyState } from '../components/Ui';
import { PageHeader } from '../components/app/page-header';
import { buttonVariants } from '../components/ui/button';
import { useT } from '../i18n';

export function NotFoundPage() {
  const t = useT();
  return <div className="page-stack"><PageHeader title={t('notFound.title')} /><EmptyState icon="search" title={t('notFound.empty.title')} description={t('notFound.empty.description')} action={<Link className={buttonVariants()} to="/">{t('notFound.action.backToOverview')}</Link>} /></div>;
}
