import type { Batch, BatchMeasurement, DeviationItem } from '../api/batchTypes'

/** 尺寸实测指纹：任一部位实测值变化都会改变 */
export function measurementFingerprint(measurements: BatchMeasurement[]): string {
  const raw = measurements
    .map((item) => `${item.key}:${Number(item.actual).toFixed(2)}/±${item.tolerance}`)
    .join('|')
  return hash(raw)
}

/** 批注 / 改版方案指纹：内部评审内容一变就改变 */
export function planSignalFingerprint(signals: string[]): string {
  return hash([...signals].sort().join('|'))
}

/** 超差判定与锁定结论所依赖的完整依据：尺寸 + 批注方案 */
export function basisFingerprint(measurements: BatchMeasurement[], planSignals: string[]): string {
  return `${measurementFingerprint(measurements)}::${planSignalFingerprint(planSignals)}`
}

export function evaluateMeasurements(measurements: BatchMeasurement[]): DeviationItem[] {
  return measurements.map((item) => {
    const deviation = round2(item.actual - item.spec)
    return {
      ...item,
      deviation,
      outOfTolerance: Math.abs(item.actual - item.spec) > item.tolerance + 1e-9,
    }
  })
}

/** 已确认结论 / 锁定结论相对于当前尺寸与方案是否失效 */
export function isBasisStale(basis: string | null, batch: Pick<Batch, 'measurements' | 'planSignals'>): boolean {
  if (!basis) return false
  return basis !== basisFingerprint(batch.measurements, batch.planSignals)
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function hash(input: string): string {
  // djb2，稳定且足够给工作台做版本指纹
  let hashValue = 5381
  for (let index = 0; index < input.length; index += 1) {
    hashValue = (hashValue * 33) ^ input.charCodeAt(index)
  }
  return (hashValue >>> 0).toString(16).padStart(8, '0')
}
