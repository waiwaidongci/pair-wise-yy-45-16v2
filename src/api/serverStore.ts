import { seedSamples } from './seed'
import type { Batch, BatchEvent, BatchMeasurement, PendingWrite } from './batchTypes'
import type { Sample } from './types'
import { basisFingerprint, evaluateMeasurements } from '../features/batchLogic'

/** 工作台评审档案（批注 / 方案）是批次方案指纹的来源，回执处理器与批次处理器共享 */
export const samples: Sample[] = structuredClone(seedSamples)

export const batches: Batch[] = []

/** 同号重传去重表：(供应商单号, 修订) -> 批次 id + 幂等键 */
export const receiptDedup = new Map<string, string>()

/** 未完成回执：写入失败也先落盘，等待原载荷重试 */
export const pendingWrites: PendingWrite[] = []

export function nowLabel(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

let eventSequence = 0
export function batchEvent(type: BatchEvent['type'], message: string): BatchEvent {
  eventSequence += 1
  return { id: `EV-${Date.now()}-${eventSequence}`, at: nowLabel(), type, message }
}

/** 从内部评审档案（批注 + 改版方案）派生方案信号 */
export function computePlanSignals(sample: Sample): string[] {
  const annotationSignals = sample.annotations.map((item) => `批注[${item.status}] ${item.part}：${item.content}`)
  const proposalSignals = sample.proposals.map((item) => `方案[${item.status}] ${item.affectedPart}：${item.content}`)
  return [...annotationSignals, ...proposalSignals].sort()
}

function buildBatch(
  id: string,
  sample: Sample,
  partial: Pick<Batch, 'supplierOrderNo' | 'revision' | 'receivedAt' | 'receipts' | 'version'> &
    Partial<Pick<Batch, 'measurements' | 'judgment' | 'legacyDraft'>>,
): Batch {
  const measurements: BatchMeasurement[] = partial.measurements ?? sample.measurements['第三轮']
  const planSignals = computePlanSignals(sample)
  const items = evaluateMeasurements(measurements)
  const confirmed = partial.judgment?.status === '已确认'
  const basis = basisFingerprint(measurements, planSignals)
  return {
    id,
    sampleId: sample.id,
    supplierName: sample.supplier,
    version: partial.version,
    supplierOrderNo: partial.supplierOrderNo,
    revision: partial.revision,
    measurements,
    planSignals,
    receivedAt: partial.receivedAt,
    receipts: partial.receipts,
    judgment: partial.judgment ?? {
      status: '未判定',
      confirmedBy: null,
      confirmedAt: null,
      basisFingerprint: null,
      items,
      stale: false,
      staleReason: null,
    },
    lock: { status: '未锁定', lockedBy: null, lockedAt: null, basisFingerprint: null, finalVersion: null },
    finalized: false,
    finalizedAt: null,
    submitWinner: null,
    legacyDraft: partial.legacyDraft ?? null,
    events: [],
  }
}

function seed() {
  const sample018 = samples.find((item) => item.id === 'SMP-26018')!
  const sample021 = samples.find((item) => item.id === 'SMP-26021')!
  const sample024 = samples.find((item) => item.id === 'SMP-26024')!

  // 第三轮实测：胸围 +2.0（超差 ±1.5）、后衣长 -1.4（超差 ±1），其余达标
  const measured018: BatchMeasurement[] = [
    { key: 'chest', name: '胸围', spec: 108, actual: 110.0, tolerance: 1.5 },
    { key: 'waist', name: '腰围', spec: 94, actual: 95.0, tolerance: 1.5 },
    { key: 'hem', name: '下摆围', spec: 112, actual: 112.4, tolerance: 2 },
    { key: 'length', name: '后衣长', spec: 72, actual: 70.6, tolerance: 1 },
    { key: 'shoulder', name: '肩宽', spec: 48, actual: 48.5, tolerance: 1 },
    { key: 'sleeve', name: '袖长', spec: 61, actual: 61.0, tolerance: 1 },
  ]
  const basis018 = basisFingerprint(measured018, computePlanSignals(sample018))
  const batch018 = buildBatch('BATCH-SMP-26018', sample018, {
    supplierOrderNo: 'PO-MZ-2609-118',
    revision: 2,
    receivedAt: '2026-10-04 09:20',
    version: 3,
    measurements: measured018,
    receipts: [
      {
        idempotencyKey: 'seed-key-118-r1',
        supplierOrderNo: 'PO-MZ-2609-118',
        supplierName: sample018.supplier,
        revision: 1,
        receivedAt: '2026-10-02 16:40',
        note: '首版交样回执',
        status: 'accepted',
      },
      {
        idempotencyKey: 'seed-key-118-r2',
        supplierOrderNo: 'PO-MZ-2609-118',
        supplierName: sample018.supplier,
        revision: 2,
        receivedAt: '2026-10-04 09:20',
        note: '晚到修订：领底衬调整后重传尺寸',
        status: 'accepted',
      },
    ],
    judgment: {
      status: '已确认',
      confirmedBy: '沈岚',
      confirmedAt: '2026-10-04 10:05',
      basisFingerprint: basis018,
      items: evaluateMeasurements(measured018),
      stale: false,
      staleReason: null,
    },
  })
  batch018.events = [
    batchEvent('receipt', '收到 PO-MZ-2609-118 修订 1 交样回执（首版）'),
    batchEvent('receipt', '收到 PO-MZ-2609-118 修订 2 交样回执（晚到修订，覆盖首版尺寸）'),
    batchEvent('judgment', '沈岚确认超差判定：胸围、后衣长超差，其余达标'),
  ]
  receiptDedup.set('PO-MZ-2609-118::1', batch018.id)
  receiptDedup.set('PO-MZ-2609-118::2', batch018.id)
  batches.push(batch018)

  // 26021：尚无供应商回执；有一份没有供应商单号的旧草稿；上一条回执写入失败待重试
  const measured021: BatchMeasurement[] = sample021.measurements['第三轮']
  const batch021 = buildBatch('BATCH-SMP-26021', sample021, {
    supplierOrderNo: null,
    revision: 0,
    receivedAt: null,
    version: 0,
    measurements: measured021,
    receipts: [],
    legacyDraft: { note: '门襟压线待供应商确认定位钻眼方案，草稿先记在这里。', createdAt: '2026-09-30 18:12' },
  })
  batch021.events = [batchEvent('system', '本地旧草稿创建时尚未回填供应商单号，等待升级为首版回执')]
  batches.push(batch021)

  pendingWrites.push({
    token: 'PEND-26024-01',
    sampleId: 'SMP-26024',
    supplierName: '南通云序制衣',
    supplierOrderNo: 'PO-YX-2610-024',
    revision: 1,
    measurements: sample024.measurements['第三轮'],
    note: '首版交样回执（上次写入失败，待重试）',
    createdAt: '2026-10-04 15:36',
    lastError: '供应商网关 502 Bad Gateway',
    attempts: 1,
  })
}

export function resetServerStore() {
  samples.length = 0
  samples.push(...structuredClone(seedSamples))
  batches.length = 0
  receiptDedup.clear()
  pendingWrites.length = 0
  seed()
}

seed()
