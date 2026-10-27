import { describe, expect, it } from 'vitest';
import fixture from './fixtures/pipeline-definition.json';
import type { PipelineDefinition } from '../../types';
import { definitionDiff } from './diff';

const clone = (): PipelineDefinition => structuredClone(fixture) as unknown as PipelineDefinition;

describe('draft conflict diff redaction', () => {
  it('preserves audited numeric changes in the recovery UI', () => {
    const local = clone();
    const server = clone();
    local.nodes[0].config.timeoutSeconds = 19;
    server.nodes[0].config.timeoutSeconds = 18;
    const changes = definitionDiff(local, server).nodes[0].changes;
    expect(changes).toContainEqual({ path: 'timeoutSeconds', local: '19', server: '18' });
  });

  it('never surfaces unknown, string, array or nested config values', () => {
    const local = clone();
    const server = clone();
    local.nodes[0].config = {
      ...local.nodes[0].config,
      apiKey: 'LOCAL_SECRET_VALUE',
      nested: { accessToken: 'NESTED_SECRET_VALUE' },
      values: ['ARRAY_SECRET_VALUE'],
      endpoint: 'https://example.test?token=URL_SECRET_VALUE',
    };
    server.nodes[0].config = { ...server.nodes[0].config, apiKey: 'SERVER_SECRET_VALUE' };
    const diff = definitionDiff(local, server);
    const rendered = JSON.stringify(diff);
    for (const secret of ['LOCAL_SECRET_VALUE', 'NESTED_SECRET_VALUE', 'ARRAY_SECRET_VALUE', 'URL_SECRET_VALUE', 'SERVER_SECRET_VALUE']) {
      expect(rendered).not.toContain(secret);
    }
    expect(rendered).toContain('[REDACTED]');
  });

  it('treats an apparently public field with a string value as sensitive', () => {
    const local = clone();
    const server = clone();
    local.nodes[0].config.timeoutSeconds = 'SECRET_IN_NUMERIC_FIELD' as never;
    expect(JSON.stringify(definitionDiff(local, server))).not.toContain('SECRET_IN_NUMERIC_FIELD');
  });
});
