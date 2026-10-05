export type Measurement = {
  key: string
  name: string
  spec: number
  actual: number
  tolerance: number
}

export type Annotation = {
  id: string
  x: number
  y: number
  part: string
  content: string
  author: string
  status: '待处理' | '已解决'
}

export type RevisionProposal = {
  id: string
  author: string
  role: string
  content: string
  affectedPart: string
  status: '待决定' | '已采纳' | '未采纳'
}

export type Round = '第一轮' | '第二轮' | '第三轮'

export type Sample = {
  id: string
  styleCode: string
  styleName: string
  category: string
  developmentSeason: string
  supplier: string
  dueDate: string
  owner: string
  status: '开发中' | '待审核' | '已锁定'
  fabric: string
  colorway: string
  craft: string[]
  measurements: Record<Round, Measurement[]>
  annotations: Annotation[]
  proposals: RevisionProposal[]
  attachments: Array<{ name: string; type: string; owner: string }>
  comments: Array<{ id: string; author: string; content: string; date: string }>
}

// —— 交样批次：把供应商回执、尺寸实测、审核锁定接成同一份批次 ——

export type BatchStatus = '待接收' | '已接收' | '差异待确认' | '已锁定' | '已失效' | '已定版'

export type WriteState = '已写入' | '写入失败' | '待重试'

export type BatchDiffItem = {
  field: string
  label: string
  onSite: string | number
  incoming: string | number
}

export type BatchConflict = {
  occurredAt: string
  submittedBy: string
  diffs: BatchDiffItem[]
  /** 后到回执带来的完整尺寸，用于“采纳后到值” */
  incoming: Measurement[]
  acknowledged: boolean
}

export type LockConclusion = {
  lockedAt: string
  lockedBy: string
  round: Round
  measurementPassRate: number
  openAnnotations: number
  stale: boolean
}

export type DeliveryBatch = {
  id: string
  batchNo: string
  sampleId: string
  round: Round
  /** 供应商单号；旧草稿无单号时为空，升级为首版 */
  supplierNo: string
  revision: string
  /** 幂等键：供应商单号#修订，同号重传只算一次 */
  idempotencyKey: string
  source: '供应商系统' | '手工补录' | '旧草稿升级'
  status: BatchStatus
  receivedAt: string
  receivedBy: string
  /** 回执带来的尺寸实测 */
  measurements: Measurement[]
  /** 尺寸或批注变化后，超差判断与锁定结论失效 */
  stale: boolean
  staleReasons: string[]
  conflict: BatchConflict | null
  lockConclusion: LockConclusion | null
  writeState: WriteState
  failureReason: string | null
  retryCount: number
  upgradedFromLegacy: boolean
}

/** 外部系统推送的交样回执 */
export type ReceiptPush = {
  supplierNo: string
  revision?: string
  sampleId: string
  round: Round
  measurements: Measurement[]
  submittedBy: string
  source?: '供应商系统' | '手工补录'
  /** 演示用：强制写入失败 */
  forceFailure?: boolean
  failureReason?: string
}

/** 外部系统待接收推送记录（MSW 模拟） */
export type SupplierReceipt = ReceiptPush & {
  id: string
  pushedAt: string
  status: '待处理' | '已处理'
}
