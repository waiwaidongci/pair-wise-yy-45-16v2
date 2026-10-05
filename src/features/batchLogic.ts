import type {
  BatchConflict,
  BatchDiffItem,
  DeliveryBatch,
  LockConclusion,
  Measurement,
  ReceiptPush,
} from '../api/types'

export const ROUNDS = ['第一轮', '第二轮', '第三轮'] as const

/** 旧草稿没有供应商单号时升级为首版 */
export const normalizeRevision = (revision: string | undefined | null, legacy: boolean): string => {
  if (legacy || !revision || !revision.trim()) return '首版'
  return revision.trim()
}

/** 幂等键：供应商单号 + 修订，同号重传只算一次 */
export const idempotencyKeyOf = (supplierNo: string, revision: string): string =>
  `${supplierNo.trim()}#${revision.trim()}`

export const measurementPassRate = (measurements: Measurement[]): number => {
  if (!measurements.length) return 0
  const passed = measurements.filter((m) => Math.abs(m.actual - m.spec) <= m.tolerance).length
  return Math.round((passed / measurements.length) * 100)
}

/** 超差项数 */
export const overToleranceCount = (measurements: Measurement[]): number =>
  measurements.filter((m) => Math.abs(m.actual - m.spec) > m.tolerance).length

/** 比较两份尺寸，生成差异项（现场值 vs 后到值） */
export const diffMeasurements = (onSite: Measurement[], incoming: Measurement[]): BatchDiffItem[] => {
  const diffs: BatchDiffItem[] = []
  const incomingMap = new Map(incoming.map((m) => [m.key, m]))
  for (const on of onSite) {
    const inc = incomingMap.get(on.key)
    if (!inc) {
      diffs.push({ field: on.key, label: `${on.name}（${on.key}）`, onSite: on.actual, incoming: '—' })
    } else if (Math.abs(inc.actual - on.actual) > 0.001) {
      diffs.push({ field: on.key, label: on.name, onSite: on.actual, incoming: inc.actual })
    }
  }
  const onSiteKeys = new Set(onSite.map((m) => m.key))
  for (const inc of incoming) {
    if (!onSiteKeys.has(inc.key)) {
      diffs.push({ field: inc.key, label: `${inc.name}（新增）`, onSite: '—', incoming: inc.actual })
    }
  }
  return diffs
}

export type ReceiveResult =
  | { kind: 'created'; batch: DeliveryBatch }
  | { kind: 'duplicate'; existing: DeliveryBatch }
  | { kind: 'conflict'; existing: DeliveryBatch; diffs: BatchDiffItem[] }
  | { kind: 'failed'; error: string; batch: DeliveryBatch }

const genId = () => `B-${Date.now()}-${Math.floor(Math.random() * 1e4)}`

/**
 * 接收供应商回执主逻辑。
 * - 同号重传（幂等键相同）只算一次；尺寸有差异时按先到生效处理。
 * - 旧草稿（无供应商单号）升级为首版。
 * - 写入失败时保留未完成回执，等待重试。
 */
export function receiveReceiptLogic(
  batches: DeliveryBatch[],
  push: ReceiptPush,
  now: string,
): { batches: DeliveryBatch[]; result: ReceiveResult } {
  const supplierNo = (push.supplierNo ?? '').trim()
  const isLegacy = !supplierNo
  const revision = normalizeRevision(push.revision, isLegacy)
  const idemKey = isLegacy
    ? `LEGACY#${push.sampleId}#${push.round}#首版`
    : idempotencyKeyOf(supplierNo, revision)

  // 同号重传只算一次
  const existing = batches.find((b) => b.idempotencyKey === idemKey)
  if (existing) {
    const diffs = diffMeasurements(existing.measurements, push.measurements)
    if (diffs.length === 0) {
      return { batches, result: { kind: 'duplicate', existing } }
    }
    // 先到生效：保留现场值（existing.measurements），记录后到差异
    const conflict: BatchConflict = {
      occurredAt: now,
      submittedBy: push.submittedBy,
      diffs,
      incoming: push.measurements.map((m) => ({ ...m })),
      acknowledged: false,
    }
    const updated: DeliveryBatch = { ...existing, status: '差异待确认', conflict }
    return {
      batches: batches.map((b) => (b.id === existing.id ? updated : b)),
      result: { kind: 'conflict', existing: updated, diffs },
    }
  }

  // 新建批次
  const base: DeliveryBatch = {
    id: genId(),
    batchNo: `DN-${String(batches.length + 1).padStart(4, '0')}`,
    sampleId: push.sampleId,
    round: push.round,
    supplierNo: supplierNo || '待补录',
    revision,
    idempotencyKey: idemKey,
    source: isLegacy ? '旧草稿升级' : (push.source ?? '供应商系统'),
    status: '已接收',
    receivedAt: now,
    receivedBy: push.submittedBy,
    measurements: push.measurements.map((m) => ({ ...m })),
    stale: false,
    staleReasons: [],
    conflict: null,
    lockConclusion: null,
    writeState: '已写入',
    failureReason: null,
    retryCount: 0,
    upgradedFromLegacy: isLegacy,
  }

  if (push.forceFailure) {
    const failed: DeliveryBatch = {
      ...base,
      status: '待接收',
      writeState: '写入失败',
      failureReason: push.failureReason ?? '写入工作台失败：网络超时，回执已保留，可重试',
    }
    return {
      batches: [...batches, failed],
      result: { kind: 'failed', error: failed.failureReason!, batch: failed },
    }
  }

  return { batches: [...batches, base], result: { kind: 'created', batch: base } }
}

/** 尺寸或批注变化后，超差判断与锁定结论失效 */
export function invalidateBatch(batch: DeliveryBatch, reason: string): DeliveryBatch {
  if (batch.status === '待接收' || batch.status === '已定版') return batch
  const wasLocked = batch.status === '已锁定' || Boolean(batch.lockConclusion)
  return {
    ...batch,
    stale: true,
    staleReasons: Array.from(new Set([...batch.staleReasons, reason])),
    status: wasLocked ? '已失效' : batch.status,
    lockConclusion: batch.lockConclusion ? { ...batch.lockConclusion, stale: true } : null,
  }
}

/** 定版前校验：未重新确认不能进入定版 */
export function canFinalize(batch: DeliveryBatch): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (batch.writeState === '写入失败' || batch.status === '待接收') reasons.push('回执尚未成功写入')
  if (batch.stale || batch.status === '已失效') reasons.push('尺寸或批注已变化，超差判断与锁定结论已失效，需重新确认')
  if (batch.conflict && !batch.conflict.acknowledged) reasons.push('存在未确认的并发差异')
  if (batch.status !== '已锁定') reasons.push('尚未完成审核锁定')
  return { ok: reasons.length === 0, reasons }
}

/** 失效后重新确认：用当前尺寸与未关闭批注数重算锁定结论 */
export function reconfirmBatch(
  batch: DeliveryBatch,
  currentMeasurements: Measurement[],
  openAnnotations: number,
  actor: string,
  now: string,
): DeliveryBatch {
  const hadLock = batch.status === '已锁定' || batch.status === '已失效' || Boolean(batch.lockConclusion)
  const lockConclusion: LockConclusion | null = hadLock
    ? {
        lockedAt: now,
        lockedBy: actor,
        round: batch.round,
        measurementPassRate: measurementPassRate(currentMeasurements),
        openAnnotations,
        stale: false,
      }
    : null
  return {
    ...batch,
    stale: false,
    staleReasons: [],
    status: hadLock ? '已锁定' : '已接收',
    lockConclusion,
    conflict: batch.conflict?.acknowledged ? null : batch.conflict,
  }
}

/** 确认并发差异：先到生效保留现场值；或采纳后到值 */
export function acknowledgeConflict(batch: DeliveryBatch, keepOnSite: boolean): DeliveryBatch {
  if (!batch.conflict) return batch
  const measurements = keepOnSite ? batch.measurements : batch.conflict.incoming.map((m) => ({ ...m }))
  return {
    ...batch,
    status: '已接收',
    measurements,
    stale: false,
    staleReasons: [],
    conflict: { ...batch.conflict, acknowledged: true },
  }
}

/** 写入失败后重试：保留的未完成回执接着重试 */
export function retryReceipt(batch: DeliveryBatch, now: string): DeliveryBatch {
  return {
    ...batch,
    status: '已接收',
    writeState: '已写入',
    failureReason: null,
    retryCount: batch.retryCount + 1,
    receivedAt: now,
  }
}
