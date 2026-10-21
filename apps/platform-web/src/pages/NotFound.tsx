import React from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, PageHeader } from '../components/Ui';

export function NotFoundPage() {
  return <div className="page-stack"><PageHeader title="Not found" /><EmptyState icon="search" title="This page does not exist" description="The route may belong to a plugin version that is no longer active." action={<Link className="btn btn-primary" to="/">Back to overview</Link>} /></div>;
}
