import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Chip,
  MenuItem,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import CircleIcon from '@mui/icons-material/Circle'
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined'
import { useAppSelector } from '../../app/hooks'
import { useGetBatchesQuery, useGetPendingWritesQuery } from '../../app/batchApi'
import type { Batch, BatchMeasurement, FieldDiff } from '../../api/batchTypes'
import JudgmentLockPanel from './JudgmentLockPanel'
import ReceiptPanel from './ReceiptPanel'
import ConcurrentSubmitPanel from './ConcurrentSubmitPanel'
import { LegacyDraftCard, PlanChangePanel } from './PlanAndLegacyPanels'

type Tone = 'success' | 'warning' | 'error'

const eventColor: Record<string, 'success' | 'warning' | 'error' | 'primary' | 'grey'> = {
  receipt: 'primary',
  judgment: 'success',
  lock: 'warning',
  plan: 'error',
  measurement: 'warning',
  system: 'grey',
}

export default function BatchCenterPage() {
  const samples = useAppSelector((state) => state.development.samples)
  const { data: batches = [], isLoading } = useGetBatchesQuery()
  const { data: pendingWrites = [] } = useGetPendingWritesQuery()
  const [selectedSampleId, setSelectedSampleId] = useState<string>('')
  const [toast, setToast] = useState<{ message: string; tone: Tone } | null>(null)
  // 后到者保留现场值（不覆盖生效值）
  const [loserDraft, setLoserDraft] = useState<Record<string, { measurements: BatchMeasurement[]; diffs: FieldDiff[]; message: string }>>({})

  const selectableSamples = useMemo(() => {
    const batchSampleIds = new Set(batches.map((batch) => batch.sampleId))
    const pendingSampleIds = new Set(pendingWrites.map((item) => item.sampleId))
    return samples
      .filter((sample) => batchSampleIds.has(sample.id) || pendingSampleIds.has(sample.id))
      .map((sample) => {
        const batch = batches.find((item) => item.sampleId === sample.id)
        return {
          sample,
          batch,
          pendingCount: pendingWrites.filter((item) => item.sampleId === sample.id).length,
        }
      })
  }, [samples, batches, pendingWrites])

  const sampleId = selectedSampleId || selectableSamples[0]?.sample.id || ''
  const batch: Batch | undefined = batches.find((item) => item.sampleId === sampleId)
  const sample = samples.find((item) => item.id === sampleId)
  const loser = loserDraft[sampleId] ?? null

  const notify = (message: string, tone: Tone) => setToast({ message, tone })

  const acceptLoserDraft = (measurements: BatchMeasurement[], diffs: FieldDiff[], conflictMessage: string) => {
    setLoserDraft((current) => ({ ...current, [sampleId]: { measurements, diffs, message: conflictMessage } }))
  }

  const clearLoserDraft = () => {
    setLoserDraft((current) => {
      if (!(sampleId in current)) return current
      const next = { ...current }
      delete next[sampleId]
      return next
    })
  }

  return (
    <Box className="page">
      <Box className="page-head">
        <Box>
          <Typography className="eyebrow">DELIVERY BATCH / 交样批次</Typography>
          <Typography component="h1" fontWeight={800}>交样回执 · 尺寸实测 · 审核锁定（同一份批次）</Typography>
          <Typography color="text.secondary">
            回执幂等入账、同批并发先到生效、尺寸 / 批注方案变更联动失效重算，未重新确认不能定版。
          </Typography>
        </Box>
        <TextField select size="small" sx={{ minWidth: 280 }} label="选择款式批次" value={sampleId} onChange={(event) => setSelectedSampleId(event.target.value)}>
          {selectableSamples.map(({ sample: item, batch: itemBatch, pendingCount }) => (
            <MenuItem key={item.id} value={item.id}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Inventory2OutlinedIcon fontSize="small" />
                <span>{item.styleCode} · {item.styleName}</span>
                {itemBatch?.finalized && <Chip size="small" color="success" label="已定版" />}
                {itemBatch?.lock.status === '已锁定' && <Chip size="small" color="warning" label="已锁定" />}
                {itemBatch?.judgment.stale && <Chip size="small" color="error" label="判定失效" />}
                {pendingCount > 0 && <Chip size="small" color="secondary" label={`未完成回执 ${pendingCount}`} />}
              </Stack>
            </MenuItem>
          ))}
        </TextField>
      </Box>

      {isLoading && <Alert severity="info">正在加载批次…</Alert>}
      {!sample && !isLoading && <Alert severity="info">该款式暂无批次回执。可先从「写入失败待重试」的款式进入。</Alert>}

      {sample && (
        <Stack spacing={1.5}>
          {batch?.legacyDraft && <LegacyDraftCard batch={batch} onNotified={notify} />}

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: 'minmax(0,1fr) 360px' }, gap: 1.5, alignItems: 'start' }}>
            <Stack spacing={1.5}>
              {batch ? (
                <JudgmentLockPanel
                  batch={batch}
                  localDraft={loser?.measurements ?? null}
                  conflict={loser?.message ?? null}
                  onClearConflict={clearLoserDraft}
                  onDiscardDraft={clearLoserDraft}
                />
              ) : (
                <Box className="panel" sx={{ p: 2.5 }}>
                  <Alert severity="warning">
                    {sample.styleCode} 尚无任何生效回执；右侧有写入失败后保留的未完成回执，原载荷重试成功后会自动建立批次并按首版入账。
                  </Alert>
                </Box>
              )}

              {batch && (
                <ConcurrentSubmitPanel
                  batch={batch}
                  onLoserDraft={acceptLoserDraft}
                  onNotified={notify}
                />
              )}

              {batch && <PlanChangePanel batch={batch} onNotified={notify} />}
            </Stack>

            <Stack spacing={1.5}>
              <ReceiptPanel
                batch={batch}
                sampleId={sample.id}
                pendingWrites={pendingWrites}
                onNotified={notify}
              />

              {batch && (
                <Box className="panel" sx={{ p: 1.6 }}>
                  <Typography fontWeight={800} mb={1.2}>批次审计时间线</Typography>
                  <Stack spacing={0}>
                    {batch.events.slice().reverse().map((event, index, list) => (
                      <Box key={event.id} sx={{ display: 'grid', gridTemplateColumns: '86px 20px 1fr', gap: 0.8 }}>
                        <Typography color="text.secondary" fontSize={10.5} pt={0.5} sx={{ fontFamily: 'monospace' }}>
                          {event.at.slice(5, 16)}
                        </Typography>
                        <Box sx={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
                          <CircleIcon sx={{ fontSize: 9, mt: 0.6, color: `${eventColor[event.type] ?? 'grey'}.main` }} />
                          {index < list.length - 1 && (
                            <Box sx={{ position: 'absolute', left: '50%', top: 16, bottom: -6, width: 1, bgcolor: '#d5ddd9' }} />
                          )}
                        </Box>
                        <Typography fontSize={12} fontWeight={650} sx={{ pb: 1.6 }}>{event.message}</Typography>
                      </Box>
                    ))}
                  </Stack>
                </Box>
              )}
            </Stack>
          </Box>
        </Stack>
      )}

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={4200}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {toast ? <Alert severity={toast.tone} onClose={() => setToast(null)} variant="filled">{toast.message}</Alert> : undefined}
      </Snackbar>
    </Box>
  )
}
