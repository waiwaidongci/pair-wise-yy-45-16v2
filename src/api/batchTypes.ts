export type BatchMeasurement = {
  key: string
  name: string
  spec: number
  actual: number
  tolerance: number
}

export type DeviationItem = BatchMeasurement & {
  deviation: number
  outOfTolerance: boolean
}

export type JudgmentStatus = '未判定' | '已确认'
export type LockStatus = '未锁定' | '已锁定' | '已失效'

export type Judgment = {
  status: JudgmentStatus
  confirmedBy: string | null
  confirmedAt: string | null
  /** 确认结论所依据的尺寸+方案指纹 */
  basisFingerprint: string | null
  items: DeviationItem[]
  stale: boolean
  staleReason: string | null
}

export type LockInfo = {
  status: LockStatus
  lockedBy: string | null
  lockedAt: string | null
  basisFingerprint: string | null
  finalVersion: number | null
}

export type ReceiptStatus = 'accepted' | 'duplicate' | 'expired'

export type BatchReceipt = {
  idempotencyKey: string
  supplierOrderNo: string
  supplierName: string
  revision: number
  receivedAt: string
  note: string
  status: ReceiptStatus
}

export type BatchEvent = {
  id: string
  at: string
  type: 'receipt' | 'judgment' | 'lock' | 'plan' | 'measurement' | 'system'
  message: string
}

/** 写入失败后保留下来的未完成回执，可原载荷重试 */
export type PendingWrite = {
  token: string
  sampleId: string
  supplierName: string
  supplierOrderNo: string | null
  revision: number | null
  measurements: BatchMeasurement[] | null
  note: string
  createdAt: string
  lastError: string
  attempts: number
}

export type Batch = {
  id: string
  sampleId: string
  supplierName: string
  /** 乐观锁版本：任何生效变更都递增，提交时必须带当前版本 */
  version: number
  supplierOrderNo: string | null
  revision: number
  measurements: BatchMeasurement[]
  planSignals: string[]
  receivedAt: string | null
  receipts: BatchReceipt[]
  judgment: Judgment
  lock: LockInfo
  finalized: boolean
  finalizedAt: string | null
  submitWinner: { by: string; at: string; baseVersion: number } | null
  legacyDraft: { note: string; createdAt: string } | null
  events: BatchEvent[]
}

/* ---------- 请求 / 响应 ---------- */

export type IngestReceiptRequest = {
  sampleId: string
  supplierName?: string
  supplierOrderNo?: string | null
  revision?: number | null
  measurements?: BatchMeasurement[] | null
  note?: string
  idempotencyKey?: string
  /** 模拟供应商系统写入失败（网络抖动 / 5xx） */
  simulateWriteFailure?: boolean
}

export type IngestReceiptResponse = {
  batch: Batch
  receipt: BatchReceipt | null
  outcome: 'accepted' | 'duplicate' | 'expired' | 'write-failed'
  message: string
  pendingWrite?: PendingWrite
}

export type FieldDiff = {
  path: string
  label: string
  client: string
  server: string
}

export type ApiErrorBody =
  | {
      error: 'VERSION_CONFLICT'
      message: string
      currentVersion: number
      winner: Batch['submitWinner']
      serverBatch: Batch
      fieldDiffs: FieldDiff[]
    }
  | {
      error: 'JUDGMENT_NOT_CONFIRMED' | 'LOCKED_READONLY' | 'FINALIZED' | 'NOT_FOUND' | 'MISSING_ORDER_NO' | 'BAD_REQUEST'
      message: string
    }

export type ConfirmJudgmentRequest = {
  version: number
  by: string
  measurements?: BatchMeasurement[]
}

export type VersionRequest = { version: number; by: string }
