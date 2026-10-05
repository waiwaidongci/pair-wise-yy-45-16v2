import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { seedSamples } from '../api/seed'
import type { DeliveryBatch, ReceiptPush, Round, Sample } from '../api/types'
import {
  acknowledgeConflict,
  canFinalize,
  invalidateBatch,
  measurementPassRate,
  receiveReceiptLogic,
  reconfirmBatch as reconfirmBatchLogic,
  retryReceipt,
} from './batchLogic'

type Decision = { proposalId: string; decision: '已采纳' | '未采纳'; reason: string; decidedAt: string }

type DevelopmentState = {
  samples: Sample[]
  selectedId: string
  roundA: Round
  roundB: Round
  decisions: Decision[]
  draftNotes: Record<string, string>
  locked: boolean
  activeAnnotation: string | null
  batches: DeliveryBatch[]
  selectedBatchId: string | null
}

const storageKey = 'garment-sampling-draft-v1'
const saved = localStorage.getItem(storageKey)
const parsed = saved ? JSON.parse(saved) : null

const defaults: DevelopmentState = {
  samples: structuredClone(seedSamples),
  selectedId: seedSamples[0].id,
  roundA: '第二轮',
  roundB: '第三轮',
  decisions: [],
  draftNotes: {},
  locked: false,
  activeAnnotation: null,
  batches: [],
  selectedBatchId: null,
}

const initialState: DevelopmentState = parsed
  ? {
      ...defaults,
      ...parsed,
      // 兼容旧草稿：补齐批次相关字段
      samples: parsed.samples?.length ? parsed.samples : defaults.samples,
      batches: parsed.batches ?? [],
      selectedBatchId: parsed.selectedBatchId ?? null,
    }
  : defaults

const now = () => new Date().toLocaleString('zh-CN')

const slice = createSlice({
  name: 'development',
  initialState,
  reducers: {
    selectSample(state, action: PayloadAction<string>) {
      state.selectedId = action.payload
      state.activeAnnotation = null
    },
    setRounds(state, action: PayloadAction<{ a?: Round; b?: Round }>) {
      if (action.payload.a) state.roundA = action.payload.a
      if (action.payload.b) state.roundB = action.payload.b
    },
    decideProposal(state, action: PayloadAction<Decision>) {
      const sample = state.samples.find((item) => item.id === state.selectedId)
      if (!sample || state.locked) return
      state.decisions.push(action.payload)
      const proposal = sample.proposals.find((item) => item.id === action.payload.proposalId)
      if (proposal) proposal.status = action.payload.decision
    },
    saveDraft(state, action: PayloadAction<{ sampleId: string; notes: string }>) {
      state.draftNotes[action.payload.sampleId] = action.payload.notes
    },
    toggleAnnotation(state, action: PayloadAction<string | null>) {
      state.activeAnnotation = action.payload
    },
    resolveAnnotation(state, action: PayloadAction<{ sampleId: string; annotationId: string }>) {
      const sample = state.samples.find((item) => item.id === action.payload.sampleId)
      const annotation = sample?.annotations.find((item) => item.id === action.payload.annotationId)
      if (!annotation) return
      annotation.status = annotation.status === '待处理' ? '已解决' : '待处理'
      // 批注方案变更 → 相关批次的锁定结论失效
      state.batches = state.batches.map((batch) =>
        batch.sampleId === action.payload.sampleId
          ? invalidateBatch(batch, '批注方案变更，超差判断与锁定结论需重算')
          : batch,
      )
    },
    addAnnotation(
      state,
      action: PayloadAction<{ sampleId: string; annotation: { x: number; y: number; part: string; content: string } }>,
    ) {
      const sample = state.samples.find((item) => item.id === action.payload.sampleId)
      if (!sample || state.locked) return
      sample.annotations.push({
        id: `AN-${Date.now()}`,
        author: '当前用户',
        status: '待处理',
        ...action.payload.annotation,
      })
      state.batches = state.batches.map((batch) =>
        batch.sampleId === action.payload.sampleId
          ? invalidateBatch(batch, '新增部位批注，锁定结论需重算')
          : batch,
      )
    },
    updateMeasurement(
      state,
      action: PayloadAction<{ sampleId: string; round: Round; key: string; actual: number }>,
    ) {
      const sample = state.samples.find((item) => item.id === action.payload.sampleId)
      if (!sample) return
      const target = sample.measurements[action.payload.round].find((item) => item.key === action.payload.key)
      if (target) target.actual = action.payload.actual
      state.batches = state.batches.map((batch) =>
        batch.sampleId === action.payload.sampleId
          ? invalidateBatch(batch, '尺寸实测变更，超差判断与锁定结论需重算')
          : batch,
      )
    },
    lockReview(state) {
      const sample = state.samples.find((item) => item.id === state.selectedId)
      if (!sample) return
      sample.status = '已锁定'
      sample.proposals.forEach((proposal) => {
        if (proposal.status === '待决定') proposal.status = '未采纳'
      })
      state.locked = true
    },
    unlockReview(state) {
      const sample = state.samples.find((item) => item.id === state.selectedId)
      if (sample) sample.status = '待审核'
      state.locked = false
    },

    // —— 交样批次 ——
    selectBatch(state, action: PayloadAction<string | null>) {
      state.selectedBatchId = action.payload
    },
    receiveReceipt(state, action: PayloadAction<ReceiptPush>) {
      const { batches: nextBatches, result } = receiveReceiptLogic(state.batches, action.payload, now())
      state.batches = nextBatches
      if (result.kind === 'created') {
        const sample = state.samples.find((item) => item.id === action.payload.sampleId)
        if (sample) {
          // 新建批次：用回执尺寸覆盖该轮次实测
          sample.measurements[action.payload.round] = result.batch.measurements.map((m) => ({ ...m }))
          // 同一样本轮次的旧修订失效（新修订尺寸到达）
          state.batches = state.batches.map((batch) =>
            batch.sampleId === action.payload.sampleId &&
            batch.round === action.payload.round &&
            batch.id !== result.batch.id
              ? invalidateBatch(batch, `新修订 ${result.batch.revision} 到达，尺寸已更新`)
              : batch,
          )
        }
      }
      // 冲突（先到生效）：工作台现场值保持不变，不覆盖
    },
    acknowledgeBatchConflict(state, action: PayloadAction<{ batchId: string; keepOnSite: boolean }>) {
      const batch = state.batches.find((item) => item.id === action.payload.batchId)
      if (!batch || !batch.conflict) return
      const updated = acknowledgeConflict(batch, action.payload.keepOnSite)
      Object.assign(batch, updated)
      const sample = state.samples.find((item) => item.id === batch.sampleId)
      if (sample) sample.measurements[batch.round] = batch.measurements.map((m) => ({ ...m }))
    },
    retryBatchReceipt(state, action: PayloadAction<string>) {
      const batch = state.batches.find((item) => item.id === action.payload)
      if (!batch || batch.writeState !== '写入失败') return
      Object.assign(batch, retryReceipt(batch, now()))
    },
    reconfirmBatch(state, action: PayloadAction<string>) {
      const batch = state.batches.find((item) => item.id === action.payload)
      if (!batch) return
      const sample = state.samples.find((item) => item.id === batch.sampleId)
      const measurements = sample?.measurements[batch.round] ?? batch.measurements
      const openAnnotations = sample?.annotations.filter((item) => item.status === '待处理').length ?? 0
      const updated = reconfirmBatchLogic(batch, measurements, openAnnotations, batch.receivedBy, now())
      Object.assign(batch, updated)
      if (sample) {
        sample.status = '已锁定'
        state.locked = true
      }
    },
    lockBatch(state, action: PayloadAction<string>) {
      const batch = state.batches.find((item) => item.id === action.payload)
      if (!batch || batch.status === '已定版') return
      const sample = state.samples.find((item) => item.id === batch.sampleId)
      const measurements = sample?.measurements[batch.round] ?? batch.measurements
      const openAnnotations = sample?.annotations.filter((item) => item.status === '待处理').length ?? 0
      batch.status = '已锁定'
      batch.stale = false
      batch.staleReasons = []
      batch.conflict = batch.conflict?.acknowledged ? null : batch.conflict
      batch.lockConclusion = {
        lockedAt: now(),
        lockedBy: batch.receivedBy,
        round: batch.round,
        measurementPassRate: measurementPassRate(measurements),
        openAnnotations,
        stale: false,
      }
      if (sample) sample.status = '已锁定'
      state.locked = true
    },
    finalizeBatch(state, action: PayloadAction<string>) {
      const batch = state.batches.find((item) => item.id === action.payload)
      if (!batch) return
      const { ok } = canFinalize(batch)
      if (!ok) return
      batch.status = '已定版'
      batch.stale = false
      if (batch.lockConclusion) batch.lockConclusion.stale = false
      const sample = state.samples.find((item) => item.id === batch.sampleId)
      if (sample) sample.status = '已锁定'
    },
  },
})

export const {
  selectSample,
  setRounds,
  decideProposal,
  saveDraft,
  toggleAnnotation,
  resolveAnnotation,
  addAnnotation,
  updateMeasurement,
  lockReview,
  unlockReview,
  selectBatch,
  receiveReceipt,
  acknowledgeBatchConflict,
  retryBatchReceipt,
  reconfirmBatch,
  lockBatch,
  finalizeBatch,
} = slice.actions
export const developmentReducer = slice.reducer
