import type {
  ApiErrorBody,
  Batch,
  ConfirmJudgmentRequest,
  IngestReceiptRequest,
  IngestReceiptResponse,
  PendingWrite,
  VersionRequest,
} from '../api/batchTypes'
import type { BatchMeasurement } from '../api/batchTypes'
import { samplingApi } from './api'

export type BatchConflict = Extract<ApiErrorBody, { error: 'VERSION_CONFLICT' }>

type BatchActionResponse = { batch: Batch; message: string; changed?: boolean }

export const batchApi = samplingApi.injectEndpoints({
  endpoints: (builder) => ({
    getBatches: builder.query<Batch[], void>({
      query: () => 'api/batches',
      providesTags: ['Batches'],
    }),
    getPendingWrites: builder.query<PendingWrite[], void>({
      query: () => 'api/pending-writes',
      providesTags: ['PendingWrites'],
    }),
    ingestReceipt: builder.mutation<IngestReceiptResponse, IngestReceiptRequest>({
      query: (body) => ({ url: 'api/batches/ingest', method: 'POST', body }),
      invalidatesTags: ['Batches', 'PendingWrites'],
    }),
    retryPendingWrite: builder.mutation<IngestReceiptResponse, string>({
      query: (token) => ({ url: `api/pending-writes/${token}/retry`, method: 'POST' }),
      invalidatesTags: ['Batches', 'PendingWrites'],
    }),
    upgradeLegacy: builder.mutation<BatchActionResponse, { sampleId: string; supplierOrderNo: string; supplierName?: string }>({
      query: ({ sampleId, ...body }) => ({ url: `api/batches/by-sample/${sampleId}/upgrade-legacy`, method: 'POST', body }),
      invalidatesTags: ['Batches'],
    }),
    syncPlanChanged: builder.mutation<BatchActionResponse, string>({
      query: (sampleId) => ({ url: `api/batches/by-sample/${sampleId}/plan-changed`, method: 'POST' }),
      invalidatesTags: ['Batches'],
    }),
    addReviewAnnotation: builder.mutation<BatchActionResponse, { sampleId: string; content?: string }>({
      query: ({ sampleId, ...body }) => ({ url: `api/batches/by-sample/${sampleId}/review-annotation`, method: 'POST', body }),
      invalidatesTags: ['Batches'],
    }),
    confirmJudgment: builder.mutation<BatchActionResponse, { sampleId: string } & ConfirmJudgmentRequest>({
      query: ({ sampleId, ...body }) => ({ url: `api/batches/by-sample/${sampleId}/confirm-judgment`, method: 'POST', body }),
      invalidatesTags: ['Batches'],
    }),
    saveMeasurements: builder.mutation<BatchActionResponse, { sampleId: string; version: number; by: string; measurements: BatchMeasurement[] }>({
      query: ({ sampleId, ...body }) => ({ url: `api/batches/by-sample/${sampleId}/measurements`, method: 'PATCH', body }),
      invalidatesTags: ['Batches'],
    }),
    lockBatch: builder.mutation<BatchActionResponse, { sampleId: string } & VersionRequest>({
      query: ({ sampleId, ...body }) => ({ url: `api/batches/by-sample/${sampleId}/lock`, method: 'POST', body }),
      invalidatesTags: ['Batches'],
    }),
    unlockBatch: builder.mutation<BatchActionResponse, { sampleId: string } & VersionRequest>({
      query: ({ sampleId, ...body }) => ({ url: `api/batches/by-sample/${sampleId}/unlock`, method: 'POST', body }),
      invalidatesTags: ['Batches'],
    }),
    finalizeBatch: builder.mutation<BatchActionResponse, { sampleId: string } & VersionRequest>({
      query: ({ sampleId, ...body }) => ({ url: `api/batches/by-sample/${sampleId}/finalize`, method: 'POST', body }),
      invalidatesTags: ['Batches'],
    }),
  }),
})

export const {
  useGetBatchesQuery,
  useGetPendingWritesQuery,
  useIngestReceiptMutation,
  useRetryPendingWriteMutation,
  useUpgradeLegacyMutation,
  useSyncPlanChangedMutation,
  useAddReviewAnnotationMutation,
  useConfirmJudgmentMutation,
  useSaveMeasurementsMutation,
  useLockBatchMutation,
  useUnlockBatchMutation,
  useFinalizeBatchMutation,
} = batchApi
