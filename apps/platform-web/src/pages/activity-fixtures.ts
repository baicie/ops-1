import type { AuditEvent } from '../types';

/**
 * Forty events captured from this deployment's own audit table (GET /api/v1/audit?limit=200,
 * 2026-10-30), verbatim - no invented rows, no edited payloads.
 *
 * They are here because the failure this page had to fix is a property of real data and not of a
 * synthetic list: on the deployment the first page of 25 cards rendered 15 distinct texts, and the
 * collision came from six `capability.service_invoke` rows against one capability whose only
 * difference was a request path. A fixture written by hand would have had nicely varied subjects
 * and the test around it would have passed while the page stayed unreadable.
 *
 * The first 25 presented rows of this capture ARE the page the review measured, which is what
 * activity-facts.test.ts asserts over.
 */
export const CAPTURED_EVENTS: AuditEvent[] = [
  {
    "id": "8d8e8f61-1d09-4ccf-9b6b-8359b37b959a",
    "eventType": "plugin.activated",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "plugin",
    "subjectId": "dev.opsweave.hello",
    "action": "plugin.activate",
    "result": "CONFIRMED",
    "details": {
      "activationRevision": 2,
      "deploymentId": "7ab1de1c-8d47-4bb4-b6b3-d0c1cf7e40fc",
      "imageRef": "127.0.0.1:15001/opsweave/hello-ts@sha256:52c8c22eab6e2419b3b86833e21fed3957354da14f207930bb7148ff9c1ac9bf",
      "policyDigest": "sha256:961838eabbed877c3a7f7dcf3d05f6954521b5310c7c116d0c257ebb22e98be4",
      "version": "0.0.1"
    },
    "requestId": null,
    "occurredAt": "2026-10-30T09:39:10.531744Z"
  },
  {
    "id": "95d182e3-8b82-4e1a-8020-9cc7b306ba29",
    "eventType": "plugin.enable_requested",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "plugin",
    "subjectId": "dev.opsweave.hello",
    "action": "plugin.enable",
    "result": "ACCEPTED",
    "details": {
      "deploymentId": "7ab1de1c-8d47-4bb4-b6b3-d0c1cf7e40fc",
      "version": "0.0.1"
    },
    "requestId": null,
    "occurredAt": "2026-10-30T08:41:02.939534Z"
  },
  {
    "id": "ef298976-3fea-44b1-8c8e-39e0b67615f6",
    "eventType": "plugin.enable_requested",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "plugin",
    "subjectId": "dev.opsweave.hello",
    "action": "plugin.enable",
    "result": "ACCEPTED",
    "details": {
      "deploymentId": "7ab1de1c-8d47-4bb4-b6b3-d0c1cf7e40fc",
      "version": "0.0.1"
    },
    "requestId": null,
    "occurredAt": "2026-10-30T08:32:09.285276Z"
  },
  {
    "id": "aed31d84-bc3c-4b63-b6dc-b0790b371d21",
    "eventType": "plugin.disabled",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "plugin",
    "subjectId": "dev.opsweave.hello",
    "action": "plugin.disable",
    "result": "CONFIRMED",
    "details": {
      "activationRevision": 1,
      "reason": "从插件列表停用",
      "version": "0.0.1"
    },
    "requestId": null,
    "occurredAt": "2026-10-30T08:31:21.303712Z"
  },
  {
    "id": "cb00e3ac-a6ca-4918-b5c2-45d861880d41",
    "eventType": "pipeline.draft_updated",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "pipeline_draft",
    "subjectId": "bfa394a1-9a22-4908-bcf6-10b3ef2d5ca9",
    "action": "update",
    "result": "ACCEPTED",
    "details": {
      "pipelineId": "host-metrics-pipeline",
      "version": 3
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:07:56.085990Z"
  },
  {
    "id": "7539751c-fe55-4885-b093-807fc3a113be",
    "eventType": "pipeline.draft_updated",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "pipeline_draft",
    "subjectId": "bfa394a1-9a22-4908-bcf6-10b3ef2d5ca9",
    "action": "update",
    "result": "ACCEPTED",
    "details": {
      "pipelineId": "host-metrics-pipeline",
      "version": 2
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:07:55.650472Z"
  },
  {
    "id": "03c42786-fab4-4263-916c-b696438e973d",
    "eventType": "pipeline.draft_created",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "pipeline_draft",
    "subjectId": "bfa394a1-9a22-4908-bcf6-10b3ef2d5ca9",
    "action": "create",
    "result": "ACCEPTED",
    "details": {
      "baseRevision": 9,
      "pipelineId": "host-metrics-pipeline"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:07:55.172755Z"
  },
  {
    "id": "8089afeb-a661-4c1f-890c-48d36da8b8d1",
    "eventType": "capability.service_invoke",
    "actorType": "WORKLOAD",
    "actorId": "opsweave.kernel.catalog",
    "subjectType": "capability",
    "subjectId": "data.catalog.v1",
    "action": "catalog.metadata.read",
    "result": "ACCEPTED",
    "details": {
      "path": "/api/data-catalog/datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/schemas",
      "provider": "opsweave.data-catalog"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:07:52.152938Z"
  },
  {
    "id": "dbc743dd-9477-499d-a11e-5ea38eef73f0",
    "eventType": "capability.service_invoke",
    "actorType": "WORKLOAD",
    "actorId": "opsweave.kernel.catalog",
    "subjectType": "capability",
    "subjectId": "data.catalog.v1",
    "action": "catalog.metadata.read",
    "result": "ACCEPTED",
    "details": {
      "path": "/api/data-catalog/datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "provider": "opsweave.data-catalog"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:07:52.141262Z"
  },
  {
    "id": "639614de-6fdd-43e7-9c57-bbe00a3a3309",
    "eventType": "pipeline.job_completed",
    "actorType": "NODE",
    "actorId": "n:9b426dab-27c4-45ce-9773-b51a3db4f246:i:01bf9675-1f3e-4cd0-b9b3-b9ae1b4e0d68:b:58be2459-d92e-43fb-98d5-18162de3f755",
    "subjectType": "job",
    "subjectId": "e273620e-0580-449f-b7ee-e23e3f065b9e",
    "action": "complete",
    "result": "ACCEPTED",
    "details": {
      "errorCode": null,
      "fencingSequence": 1,
      "status": "SUCCEEDED"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:07:49.455779Z"
  },
  {
    "id": "dd460241-e0d0-46dd-a9ec-20bc530be342",
    "eventType": "capability.service_invoke",
    "actorType": "WORKLOAD",
    "actorId": "opsweave.kernel.catalog",
    "subjectType": "capability",
    "subjectId": "data.catalog.v1",
    "action": "catalog.metadata.read",
    "result": "ACCEPTED",
    "details": {
      "path": "/api/data-catalog/datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/effect-receipts?effectId=efx:75dbbb496b4223dcc1651d54a7ce51de1abba160326886886656099cc7ff6a29",
      "provider": "opsweave.data-catalog"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:07:49.451377Z"
  },
  {
    "id": "5d096b34-f0b6-4c9f-b2fc-27d57d1cc5ee",
    "eventType": "pipeline.draft_published",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "pipeline",
    "subjectId": "host-metrics-pipeline",
    "action": "publish",
    "result": "ACCEPTED",
    "details": {
      "digest": "sha256:e7d3f6b43b2c32f6742446708581f958cd44702862ac2741787a2625df5362f6",
      "draftId": "b654a2c7-bcb0-44ca-9dac-9a8d8916e3dd",
      "revision": 9
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:07:46.547978Z"
  },
  {
    "id": "d3ef8ac2-7dfe-42f9-972e-cc97a62f0fbc",
    "eventType": "capability.service_invoke",
    "actorType": "WORKLOAD",
    "actorId": "opsweave.kernel.catalog",
    "subjectType": "capability",
    "subjectId": "data.catalog.v1",
    "action": "catalog.metadata.read",
    "result": "ACCEPTED",
    "details": {
      "path": "/api/data-catalog/datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/schemas",
      "provider": "opsweave.data-catalog"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:07:46.544720Z"
  },
  {
    "id": "bf0d596b-55c9-4bf8-9d09-df2b7e8d6993",
    "eventType": "capability.service_invoke",
    "actorType": "WORKLOAD",
    "actorId": "opsweave.kernel.catalog",
    "subjectType": "capability",
    "subjectId": "data.catalog.v1",
    "action": "catalog.metadata.read",
    "result": "ACCEPTED",
    "details": {
      "path": "/api/data-catalog/datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "provider": "opsweave.data-catalog"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:07:46.532837Z"
  },
  {
    "id": "5cc5caa4-27cc-48d0-916d-29ac8e00f8ec",
    "eventType": "capability.service_invoke",
    "actorType": "WORKLOAD",
    "actorId": "opsweave.kernel.catalog",
    "subjectType": "capability",
    "subjectId": "data.catalog.v1",
    "action": "catalog.metadata.read",
    "result": "ACCEPTED",
    "details": {
      "path": "/api/data-catalog/datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/schemas",
      "provider": "opsweave.data-catalog"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:07:46.379726Z"
  },
  {
    "id": "f06a7bfd-fd35-4c65-8638-2c39c5d117d4",
    "eventType": "capability.service_invoke",
    "actorType": "WORKLOAD",
    "actorId": "opsweave.kernel.catalog",
    "subjectType": "capability",
    "subjectId": "data.catalog.v1",
    "action": "catalog.metadata.read",
    "result": "ACCEPTED",
    "details": {
      "path": "/api/data-catalog/datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "provider": "opsweave.data-catalog"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:07:46.367207Z"
  },
  {
    "id": "fc125357-e4a1-4d91-ac24-66a800994aa6",
    "eventType": "pipeline.draft_updated",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "pipeline_draft",
    "subjectId": "b654a2c7-bcb0-44ca-9dac-9a8d8916e3dd",
    "action": "update",
    "result": "ACCEPTED",
    "details": {
      "pipelineId": "host-metrics-pipeline",
      "version": 2
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:07:45.979004Z"
  },
  {
    "id": "44467381-56bc-4c65-b541-73dde4e7c612",
    "eventType": "pipeline.draft_created",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "pipeline_draft",
    "subjectId": "b654a2c7-bcb0-44ca-9dac-9a8d8916e3dd",
    "action": "create",
    "result": "ACCEPTED",
    "details": {
      "baseRevision": 8,
      "pipelineId": "host-metrics-pipeline"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:07:45.767089Z"
  },
  {
    "id": "79f5f330-4912-45ce-a279-0df6ec33149e",
    "eventType": "pipeline.draft_updated",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "pipeline_draft",
    "subjectId": "db786d15-5cdb-4181-bd14-e5277ffddcad",
    "action": "update",
    "result": "ACCEPTED",
    "details": {
      "pipelineId": "host-metrics-pipeline",
      "version": 3
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:03:16.293729Z"
  },
  {
    "id": "38bd2da0-b904-49fe-babb-052674b5cee4",
    "eventType": "pipeline.draft_updated",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "pipeline_draft",
    "subjectId": "db786d15-5cdb-4181-bd14-e5277ffddcad",
    "action": "update",
    "result": "ACCEPTED",
    "details": {
      "pipelineId": "host-metrics-pipeline",
      "version": 2
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:03:15.668603Z"
  },
  {
    "id": "b3ebbc97-8b4e-4435-88d7-ffe657f50549",
    "eventType": "pipeline.draft_created",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "pipeline_draft",
    "subjectId": "db786d15-5cdb-4181-bd14-e5277ffddcad",
    "action": "create",
    "result": "ACCEPTED",
    "details": {
      "baseRevision": 8,
      "pipelineId": "host-metrics-pipeline"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:03:14.385883Z"
  },
  {
    "id": "0d730c27-22fa-4f91-98a8-1d8722c8eecf",
    "eventType": "capability.service_invoke",
    "actorType": "WORKLOAD",
    "actorId": "opsweave.kernel.catalog",
    "subjectType": "capability",
    "subjectId": "data.catalog.v1",
    "action": "catalog.metadata.read",
    "result": "ACCEPTED",
    "details": {
      "path": "/api/data-catalog/datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/schemas",
      "provider": "opsweave.data-catalog"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:03:08.964794Z"
  },
  {
    "id": "bcc3e72a-5f49-4e99-a63e-3aee26c92e9d",
    "eventType": "capability.service_invoke",
    "actorType": "WORKLOAD",
    "actorId": "opsweave.kernel.catalog",
    "subjectType": "capability",
    "subjectId": "data.catalog.v1",
    "action": "catalog.metadata.read",
    "result": "ACCEPTED",
    "details": {
      "path": "/api/data-catalog/datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "provider": "opsweave.data-catalog"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:03:08.952754Z"
  },
  {
    "id": "15db5fa8-23f3-4fea-bae0-955448ce2b86",
    "eventType": "pipeline.job_completed",
    "actorType": "NODE",
    "actorId": "n:9b426dab-27c4-45ce-9773-b51a3db4f246:i:01bf9675-1f3e-4cd0-b9b3-b9ae1b4e0d68:b:58be2459-d92e-43fb-98d5-18162de3f755",
    "subjectType": "job",
    "subjectId": "d577c70a-0131-43a0-bd3f-0af05cb0c4be",
    "action": "complete",
    "result": "ACCEPTED",
    "details": {
      "errorCode": null,
      "fencingSequence": 1,
      "status": "SUCCEEDED"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:03:04.896109Z"
  },
  {
    "id": "e5165f9a-a009-4674-99f6-f00e1d78b472",
    "eventType": "capability.service_invoke",
    "actorType": "WORKLOAD",
    "actorId": "opsweave.kernel.catalog",
    "subjectType": "capability",
    "subjectId": "data.catalog.v1",
    "action": "catalog.metadata.read",
    "result": "ACCEPTED",
    "details": {
      "path": "/api/data-catalog/datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/effect-receipts?effectId=efx:ca46cdb52a030d33fe0da0a06bf9802dcd2464f7df3fdbb4e38f747cb81017d0",
      "provider": "opsweave.data-catalog"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:03:04.891069Z"
  },
  {
    "id": "e4b080ee-06e4-4f20-a647-30713c4a91f7",
    "eventType": "pipeline.draft_published",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "pipeline",
    "subjectId": "host-metrics-pipeline",
    "action": "publish",
    "result": "ACCEPTED",
    "details": {
      "digest": "sha256:80bbe2df1c51c0362c636e94a4bc48477b9c3903ca2dba5083293b8138367f1a",
      "draftId": "e7e78f65-3d57-41bf-9105-9f932e0e7a50",
      "revision": 8
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:03:02.112748Z"
  },
  {
    "id": "e801b8ca-fd8a-4c06-bcb6-4c68d302ac6a",
    "eventType": "capability.service_invoke",
    "actorType": "WORKLOAD",
    "actorId": "opsweave.kernel.catalog",
    "subjectType": "capability",
    "subjectId": "data.catalog.v1",
    "action": "catalog.metadata.read",
    "result": "ACCEPTED",
    "details": {
      "path": "/api/data-catalog/datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/schemas",
      "provider": "opsweave.data-catalog"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:03:02.109302Z"
  },
  {
    "id": "4872ff22-bd74-497c-bfae-b3e7a27f5a42",
    "eventType": "capability.service_invoke",
    "actorType": "WORKLOAD",
    "actorId": "opsweave.kernel.catalog",
    "subjectType": "capability",
    "subjectId": "data.catalog.v1",
    "action": "catalog.metadata.read",
    "result": "ACCEPTED",
    "details": {
      "path": "/api/data-catalog/datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "provider": "opsweave.data-catalog"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:03:02.097269Z"
  },
  {
    "id": "57a50374-23d9-4dff-96c4-97d8e4987210",
    "eventType": "capability.service_invoke",
    "actorType": "WORKLOAD",
    "actorId": "opsweave.kernel.catalog",
    "subjectType": "capability",
    "subjectId": "data.catalog.v1",
    "action": "catalog.metadata.read",
    "result": "ACCEPTED",
    "details": {
      "path": "/api/data-catalog/datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/schemas",
      "provider": "opsweave.data-catalog"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:03:01.801632Z"
  },
  {
    "id": "0695a048-7b27-40c6-a7c3-ff8fa476ff2e",
    "eventType": "capability.service_invoke",
    "actorType": "WORKLOAD",
    "actorId": "opsweave.kernel.catalog",
    "subjectType": "capability",
    "subjectId": "data.catalog.v1",
    "action": "catalog.metadata.read",
    "result": "ACCEPTED",
    "details": {
      "path": "/api/data-catalog/datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "provider": "opsweave.data-catalog"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:03:01.784382Z"
  },
  {
    "id": "f519be06-67ad-4486-b71a-3872656fc0ad",
    "eventType": "pipeline.draft_updated",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "pipeline_draft",
    "subjectId": "e7e78f65-3d57-41bf-9105-9f932e0e7a50",
    "action": "update",
    "result": "ACCEPTED",
    "details": {
      "pipelineId": "host-metrics-pipeline",
      "version": 2
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:03:01.194772Z"
  },
  {
    "id": "0ed3fa71-102f-4481-8782-d9cf3186be4e",
    "eventType": "pipeline.draft_created",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "pipeline_draft",
    "subjectId": "e7e78f65-3d57-41bf-9105-9f932e0e7a50",
    "action": "create",
    "result": "ACCEPTED",
    "details": {
      "baseRevision": 7,
      "pipelineId": "host-metrics-pipeline"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T16:03:00.849839Z"
  },
  {
    "id": "23056a3e-b3a3-4a43-a564-636151ec7f37",
    "eventType": "pipeline.draft_updated",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "pipeline_draft",
    "subjectId": "26c0668b-9927-4ece-9d1b-6032a37b4993",
    "action": "update",
    "result": "ACCEPTED",
    "details": {
      "pipelineId": "host-metrics-pipeline",
      "version": 3
    },
    "requestId": null,
    "occurredAt": "2026-10-29T11:09:01.712794Z"
  },
  {
    "id": "07ea71c7-bf59-483e-8fc2-0a63110fd3d7",
    "eventType": "pipeline.draft_updated",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "pipeline_draft",
    "subjectId": "26c0668b-9927-4ece-9d1b-6032a37b4993",
    "action": "update",
    "result": "ACCEPTED",
    "details": {
      "pipelineId": "host-metrics-pipeline",
      "version": 2
    },
    "requestId": null,
    "occurredAt": "2026-10-29T11:09:00.129036Z"
  },
  {
    "id": "b6ce5f2d-3f25-4601-a159-cf485d2c5547",
    "eventType": "pipeline.draft_created",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "pipeline_draft",
    "subjectId": "26c0668b-9927-4ece-9d1b-6032a37b4993",
    "action": "create",
    "result": "ACCEPTED",
    "details": {
      "baseRevision": 7,
      "pipelineId": "host-metrics-pipeline"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T11:08:55.356385Z"
  },
  {
    "id": "e66d60a5-b543-4ece-a040-4c3c517c85e2",
    "eventType": "capability.service_invoke",
    "actorType": "WORKLOAD",
    "actorId": "opsweave.kernel.catalog",
    "subjectType": "capability",
    "subjectId": "data.catalog.v1",
    "action": "catalog.metadata.read",
    "result": "ACCEPTED",
    "details": {
      "path": "/api/data-catalog/datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/schemas",
      "provider": "opsweave.data-catalog"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T11:08:20.354456Z"
  },
  {
    "id": "e96f921d-0aac-43a8-99a7-422360271ebd",
    "eventType": "capability.service_invoke",
    "actorType": "WORKLOAD",
    "actorId": "opsweave.kernel.catalog",
    "subjectType": "capability",
    "subjectId": "data.catalog.v1",
    "action": "catalog.metadata.read",
    "result": "ACCEPTED",
    "details": {
      "path": "/api/data-catalog/datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "provider": "opsweave.data-catalog"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T11:08:20.342849Z"
  },
  {
    "id": "3d05b8f4-a622-4746-a45a-a40862564a1e",
    "eventType": "pipeline.job_completed",
    "actorType": "NODE",
    "actorId": "n:9b426dab-27c4-45ce-9773-b51a3db4f246:i:f9f14fc2-a6dd-4795-9d4f-2aec31f0632e:b:a7a814a0-31ab-4794-b836-93ac10d827cf",
    "subjectType": "job",
    "subjectId": "1285fbe8-9bb8-459f-b073-af245d32b3ae",
    "action": "complete",
    "result": "ACCEPTED",
    "details": {
      "errorCode": null,
      "fencingSequence": 1,
      "status": "SUCCEEDED"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T11:08:08.268345Z"
  },
  {
    "id": "9b0b8745-37be-4d05-8c76-d131f72d2494",
    "eventType": "capability.service_invoke",
    "actorType": "WORKLOAD",
    "actorId": "opsweave.kernel.catalog",
    "subjectType": "capability",
    "subjectId": "data.catalog.v1",
    "action": "catalog.metadata.read",
    "result": "ACCEPTED",
    "details": {
      "path": "/api/data-catalog/datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/effect-receipts?effectId=efx:e6603efff5d9d97510b120a566ba39997d6d236fcf32be9b684d4dc5bcef9af3",
      "provider": "opsweave.data-catalog"
    },
    "requestId": null,
    "occurredAt": "2026-10-29T11:08:08.264065Z"
  },
  {
    "id": "7db7f5ca-09bf-4a09-8dca-3d521c8d90cf",
    "eventType": "pipeline.draft_published",
    "actorType": "USER",
    "actorId": "3233782f-0cea-46f0-a71f-b1e549fcd9be",
    "subjectType": "pipeline",
    "subjectId": "host-metrics-pipeline",
    "action": "publish",
    "result": "ACCEPTED",
    "details": {
      "digest": "sha256:e42442085b8cd2d8c4aff9776d5784d1b9a71134a84f21617434db89bbd671fb",
      "draftId": "68a1ae1c-2555-4e12-8fb6-7a8c2addd220",
      "revision": 7
    },
    "requestId": null,
    "occurredAt": "2026-10-29T11:07:57.728888Z"
  }
] as AuditEvent[];
