import { http, HttpResponse } from 'msw'
import { seedSamples, measurements } from './seed'
import type { SupplierReceipt } from './types'

let samples = structuredClone(seedSamples)

// 外部供应商系统推送的交样回执（待跟单员接收到工作台）
let supplierReceipts: SupplierReceipt[] = [
  {
    id: 'SR-01',
    supplierNo: 'GYS-2609',
    revision: 'R1',
    sampleId: 'SMP-26018',
    round: '第三轮',
    measurements: measurements(0.3),
    submittedBy: '外部系统',
    source: '供应商系统',
    pushedAt: '10-05 09:12',
    status: '待处理',
  },
  {
    id: 'SR-02',
    supplierNo: '',
    revision: '',
    sampleId: 'SMP-26021',
    round: '第一轮',
    measurements: measurements(1.4),
    submittedBy: '外部系统',
    source: '供应商系统',
    pushedAt: '10-05 09:30',
    status: '待处理',
  },
]

export const handlers = [
  http.get('/api/samples', () => HttpResponse.json(samples)),
  http.get('/api/samples/:id', ({ params }) => {
    const sample = samples.find((item) => item.id === params.id)
    return sample ? HttpResponse.json(sample) : new HttpResponse(null, { status: 404 })
  }),
  http.post('/api/samples/:id/annotations', async ({ params, request }) => {
    const body = (await request.json()) as { x: number; y: number; part: string; content: string }
    const sample = samples.find((item) => item.id === params.id)
    if (!sample) return new HttpResponse(null, { status: 404 })
    sample.annotations.push({ id: `AN-${Date.now()}`, author: '当前用户', status: '待处理', ...body })
    return HttpResponse.json(sample, { status: 201 })
  }),
  http.post('/api/samples/:id/comments', async ({ params, request }) => {
    const body = (await request.json()) as { content: string }
    const sample = samples.find((item) => item.id === params.id)
    if (!sample) return new HttpResponse(null, { status: 404 })
    sample.comments.push({ id: `CM-${Date.now()}`, author: '当前用户', content: body.content, date: '刚刚' })
    return HttpResponse.json(sample, { status: 201 })
  }),

  // —— 外部供应商系统：交样回执推送 ——
  http.get('/api/supplier/receipts', () => HttpResponse.json(supplierReceipts)),
  http.post('/api/supplier/receipts/push', async ({ request }) => {
    const body = (await request.json()) as Partial<SupplierReceipt>
    const record: SupplierReceipt = {
      id: `SR-${Date.now()}`,
      supplierNo: body.supplierNo ?? '',
      revision: body.revision ?? '',
      sampleId: body.sampleId ?? 'SMP-26018',
      round: body.round ?? '第三轮',
      measurements: body.measurements ?? measurements(0),
      submittedBy: body.submittedBy ?? '外部系统',
      source: body.source ?? '供应商系统',
      pushedAt: new Date().toLocaleString('zh-CN'),
      status: '待处理',
    }
    supplierReceipts = [record, ...supplierReceipts]
    return HttpResponse.json(record, { status: 201 })
  }),
  http.post('/api/supplier/receipts/:id/process', ({ params }) => {
    const record = supplierReceipts.find((item) => item.id === params.id)
    if (!record) return new HttpResponse(null, { status: 404 })
    record.status = '已处理'
    return HttpResponse.json(record)
  }),
]
