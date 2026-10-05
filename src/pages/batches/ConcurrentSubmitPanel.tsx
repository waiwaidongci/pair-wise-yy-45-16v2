import { useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import BoltOutlinedIcon from '@mui/icons-material/BoltOutlined'
import PersonOutlineIcon from '@mui/icons-material/PersonOutline'
import type { Batch, BatchMeasurement, FieldDiff } from '../../api/batchTypes'
import { useConfirmJudgmentMutation } from '../../app/batchApi'
import type { FetchBaseQueryError } from '@reduxjs/toolkit/query'

type Props = {
  batch: Batch
  /** 后到者现场值交给页面保留，并在上方判定面板中展示差异 */
  onLoserDraft: (draft: BatchMeasurement[], diffs: FieldDiff[], conflictMessage: string) => void
  onNotified: (message: string, tone: 'success' | 'warning' | 'error') => void
}

type Seat = { name: string; edits: Record<string, string>; version: number }

function errorDiffs(error: unknown): { message: string; diffs: FieldDiff[] } | null {
  if (typeof error !== 'object' || error === null) return null
  const candidate = error as FetchBaseQueryError
  if (candidate.status !== 409 || !candidate.data) return null
  const data = candidate.data as { message: string; fieldDiffs?: FieldDiff[] }
  return { message: data.message, diffs: data.fieldDiffs ?? [] }
}

export default function ConcurrentSubmitPanel({ batch, onLoserDraft, onNotified }: Props) {
  const [confirm] = useConfirmJudgmentMutation()
  const [seatA, setSeatA] = useState<Seat>({ name: '跟单员·小沈', edits: {}, version: batch.version })
  const [seatB, setSeatB] = useState<Seat>({ name: '跟单员·小周', edits: {}, version: batch.version })
  const [running, setRunning] = useState(false)
  const [lastDiffs, setLastDiffs] = useState<FieldDiff[]>([])

  // 批次版本推进（先到提交/回执/方案变更）后，两个座位都基于新版本继续
  useEffect(() => {
    setSeatA((current) => ({ ...current, version: batch.version }))
    setSeatB((current) => ({ ...current, version: batch.version }))
    setLastDiffs([])
  }, [batch.id, batch.version])

  // 切换到另一款式批次：清空两个座位的现场编辑
  useEffect(() => {
    setSeatA((current) => ({ ...current, edits: {} }))
    setSeatB((current) => ({ ...current, edits: {} }))
  }, [batch.id])

  const buildMeasurements = (seat: Seat): BatchMeasurement[] =>
    batch.measurements.map((item) => ({
      ...item,
      actual: seat.edits[item.key] !== undefined ? Number(seat.edits[item.key]) : item.actual,
    }))

  const setEdit = (which: 'A' | 'B', key: string, value: string) => {
    const setter = which === 'A' ? setSeatA : setSeatB
    setter((current) => ({ ...current, edits: { ...current.edits, [key]: value } }))
  }

  const submitSeat = async (which: 'A' | 'B') => {
    const seat = which === 'A' ? seatA : seatB
    try {
      await confirm({
        sampleId: batch.sampleId,
        version: seat.version,
        by: seat.name,
        measurements: buildMeasurements(seat),
      }).unwrap()
      onNotified(`${seat.name} 基于 v${seat.version} 提交，先到生效。`, 'success')
      setterClear(which)
    } catch (error) {
      const conflict = errorDiffs(error)
      if (conflict) {
        const draft = buildMeasurements(seat)
        setLastDiffs(conflict.diffs)
        onLoserDraft(draft, conflict.diffs, conflict.message)
        onNotified(`${seat.name} 后到：现场值已保留，差异 ${conflict.diffs.length} 项。`, 'warning')
      } else {
        onNotified((error as { data?: { message: string } })?.data?.message ?? '提交失败。', 'error')
      }
    }
  }

  const setterClear = (which: 'A' | 'B') => {
    const setter = which === 'A' ? setSeatA : setSeatB
    setter((current) => ({ ...current, edits: {} }))
  }

  /** 两人同时提交：并行发出，服务端按到达顺序裁决 */
  const submitBoth = async () => {
    setRunning(true)
    const seats: Array<{ which: 'A' | 'B'; seat: Seat }> = [
      { which: 'A', seat: seatA },
      { which: 'B', seat: seatB },
    ]
    const results = await Promise.allSettled(
      seats.map(({ which, seat }) =>
        confirm({ sampleId: batch.sampleId, version: seat.version, by: seat.name, measurements: buildMeasurements(seat) })
          .unwrap()
          .then(() => ({ which, ok: true as const }))
          .catch((error: unknown) => ({ which, ok: false as const, conflict: errorDiffs(error), error })),
      ),
    )
    let loser: { draft: BatchMeasurement[]; diffs: FieldDiff[]; message: string } | null = null
    results.forEach((result) => {
      if (result.status !== 'fulfilled') return
      const value = result.value
      const seat = value.which === 'A' ? seatA : seatB
      if (value.ok) {
        onNotified(`${seat.name} 先到，提交已生效。`, 'success')
        setterClear(value.which)
      } else if (value.conflict) {
        const conflict: { message: string; diffs: FieldDiff[] } = value.conflict
        loser = { draft: buildMeasurements(seat), diffs: conflict.diffs, message: conflict.message }
      } else {
        onNotified((value.error as { data?: { message: string } })?.data?.message ?? '提交失败。', 'error')
      }
    })
    if (loser) {
      const loserInfo: { draft: BatchMeasurement[]; diffs: FieldDiff[]; message: string } = loser
      setLastDiffs(loserInfo.diffs)
      onLoserDraft(loserInfo.draft, loserInfo.diffs, loserInfo.message)
      onNotified('后到者现场值已保留，差异已列在判定面板。', 'warning')
    }
    setRunning(false)
  }

  if (batch.finalized) {
    return (
      <Box className="panel" sx={{ p: 2 }}>
        <Alert severity="success">批次已定版冻结，协同提交通道关闭。</Alert>
      </Box>
    )
  }

  const renderSeat = (which: 'A' | 'B') => {
    const seat = which === 'A' ? seatA : seatB
    return (
      <Box sx={{ flex: 1, minWidth: 280, border: '1px solid #e4e1dc', borderRadius: 1.2, p: 1.3 }}>
        <Stack direction="row" alignItems="center" spacing={0.8} mb={1}>
          <PersonOutlineIcon fontSize="small" />
          <TextField size="small" variant="standard" value={seat.name} onChange={(event) => (which === 'A' ? setSeatA({ ...seatA, name: event.target.value }) : setSeatB({ ...seatB, name: event.target.value }))} />
          <Chip size="small" variant="outlined" label={`基于 v${seat.version}`} />
        </Stack>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>部位</TableCell>
              <TableCell>生效值</TableCell>
              <TableCell>现场实测</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {batch.measurements.slice(0, 6).map((item) => {
              const value = seat.edits[item.key] ?? String(item.actual)
              const changed = value !== String(item.actual)
              return (
                <TableRow key={item.key}>
                  <TableCell>{item.name}</TableCell>
                  <TableCell>{item.actual.toFixed(1)}</TableCell>
                  <TableCell>
                    <TextField
                      size="small"
                      value={value}
                      sx={{ width: 92 }}
                      inputProps={{ inputMode: 'decimal' }}
                      onChange={(event) => setEdit(which, item.key, event.target.value)}
                      color={changed ? 'warning' : 'primary'}
                    />
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        <Button size="small" sx={{ mt: 1 }} variant="outlined" onClick={() => submitSeat(which)}>
          该跟单员提交确认
        </Button>
      </Box>
    )
  }

  return (
    <Box className="panel">
      <Box sx={{ px: 2, py: 1.4, borderBottom: '1px solid #ece9e4', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
        <Typography fontWeight={800}>两名跟单员同时提交同一批次（乐观锁）</Typography>
        <Button variant="contained" color="secondary" size="small" startIcon={<BoltOutlinedIcon />} disabled={running} onClick={submitBoth}>
          {running ? '同时提交中…' : '两人同时提交（并行裁决）'}
        </Button>
      </Box>
      <Box sx={{ display: 'flex', gap: 1.5, p: 1.5, flexWrap: 'wrap' }}>
        {renderSeat('A')}
        {renderSeat('B')}
      </Box>
      {lastDiffs.length > 0 && (
        <Box sx={{ px: 1.5, pb: 1.5 }}>
          <Alert severity="warning" sx={{ mb: 1 }}>后到者与生效值差异（现场值已保留，可比对后决定采用哪一版）：</Alert>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ bgcolor: '#f6f5f2' }}>
                <TableCell>部位</TableCell>
                <TableCell>后到现场值</TableCell>
                <TableCell>先生效值</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {lastDiffs.map((diff) => (
                <TableRow key={diff.path}>
                  <TableCell>{diff.label}</TableCell>
                  <TableCell sx={{ color: '#ad552d', fontWeight: 800 }}>{diff.client}</TableCell>
                  <TableCell sx={{ color: '#2d7665', fontWeight: 800 }}>{diff.server}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
      <Typography fontSize={11} color="text.secondary" sx={{ px: 1.6, pb: 1.2 }}>
        每个座位都基于自己看到的版本号提交；服务端先到递增版本，后到收到 409，现场编辑不会被覆盖。
      </Typography>
    </Box>
  )
}
