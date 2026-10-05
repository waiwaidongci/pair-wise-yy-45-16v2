import { setupServer } from 'msw/node'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handlers } from '../api/handlers'
import type { ApiErrorBody, Batch, IngestReceiptResponse } from '../api/batchTypes'

const server = setupServer(...handlers)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

const headers = { 'Content-Type': 'application/json' } as const

async function getBatch(sampleId: string): Promise<Batch> {
  const response = await fetch(`http://localhost/api/batches/by-sample/${sampleId}`)
  expect(response.ok).toBe(true)
  return response.json()
}

async function postJson<T = unknown>(path: string, body: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`http://localhost${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const data = (await response.json()) as T
  return { status: response.status, data }
}

async function patchJson<T = unknown>(path: string, body: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`http://localhost${path}`, { method: 'PATCH', headers, body: JSON.stringify(body) })
  const data = (await response.json()) as T
  return { status: response.status, data }
}

const SAMPLE_018 = 'SMP-26018'
const SAMPLE_021 = 'SMP-26021'
const SAMPLE_024 = 'SMP-26024'

describe('交样批次：回执 / 尺寸实测 / 审核锁定', () => {
  beforeEach(async () => {
    const response = await fetch('http://localhost/api/test/reset', { method: 'POST' })
    expect(response.ok).toBe(true)
  })

  it('回执带供应商单号与修订；同号同修订重传只算一次', async () => {
    const before = await getBatch(SAMPLE_018)
    expect(before.supplierOrderNo).toBe('PO-MZ-2609-118')
    expect(before.revision).toBe(2)
    const acceptedCount = before.receipts.filter((item) => item.status === 'accepted').length

    const first = await postJson<IngestReceiptResponse>('/api/batches/ingest', {
      sampleId: SAMPLE_018,
      supplierOrderNo: 'PO-MZ-2609-118',
      revision: 2,
      note: '重传同一版',
      idempotencyKey: 'dup-test-1',
    })
    expect(first.data.outcome).toBe('duplicate')

    const second = await postJson<IngestReceiptResponse>('/api/batches/ingest', {
      sampleId: SAMPLE_018,
      supplierOrderNo: 'PO-MZ-2609-118',
      revision: 2,
      note: '再次重传',
      idempotencyKey: 'dup-test-2',
    })
    expect(second.data.outcome).toBe('duplicate')

    const after = await getBatch(SAMPLE_018)
    // 生效回执没有增加，版本也不递增
    expect(after.receipts.filter((item) => item.status === 'accepted')).toHaveLength(acceptedCount)
    expect(after.receipts.filter((item) => item.status === 'duplicate').length).toBeGreaterThanOrEqual(2)
    expect(after.revision).toBe(2)
  })

  it('晚到旧修订登记但不覆盖；新修订使判定与锁定结论失效重算', async () => {
    // 修订 0（从未生效过的旧版）晚到：登记为过期，但不覆盖现行
    const expired = await postJson<IngestReceiptResponse>('/api/batches/ingest', {
      sampleId: SAMPLE_018,
      supplierOrderNo: 'PO-MZ-2609-118',
      revision: 0,
      note: '迟到的旧版',
    })
    expect(expired.data.outcome).toBe('expired')
    const unchanged = await getBatch(SAMPLE_018)
    expect(unchanged.revision).toBe(2)
    expect(unchanged.receipts.some((item) => item.status === 'expired')).toBe(true)

    // 新修订 3：尺寸变化，判定失效重算
    const measured = unchanged.measurements.map((item, index) => ({ ...item, actual: item.spec + (index === 0 ? 0.2 : 0) }))
    const revised = await postJson<IngestReceiptResponse>('/api/batches/ingest', {
      sampleId: SAMPLE_018,
      supplierOrderNo: 'PO-MZ-2609-118',
      revision: 3,
      measurements: measured,
      note: '修订 3 尺寸',
    })
    expect(revised.data.outcome).toBe('accepted')
    const batch = await getBatch(SAMPLE_018)
    expect(batch.revision).toBe(3)
    expect(batch.judgment.status).toBe('未判定')
    expect(batch.judgment.stale).toBe(false)
    expect(batch.measurements[0].actual).toBeCloseTo(108.2, 5)
  })

  it('两名跟单员同时提交同一批次：先到生效，后到 409 并列出差异、保留现场值', async () => {
    const current = await getBatch(SAMPLE_018)
    const version = current.version
    const makeMeasurements = (chest: number) => current.measurements.map((item) => ({ ...item, actual: item.key === 'chest' ? chest : item.actual }))

    const [winnerResult, loserResult] = await Promise.all([
      postJson<Batch>('/api/batches/by-sample/SMP-26018/confirm-judgment', { version, by: '跟单员A', measurements: makeMeasurements(109.6) }),
      postJson<Batch>('/api/batches/by-sample/SMP-26018/confirm-judgment', { version, by: '跟单员B', measurements: makeMeasurements(110.4) }),
    ])

    const results = [winnerResult, loserResult].sort((a) => (a.status === 200 ? -1 : 1))
    const [ok, conflict] = results
    expect(ok.status).toBe(200)
    expect(conflict.status).toBe(409)
    const errorBody = conflict.data as unknown as ApiErrorBody
    expect(errorBody.error).toBe('VERSION_CONFLICT')
    if (errorBody.error === 'VERSION_CONFLICT') {
      expect(errorBody.winner?.by).toBe('跟单员A')
      const chestDiff = errorBody.fieldDiffs.find((diff) => diff.path === 'measurement.chest')
      expect(chestDiff).toBeTruthy()
      expect(chestDiff?.client).toBe('110.4')
      expect(chestDiff?.server).toBe('109.6')
      // 生效值是先到者的，后到现场值由客户端保留（不在服务端覆盖）
      const after = await getBatch(SAMPLE_018)
      expect(after.measurements.find((item) => item.key === 'chest')?.actual).toBeCloseTo(109.6, 5)
      expect(after.submitWinner?.by).toBe('跟单员A')
    }
  })

  it('尺寸或批注方案变化后判定失效，未重新确认不能锁定/定版；重新确认后可锁定定版', async () => {
    let batch = await getBatch(SAMPLE_018)
    // 种子初始判定有效
    expect(batch.judgment.stale).toBe(false)

    // 内部评审新增批注 -> 方案指纹变化
    const annotation = await postJson<Batch>('/api/batches/by-sample/SMP-26018/review-annotation', { content: '新增评审：复核袖口暗扣' })
    expect(annotation.status).toBe(200)
    batch = await getBatch(SAMPLE_018)
    expect(batch.judgment.stale).toBe(true)

    // 失效状态下锁定被拒
    const lockRejected = await postJson<Batch>('/api/batches/by-sample/SMP-26018/lock', { version: batch.version, by: '沈岚' })
    expect(lockRejected.status).toBe(409)
    expect((lockRejected.data as unknown as ApiErrorBody).error).toBe('JUDGMENT_NOT_CONFIRMED')

    // 重新确认
    const reconfirmed = await postJson<Batch>('/api/batches/by-sample/SMP-26018/confirm-judgment', {
      version: batch.version,
      by: '沈岚',
      measurements: batch.measurements,
    })
    expect(reconfirmed.status).toBe(200)
    batch = await getBatch(SAMPLE_018)
    expect(batch.judgment.stale).toBe(false)

    // 锁定
    const locked = await postJson<Batch>('/api/batches/by-sample/SMP-26018/lock', { version: batch.version, by: '沈岚' })
    expect(locked.status).toBe(200)
    batch = await getBatch(SAMPLE_018)
    expect(batch.lock.status).toBe('已锁定')

    // 锁定后再变尺寸 -> 锁定失效
    const changed = batch.measurements.map((item) => (item.key === 'sleeve' ? { ...item, actual: item.actual + 0.4 } : item))
    await patchJson('/api/batches/by-sample/SMP-26018/measurements', { version: batch.version, by: '沈岚', measurements: changed })
    batch = await getBatch(SAMPLE_018)
    expect(batch.lock.status).toBe('已失效')

    // 未重新确认不能定版
    const finalizeRejected = await postJson<Batch>('/api/batches/by-sample/SMP-26018/finalize', { version: batch.version, by: '沈岚' })
    expect(finalizeRejected.status).toBe(409)

    // 重新确认 -> 重新锁定 -> 定版
    await postJson('/api/batches/by-sample/SMP-26018/confirm-judgment', { version: batch.version, by: '沈岚', measurements: batch.measurements })
    batch = await getBatch(SAMPLE_018)
    await postJson('/api/batches/by-sample/SMP-26018/lock', { version: batch.version, by: '沈岚' })
    batch = await getBatch(SAMPLE_018)
    const finalized = await postJson<Batch>('/api/batches/by-sample/SMP-26018/finalize', { version: batch.version, by: '沈岚' })
    expect(finalized.status).toBe(200)
    batch = await getBatch(SAMPLE_018)
    expect(batch.finalized).toBe(true)
    // 已定版只读
    const afterFinal = await postJson<IngestReceiptResponse>('/api/batches/ingest', { sampleId: SAMPLE_018, supplierOrderNo: 'PO-MZ-2609-118', revision: 4 })
    expect(afterFinal.status).toBe(409)
  })

  it('旧草稿没有供应商单号：升级首版；新批次回执缺单号直接拒绝', async () => {
    const batch = await getBatch(SAMPLE_021)
    expect(batch.legacyDraft).toBeTruthy()
    expect(batch.supplierOrderNo).toBeNull()

    // 缺单号不能升级
    const bad = await postJson<Batch>('/api/batches/by-sample/SMP-26021/upgrade-legacy', { supplierOrderNo: '' })
    expect(bad.status).toBe(400)

    const upgraded = await postJson<Batch>('/api/batches/by-sample/SMP-26021/upgrade-legacy', { supplierOrderNo: 'PO-YY-2610-021' })
    expect(upgraded.status).toBe(200)
    const after = await getBatch(SAMPLE_021)
    expect(after.legacyDraft).toBeNull()
    expect(after.supplierOrderNo).toBe('PO-YY-2610-021')
    expect(after.revision).toBe(1)
    expect(after.receipts.some((item) => item.status === 'accepted' && item.revision === 1)).toBe(true)

    // 全新款式回执不带供应商单号 -> 拒绝
    const missing = await postJson<IngestReceiptResponse>('/api/batches/ingest', { sampleId: 'SMP-NEW-999', revision: 1 })
    expect(missing.status).toBe(404)
  })

  it('写入失败保留未完成回执，原载荷重试后并入批次（同号仍幂等）', async () => {
    // 种子中 SMP-26024 尚无批次，但有一条待重试回执
    const notFound = await fetch('http://localhost/api/batches/by-sample/SMP-26024')
    expect(notFound.status).toBe(404)

    let pending = await (await fetch('http://localhost/api/pending-writes')).json()
    const target = pending.find((item: { sampleId: string }) => item.sampleId === SAMPLE_024)
    expect(target).toBeTruthy()
    expect(target.supplierOrderNo).toBe('PO-YX-2610-024')

    // 原载荷重试 -> 建立批次并入账
    const retry = await postJson<IngestReceiptResponse>(`/api/pending-writes/${target.token}/retry`, {})
    expect(retry.status).toBe(200)
    expect(retry.data.outcome).toBe('accepted')

    const batch = await getBatch(SAMPLE_024)
    expect(batch.supplierOrderNo).toBe('PO-YX-2610-024')
    expect(batch.revision).toBe(1)
    pending = await (await fetch('http://localhost/api/pending-writes')).json()
    expect(pending.find((item: { token: string }) => item.token === target.token)).toBeUndefined()

    // 模拟一次新的写入失败：未完成回执保留，可重试
    const failed = await postJson<IngestReceiptResponse>('/api/batches/ingest', {
      sampleId: SAMPLE_024,
      supplierOrderNo: 'PO-YX-2610-024',
      revision: 2,
      note: '修订 2 回执',
      simulateWriteFailure: true,
    })
    expect(failed.data.outcome).toBe('write-failed')
    pending = await (await fetch('http://localhost/api/pending-writes')).json()
    const retained = pending.find((item: { sampleId: string; revision: number }) => item.sampleId === SAMPLE_024 && item.revision === 2)
    expect(retained).toBeTruthy()

    const retry2 = await postJson<IngestReceiptResponse>(`/api/pending-writes/${retained.token}/retry`, {})
    expect(retry2.data.outcome).toBe('accepted')
    const after = await getBatch(SAMPLE_024)
    expect(after.revision).toBe(2)

    // 再重放同一未完成回执的单号+修订，只会幂等记录
    const dup = await postJson<IngestReceiptResponse>('/api/batches/ingest', {
      sampleId: SAMPLE_024,
      supplierOrderNo: 'PO-YX-2610-024',
      revision: 2,
      note: '重复送达',
    })
    expect(dup.data.outcome).toBe('duplicate')
  })
})
