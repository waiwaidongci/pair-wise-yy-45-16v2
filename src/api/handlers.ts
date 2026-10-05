import { http, HttpResponse } from 'msw'
import { seedSamples } from './seed'

let samples = structuredClone(seedSamples)

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
]
