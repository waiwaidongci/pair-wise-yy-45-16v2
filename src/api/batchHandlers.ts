import { http, HttpResponse } from 'msw'
import { apiBase } from './mswBase'
import type {
  ApiErrorBody,
  Batch,
  BatchMeasurement,
  ConfirmJudgmentRequest,
  FieldDiff,
  IngestReceiptRequest,
  IngestReceiptResponse,
  VersionRequest,
} from './batchTypes'
import {
  batchEvent,
  batches,
  computePlanSignals,
  nowLabel,
  pendingWrites,
  receiptDedup,
  resetServerStore,
  samples,
} from './serverStore'
import { basisFingerprint, evaluateMeasurements, isBasisStale, measurementFingerprint } from '../features/batchLogic'

function findBatch(sampleId: string): Batch | undefined {
  return batches.find((batch) => batch.sampleId === sampleId)
}

function errorBody(error: ApiErrorBody, status: number) {
  return HttpResponse.json(error, { status })
}

function freshView(batch: Batch): Batch {
  // 尺寸或批注方案一旦变化，已确认判定与锁定结论按当前依据重新计算
  const judgmentStale = batch.judgment.status === '已确认' && isBasisStale(batch.judgment.basisFingerprint, batch)
  batch.judgment.stale = judgmentStale
  batch.judgment.staleReason = judgmentStale ? '尺寸实测或批注/方案已变更，请重新确认超差判定' : null
  if (batch.lock.status === '已锁定' && isBasisStale(batch.lock.basisFingerprint, batch)) {
    batch.lock.status = '已失效'
    batch.judgment.stale = true
    batch.judgment.staleReason = '锁定依据（尺寸 / 批注方案）已变更，锁定结论失效'
  }
  return batch
}

function buildFieldDiffs(clientMeasurements: BatchMeasurement[], batch: Batch): FieldDiff[] {
  return batch.measurements
    .map((server): FieldDiff => {
      const client = clientMeasurements.find((item) => item.key === server.key)
      return {
        path: `measurement.${server.key}`,
        label: server.name,
        client: client ? Number(client.actual).toFixed(1) : '未提交',
        server: server.actual.toFixed(1),
      }
    })
    .filter((diff) => diff.client !== diff.server)
}

function guardWritable(batch: Batch) {
  if (batch.finalized) {
    return errorBody({ error: 'FINALIZED', message: '批次已定版，只读，不能再修改。' }, 409)
  }
  return null
}

type ApplyResult = {
  outcome: IngestReceiptResponse['outcome']
  receipt: Batch['receipts'][number] | null
  message: string
}

function applyReceipt(
  batch: Batch,
  payload: { supplierName: string; supplierOrderNo: string; revision: number; measurements: BatchMeasurement[] | null; note: string; idempotencyKey: string },
): ApplyResult {
  // 同号同修订重传：只算一次
  const dedupKey = `${payload.supplierOrderNo}::${payload.revision}`
  const prior = batch.receipts.find((item) => item.supplierOrderNo === payload.supplierOrderNo && item.revision === payload.revision)
  if (prior) {
    const receipt: Batch['receipts'][number] = {
      idempotencyKey: payload.idempotencyKey,
      supplierOrderNo: payload.supplierOrderNo,
      supplierName: payload.supplierName,
      revision: payload.revision,
      receivedAt: nowLabel(),
      note: payload.note,
      status: 'duplicate',
    }
    batch.receipts.push(receipt)
    batch.events.push(batchEvent('receipt', `同号重传 ${payload.supplierOrderNo} 修订 ${payload.revision}：幂等忽略，不重复计入`))
    return { outcome: 'duplicate', receipt, message: '同号同修订回执已存在，本次重传只记录一次。' }
  }

  // 晚到的旧修订：不覆盖现行版本
  if (batch.supplierOrderNo === payload.supplierOrderNo && payload.revision < batch.revision) {
    const receipt: Batch['receipts'][number] = {
      idempotencyKey: payload.idempotencyKey,
      supplierOrderNo: payload.supplierOrderNo,
      supplierName: payload.supplierName,
      revision: payload.revision,
      receivedAt: nowLabel(),
      note: payload.note,
      status: 'expired',
    }
    batch.receipts.push(receipt)
    batch.version += 1
    // 过期回执同样幂等登记：同一旧修订再到达只记录，不重复产生事件
    receiptDedup.set(dedupKey, batch.id)
    batch.events.push(batchEvent('receipt', `晚到旧修订 ${payload.revision}（现行 ${batch.revision}）：登记但不覆盖尺寸与判定`))
    return { outcome: 'expired', receipt, message: `修订 ${payload.revision} 早于现行修订 ${batch.revision}，已登记为过期回执。` }
  }

  // 生效的新回执（首版 / 更新修订）
  if (payload.measurements?.length) batch.measurements = payload.measurements
  batch.supplierOrderNo = payload.supplierOrderNo
  batch.supplierName = payload.supplierName
  batch.revision = payload.revision
  batch.receivedAt = nowLabel()
  const items = evaluateMeasurements(batch.measurements)
  const outCount = items.filter((item) => item.outOfTolerance).length
  batch.judgment = {
    status: '未判定',
    confirmedBy: null,
    confirmedAt: null,
    basisFingerprint: null,
    items,
    stale: false,
    staleReason: null,
  }
  if (batch.lock.status === '已锁定' || batch.lock.status === '已失效') {
    batch.lock = { status: '已失效', lockedBy: batch.lock.lockedBy, lockedAt: batch.lock.lockedAt, basisFingerprint: batch.lock.basisFingerprint, finalVersion: batch.lock.finalVersion }
  }
  batch.version += 1
  const receipt: Batch['receipts'][number] = {
    idempotencyKey: payload.idempotencyKey,
    supplierOrderNo: payload.supplierOrderNo,
    supplierName: payload.supplierName,
    revision: payload.revision,
    receivedAt: nowLabel(),
    note: payload.note,
    status: 'accepted',
  }
  batch.receipts.push(receipt)
  receiptDedup.set(dedupKey, batch.id)
  batch.events.push(
    batchEvent(
      'receipt',
      `回执生效：${payload.supplierOrderNo} 修订 ${payload.revision}，重算 ${items.length} 项实测（${outCount} 项超差），原判定/锁定结论失效`,
    ),
  )
  return { outcome: 'accepted', receipt, message: `修订 ${payload.revision} 回执已并入批次，超差判定已重算，等待重新确认。` }
}

type IngestResult = IngestReceiptResponse | { httpError: Response }

function ingestPayload(payload: IngestReceiptRequest): IngestResult {
  const sample = samples.find((item) => item.id === payload.sampleId)
  let batch = findBatch(payload.sampleId)

  // 供应商系统写入失败：回执不落批次，先保留未完成回执，稍后可原载荷重试
  if (payload.simulateWriteFailure) {
    const token = `PEND-${Date.now()}`
    pendingWrites.push({
      token,
      sampleId: payload.sampleId,
      supplierName: payload.supplierName ?? sample?.supplier ?? '未知供应商',
      supplierOrderNo: payload.supplierOrderNo?.trim() || null,
      revision: payload.revision ?? null,
      measurements: payload.measurements ?? null,
      note: payload.note ?? '',
      createdAt: nowLabel(),
      lastError: '供应商网关 502 Bad Gateway（模拟写入失败）',
      attempts: 0,
    })
    return {
      batch: batch ? freshView(batch) : ({} as Batch),
      receipt: null,
      outcome: 'write-failed',
      message: '写入失败：未完成回执已保留，可原载荷重试。',
      pendingWrite: pendingWrites[pendingWrites.length - 1],
    }
  }

  const orderNo = payload.supplierOrderNo?.trim() || ''
  const revision = payload.revision ?? 1

  if (!batch) {
    if (!sample) {
      return { httpError: errorBody({ error: 'NOT_FOUND', message: '样品不存在' }, 404) }
    }
    if (!orderNo) {
      return { httpError: errorBody({ error: 'MISSING_ORDER_NO', message: '新批次回执必须带供应商单号。' }, 400) }
    }
    batch = {
      id: `BATCH-${sample.id}`,
      sampleId: sample.id,
      supplierName: payload.supplierName?.trim() || sample.supplier,
      version: 0,
      supplierOrderNo: null,
      revision: 0,
      measurements: payload.measurements ?? sample.measurements['第三轮'],
      planSignals: computePlanSignals(sample),
      receivedAt: null,
      receipts: [],
      judgment: { status: '未判定', confirmedBy: null, confirmedAt: null, basisFingerprint: null, items: [], stale: false, staleReason: null },
      lock: { status: '未锁定', lockedBy: null, lockedAt: null, basisFingerprint: null, finalVersion: null },
      finalized: false,
      finalizedAt: null,
      submitWinner: null,
      legacyDraft: null,
      events: [],
    }
    batches.push(batch)
  }

  const writableError = guardWritable(batch)
  if (writableError) return { httpError: writableError }

  const idempotencyKey = payload.idempotencyKey?.trim() || `KEY-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  // 同一幂等键重发：若已入账则按同号重传处理
  const result = applyReceipt(batch, {
    supplierName: payload.supplierName?.trim() || batch.supplierName,
    supplierOrderNo: orderNo,
    revision,
    measurements: payload.measurements ?? null,
    note: payload.note ?? '',
    idempotencyKey,
  })
  return { batch: freshView(batch), receipt: result.receipt, outcome: result.outcome, message: result.message }
}

export const batchHandlers = [
  http.post(`${apiBase}/api/test/reset`, () => {
    resetServerStore()
    return HttpResponse.json({ reset: true })
  }),
  http.get(`${apiBase}/api/batches`, () => HttpResponse.json(batches.map(freshView))),
  http.get(`${apiBase}/api/batches/by-sample/:sampleId`, ({ params }) => {
    const batch = findBatch(params.sampleId as string)
    if (!batch) return errorBody({ error: 'NOT_FOUND', message: '该样品尚无批次回执。' }, 404)
    return HttpResponse.json(freshView(batch))
  }),
  http.get(`${apiBase}/api/pending-writes`, () => HttpResponse.json(pendingWrites)),

  http.post(`${apiBase}/api/batches/ingest`, async ({ request }) => {
    const payload = (await request.json()) as IngestReceiptRequest
    const result = ingestPayload(payload)
    if ('httpError' in result) return result.httpError
    return HttpResponse.json(result)
  }),

  http.post(`${apiBase}/api/pending-writes/:token/retry`, ({ params }) => {
    const pending = pendingWrites.find((item) => item.token === params.token)
    if (!pending) return errorBody({ error: 'NOT_FOUND', message: '未完成回执不存在，可能已写入成功。' }, 404)
    // 原载荷重试：成功（含幂等重复）即从未完成队列移除；失败时继续保留
    const result = ingestPayload({
      sampleId: pending.sampleId,
      supplierName: pending.supplierName,
      supplierOrderNo: pending.supplierOrderNo ?? '',
      revision: pending.revision ?? 1,
      measurements: pending.measurements,
      note: pending.note,
    })
    if ('httpError' in result) {
      pending.attempts += 1
      return result.httpError
    }
    if (result.outcome === 'write-failed') {
      pending.attempts += 1
      return HttpResponse.json(result, { status: 502 })
    }
    pending.attempts += 1
    const index = pendingWrites.findIndex((item) => item.token === pending.token)
    pendingWrites.splice(index, 1)
    return HttpResponse.json(result)
  }),

  /** 旧草稿没有供应商单号：升级为首版回执，服务端按“草稿->首版”入账 */
  http.post(`${apiBase}/api/batches/by-sample/:sampleId/upgrade-legacy`, async ({ params, request }) => {
    const body = (await request.json()) as { supplierOrderNo: string; supplierName?: string; revision?: number }
    const batch = findBatch(params.sampleId as string)
    if (!batch) return errorBody({ error: 'NOT_FOUND', message: '批次不存在。' }, 404)
    const writableError = guardWritable(batch)
    if (writableError) return writableError
    const orderNo = body.supplierOrderNo?.trim()
    if (!orderNo) return errorBody({ error: 'MISSING_ORDER_NO', message: '升级首版必须填写供应商单号。' }, 400)
    if (batch.supplierOrderNo || batch.receipts.some((item) => item.status === 'accepted')) {
      return errorBody({ error: 'BAD_REQUEST', message: '该批次已有生效回执，无需升级旧草稿。' }, 409)
    }
    const draftNote = batch.legacyDraft?.note ?? ''
    const result = applyReceipt(batch, {
      supplierName: body.supplierName?.trim() || batch.supplierName,
      supplierOrderNo: orderNo,
      revision: body.revision ?? 1,
      measurements: null,
      note: draftNote ? `旧草稿升级首版：${draftNote}` : '旧草稿升级为首版回执',
      idempotencyKey: `UPGRADE-${Date.now()}`,
    })
    if (result.outcome === 'accepted') batch.legacyDraft = null
    return HttpResponse.json({ batch: freshView(batch), receipt: result.receipt, outcome: result.outcome, message: '旧草稿已升级为首版回执。' })
  }),

  /** 模拟内部刚完成一轮评审：新增一条待处理批注，再同步到批次方案指纹 */
  http.post(`${apiBase}/api/batches/by-sample/:sampleId/review-annotation`, async ({ params, request }) => {
    const body = (await request.json().catch(() => ({}))) as { content?: string }
    const sample = samples.find((item) => item.id === params.sampleId)
    const batch = findBatch(params.sampleId as string)
    if (!sample || !batch) return errorBody({ error: 'NOT_FOUND', message: '样品或批次不存在。' }, 404)
    const writableError = guardWritable(batch)
    if (writableError) return writableError
    sample.annotations.push({
      id: `AN-${Date.now()}`,
      x: 40 + Math.round(Math.random() * 20),
      y: 40 + Math.round(Math.random() * 20),
      part: '内部评审',
      content: body.content?.trim() || `评审新增关注点 ${sample.annotations.length + 1}：复核该部位工艺与尺寸联动`,
      author: '评审会 / 内部',
      status: '待处理',
    })
    const before = basisFingerprint(batch.measurements, batch.planSignals)
    batch.planSignals = computePlanSignals(sample)
    const after = basisFingerprint(batch.measurements, batch.planSignals)
    if (after !== before) {
      batch.version += 1
      if (batch.judgment.status === '已确认') {
        batch.judgment.stale = true
        batch.judgment.staleReason = '内部评审批注变更，超差判定需重新确认'
      }
      if (batch.lock.status === '已锁定') batch.lock.status = '已失效'
      batch.events.push(batchEvent('plan', '内部评审新增批注：方案指纹变化，判定/锁定结论失效重算'))
    }
    return HttpResponse.json({ batch: freshView(batch), changed: after !== before, message: '内部评审批注已写入并同步到批次依据。' })
  }),

  /** 内部评审（批注 / 方案）变更：同步到批次方案指纹，触发失效重算 */
  http.post(`${apiBase}/api/batches/by-sample/:sampleId/plan-changed`, ({ params }) => {
    const sample = samples.find((item) => item.id === params.sampleId)
    const batch = findBatch(params.sampleId as string)
    if (!sample || !batch) return errorBody({ error: 'NOT_FOUND', message: '样品或批次不存在。' }, 404)
    const writableError = guardWritable(batch)
    if (writableError) return writableError
    const nextSignals = computePlanSignals(sample)
    if (basisFingerprint(batch.measurements, nextSignals) === basisFingerprint(batch.measurements, batch.planSignals)) {
      return HttpResponse.json({ batch: freshView(batch), changed: false, message: '批注 / 方案与批次当前依据一致，没有变化。' })
    }
    batch.planSignals = nextSignals
    batch.version += 1
    if (batch.judgment.status === '已确认') {
      batch.judgment.stale = true
      batch.judgment.staleReason = '批注 / 方案已变更，超差判定需重新确认'
    }
    if (batch.lock.status === '已锁定') {
      batch.lock.status = '已失效'
      batch.events.push(batchEvent('plan', '批注 / 方案变更：锁定结论失效，需重新确认并锁定'))
    } else {
      batch.events.push(batchEvent('plan', '批注 / 方案变更：超差判定依据失效，等待重算确认'))
    }
    return HttpResponse.json({ batch: freshView(batch), changed: true, message: '批注 / 方案已并入批次，相关判定与锁定结论失效。' })
  }),

  /** 两名跟单员同时提交：先到生效，后到 409 并保留后到现场值、列出差异 */
  http.post(`${apiBase}/api/batches/by-sample/:sampleId/confirm-judgment`, async ({ params, request }) => {
    const body = (await request.json()) as ConfirmJudgmentRequest
    const batch = findBatch(params.sampleId as string)
    if (!batch) return errorBody({ error: 'NOT_FOUND', message: '批次不存在。' }, 404)
    const writableError = guardWritable(batch)
    if (writableError) return writableError
    if (body.version !== batch.version) {
      const fieldDiffs = body.measurements ? buildFieldDiffs(body.measurements, batch) : []
      return errorBody(
        {
          error: 'VERSION_CONFLICT',
          message: `批次版本已变化（你基于 v${body.version}，当前 v${batch.version}）：先到提交已生效，你的现场值已保留，差异如下。`,
          currentVersion: batch.version,
          winner: batch.submitWinner,
          serverBatch: freshView(batch),
          fieldDiffs,
        },
        409,
      )
    }
    if (body.measurements?.length) {
      batch.measurements = body.measurements.map((item) => ({ ...item, actual: Number(item.actual) }))
    }
    const basis = basisFingerprint(batch.measurements, batch.planSignals)
    batch.judgment = {
      status: '已确认',
      confirmedBy: body.by,
      confirmedAt: nowLabel(),
      basisFingerprint: basis,
      items: evaluateMeasurements(batch.measurements),
      stale: false,
      staleReason: null,
    }
    batch.submitWinner = { by: body.by, at: nowLabel(), baseVersion: body.version }
    batch.version += 1
    batch.events.push(batchEvent('judgment', `${body.by} 基于 v${body.version} 确认超差判定（提交生效）`))
    return HttpResponse.json({ batch: freshView(batch), message: '判定已确认。' })
  }),

  http.post(`${apiBase}/api/batches/by-sample/:sampleId/lock`, async ({ params, request }) => {
    const body = (await request.json()) as VersionRequest
    const batch = findBatch(params.sampleId as string)
    if (!batch) return errorBody({ error: 'NOT_FOUND', message: '批次不存在。' }, 404)
    const writableError = guardWritable(batch)
    if (writableError) return writableError
    if (body.version !== batch.version) {
      return errorBody({ error: 'VERSION_CONFLICT', message: `批次版本已变化（v${body.version} → v${batch.version}），请刷新后重新锁定。`, currentVersion: batch.version, winner: batch.submitWinner, serverBatch: freshView(batch), fieldDiffs: [] }, 409)
    }
    if (batch.judgment.status !== '已确认') {
      return errorBody({ error: 'JUDGMENT_NOT_CONFIRMED', message: '超差判定尚未确认，不能锁定。' }, 409)
    }
    if (batch.judgment.stale) {
      return errorBody({ error: 'JUDGMENT_NOT_CONFIRMED', message: '判定依据已失效（尺寸或批注方案变更），请重新确认后再锁定。' }, 409)
    }
    batch.lock = { status: '已锁定', lockedBy: body.by, lockedAt: nowLabel(), basisFingerprint: basisFingerprint(batch.measurements, batch.planSignals), finalVersion: null }
    batch.version += 1
    batch.events.push(batchEvent('lock', `${body.by} 审核锁定批次（v${batch.version}）`))
    return HttpResponse.json({ batch: freshView(batch), message: '批次已审核锁定。' })
  }),

  http.post(`${apiBase}/api/batches/by-sample/:sampleId/unlock`, async ({ params, request }) => {
    const body = (await request.json()) as VersionRequest
    const batch = findBatch(params.sampleId as string)
    if (!batch) return errorBody({ error: 'NOT_FOUND', message: '批次不存在。' }, 404)
    if (batch.finalized) return errorBody({ error: 'FINALIZED', message: '已定版批次不能解锁。' }, 409)
    if (body.version !== batch.version) {
      return errorBody({ error: 'VERSION_CONFLICT', message: `批次版本已变化（v${body.version} → v${batch.version}）。`, currentVersion: batch.version, winner: batch.submitWinner, serverBatch: freshView(batch), fieldDiffs: [] }, 409)
    }
    batch.lock = { status: '未锁定', lockedBy: null, lockedAt: null, basisFingerprint: null, finalVersion: null }
    batch.version += 1
    batch.events.push(batchEvent('lock', `${body.by} 解锁批次，进入修订分支`))
    return HttpResponse.json({ batch: freshView(batch), message: '批次已解锁。' })
  }),

  /** 定版：必须锁定且锁定结论仍然有效 */
  http.post(`${apiBase}/api/batches/by-sample/:sampleId/finalize`, async ({ params, request }) => {
    const body = (await request.json()) as VersionRequest
    const batch = findBatch(params.sampleId as string)
    if (!batch) return errorBody({ error: 'NOT_FOUND', message: '批次不存在。' }, 404)
    if (batch.finalized) return errorBody({ error: 'FINALIZED', message: '批次已定版。' }, 409)
    if (body.version !== batch.version) {
      return errorBody({ error: 'VERSION_CONFLICT', message: `批次版本已变化（v${body.version} → v${batch.version}）。`, currentVersion: batch.version, winner: batch.submitWinner, serverBatch: freshView(batch), fieldDiffs: [] }, 409)
    }
    if (batch.lock.status !== '已锁定') {
      return errorBody({ error: 'LOCKED_READONLY', message: '尚未审核锁定，不能定版。' }, 409)
    }
    if (batch.judgment.stale || isBasisStale(batch.lock.basisFingerprint, batch)) {
      return errorBody({ error: 'JUDGMENT_NOT_CONFIRMED', message: '锁定结论已失效且未重新确认，不能进入定版。' }, 409)
    }
    batch.finalized = true
    batch.finalizedAt = nowLabel()
    batch.lock.finalVersion = batch.version
    batch.events.push(batchEvent('lock', `${body.by} 确认定版（v${batch.version} 冻结）`))
    return HttpResponse.json({ batch: freshView(batch), message: '批次已定版冻结。' })
  }),

  /** 跟单员现场改实测值：同样走乐观锁，先到生效 */
  http.patch(`${apiBase}/api/batches/by-sample/:sampleId/measurements`, async ({ params, request }) => {
    const body = (await request.json()) as { version: number; measurements: BatchMeasurement[]; by: string }
    const batch = findBatch(params.sampleId as string)
    if (!batch) return errorBody({ error: 'NOT_FOUND', message: '批次不存在。' }, 404)
    const writableError = guardWritable(batch)
    if (writableError) return writableError
    if (body.version !== batch.version) {
      return errorBody(
        {
          error: 'VERSION_CONFLICT',
          message: `实测值版本冲突（v${body.version} → v${batch.version}）：先到已生效，现场值已保留。`,
          currentVersion: batch.version,
          winner: batch.submitWinner,
          serverBatch: freshView(batch),
          fieldDiffs: buildFieldDiffs(body.measurements, batch),
        },
        409,
      )
    }
    const before = measurementFingerprint(batch.measurements)
    batch.measurements = body.measurements.map((item) => ({ ...item, actual: Number(item.actual) }))
    if (measurementFingerprint(batch.measurements) !== before) {
      batch.judgment = {
        status: '未判定',
        confirmedBy: null,
        confirmedAt: null,
        basisFingerprint: null,
        items: evaluateMeasurements(batch.measurements),
        stale: false,
        staleReason: null,
      }
      if (batch.lock.status === '已锁定') batch.lock.status = '已失效'
      batch.events.push(batchEvent('measurement', `${body.by} 更新现场实测值，超差判定重算、原确认失效`))
    }
    batch.version += 1
    return HttpResponse.json({ batch: freshView(batch), message: '现场实测值已保存。' })
  }),
]
