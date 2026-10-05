import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import AutorenewIcon from '@mui/icons-material/Autorenew'
import LockClockOutlinedIcon from '@mui/icons-material/LockClockOutlined'
import LockOpenOutlinedIcon from '@mui/icons-material/LockOpenOutlined'
import VerifiedOutlinedIcon from '@mui/icons-material/VerifiedOutlined'
import TaskAltOutlinedIcon from '@mui/icons-material/TaskAltOutlined'
import type { Batch, BatchMeasurement } from '../../api/batchTypes'
import {
  useConfirmJudgmentMutation,
  useFinalizeBatchMutation,
  useLockBatchMutation,
  useUnlockBatchMutation,
} from '../../app/batchApi'
import type { FetchBaseQueryError } from '@reduxjs/toolkit/query'

type Props = {
  batch: Batch
  /** 后到者保留的现场值；存在时表格展示现场值并标出与生效值差异 */
  localDraft: BatchMeasurement[] | null
  conflict: string | null
  onClearConflict: () => void
  /** 后到者放弃现场值、回到生效值 */
  onDiscardDraft: () => void
}

function isConflictError(error: unknown): error is FetchBaseQueryError & { status: number } {
  return typeof error === 'object' && error !== null && 'status' in error && (error as { status?: number }).status === 409
}

export default function JudgmentLockPanel({ batch, localDraft, conflict, onClearConflict, onDiscardDraft }: Props) {
  const [confirm, confirmState] = useConfirmJudgmentMutation()
  const [lock, lockState] = useLockBatchMutation()
  const [unlock, unlockState] = useUnlockBatchMutation()
  const [finalize, finalizeState] = useFinalizeBatchMutation()
  const [operator, setOperator] = useState('沈岚')

  const busy = confirmState.isLoading || lockState.isLoading || unlockState.isLoading || finalizeState.isLoading
  const readonly = batch.finalized
  const serverRows = batch.measurements
  const draftMap = new Map((localDraft ?? []).map((item) => [item.key, item.actual]))

  const latestError = confirmState.error ?? lockState.error ?? unlockState.error ?? finalizeState.error
  let errorMessage = conflict
  if (!errorMessage && latestError) {
    if (isConflictError(latestError) && latestError.data) {
      errorMessage = (latestError.data as { message: string }).message
    } else {
      errorMessage = (latestError as { error?: string })?.error ?? '请求失败，请重试。'
    }
  }

  const canLock = batch.judgment.status === '已确认' && !batch.judgment.stale && batch.lock.status !== '已锁定'
  const canFinalize = batch.lock.status === '已锁定' && !batch.judgment.stale && !batch.finalized

  const runConfirm = async () => {
    try {
      await confirm({ sampleId: batch.sampleId, version: batch.version, by: operator, measurements: batch.measurements }).unwrap()
      // 以生效值重新确认后，后到者现场值已无意义
      onClearConflict()
    } catch {
      // 错误信息由 latestError 展示（并发冲突交给现场值面板处理）
    }
  }


  return (
    <Box className="panel">
      <Box sx={{ px: 2, py: 1.4, borderBottom: '1px solid #ece9e4', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography fontWeight={800}>尺寸实测 · 超差判定 · 审核锁定</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          <Chip size="small" label={`版本 v${batch.version}`} variant="outlined" />
          {batch.judgment.status === '已确认' && (
            <Chip
              size="small"
              color={batch.judgment.stale ? 'warning' : 'success'}
              icon={batch.judgment.stale ? <AutorenewIcon /> : <VerifiedOutlinedIcon />}
              label={batch.judgment.stale ? '判定失效待重算' : `已确认 · ${batch.judgment.confirmedBy}`}
            />
          )}
          <Chip
            size="small"
            color={batch.lock.status === '已锁定' ? 'success' : batch.lock.status === '已失效' ? 'warning' : 'default'}
            icon={<LockClockOutlinedIcon />}
            label={batch.lock.status === '未锁定' ? '未锁定' : batch.lock.status === '已锁定' ? `已锁定 · ${batch.lock.lockedBy}` : '锁定已失效'}
          />
          {batch.finalized && <Chip size="small" color="success" icon={<TaskAltOutlinedIcon />} label={`已定版 ${batch.finalizedAt ?? ''}`} />}
        </Stack>
      </Box>

      {batch.judgment.stale && (
        <Alert severity="warning" sx={{ m: 1.5, mb: 0 }} icon={<AutorenewIcon />}>
          {batch.judgment.staleReason ?? '尺寸或批注方案已变更，超差判定与锁定结论已失效。'}
          {batch.lock.status === '已失效' && ' 请重新确认判定后再锁定；未重新确认不能进入定版。'}
        </Alert>
      )}
      {errorMessage && (
        <Alert
          severity={conflict ? 'warning' : 'error'}
          sx={{ m: 1.5, mb: 0 }}
          onClose={onClearConflict}
        >
          {errorMessage}
        </Alert>
      )}
      {batch.submitWinner && (
        <Alert severity="info" sx={{ m: 1.5, mb: 0 }}>
          先到提交：{batch.submitWinner.by} 于 {batch.submitWinner.at} 基于 v{batch.submitWinner.baseVersion} 生效。
          {localDraft && ' 你是后到者，现场值已保留，表格中以「现场值」列展示。'}
        </Alert>
      )}

      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow sx={{ bgcolor: '#f6f5f2' }}>
              <TableCell>部位</TableCell>
              <TableCell>规格</TableCell>
              <TableCell>±容差</TableCell>
              <TableCell>生效实测</TableCell>
              {localDraft && <TableCell sx={{ bgcolor: '#fff7ec' }}>我的现场值（保留）</TableCell>}
              <TableCell>偏差</TableCell>
              <TableCell>判定</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {serverRows.map((item) => {
              const evaluated = batch.judgment.items.find((row) => row.key === item.key)
              const out = evaluated?.outOfTolerance ?? false
              const draftActual = draftMap.get(item.key)
              const diffFromWinner = draftActual !== undefined && Math.abs(draftActual - item.actual) > 0.001
              return (
                <TableRow key={item.key} sx={{ bgcolor: out ? '#fff4ef' : 'transparent' }}>
                  <TableCell sx={{ fontWeight: 750 }}>{item.name}</TableCell>
                  <TableCell>{item.spec}</TableCell>
                  <TableCell>±{item.tolerance}</TableCell>
                  <TableCell sx={{ fontWeight: 800, color: out ? '#b44b2d' : '#2d7665' }}>{item.actual.toFixed(1)}</TableCell>
                  {localDraft && (
                    <TableCell sx={{ bgcolor: diffFromWinner ? '#fdecd2' : '#fffaf2', fontWeight: diffFromWinner ? 800 : 500, color: diffFromWinner ? '#ad552d' : undefined }}>
                      {draftActual !== undefined ? draftActual.toFixed(1) : '—'}
                      {diffFromWinner && <Chip size="small" sx={{ ml: 0.6 }} label="差异" color="warning" />}
                    </TableCell>
                  )}
                  <TableCell>{evaluated ? `${evaluated.deviation > 0 ? '+' : ''}${evaluated.deviation.toFixed(1)}` : '—'}</TableCell>
                  <TableCell>
                    <Chip size="small" color={out ? 'error' : 'success'} label={out ? '超差' : '达标'} />
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Box>

      <Box sx={{ p: 1.6, borderTop: '1px solid #ece9e4', display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
        <TextField size="small" sx={{ width: 130 }} label="跟单员" value={operator} onChange={(event) => setOperator(event.target.value)} disabled={readonly} />
        <Tooltip title={batch.judgment.status === '未判定' ? '确认当前尺寸下的超差判定结果' : '尺寸/方案变化后需重新确认'}>
          <span>
            <Button
              variant={batch.judgment.status === '已确认' && !batch.judgment.stale ? 'outlined' : 'contained'}
              startIcon={<VerifiedOutlinedIcon />}
              disabled={busy || readonly}
              onClick={runConfirm}
            >
              {batch.judgment.status === '已确认' ? '重新确认判定' : '确认超差判定'}
            </Button>
          </span>
        </Tooltip>
        {batch.lock.status !== '已锁定' ? (
          <Tooltip title={canLock ? '' : '判定未确认或已失效，不能锁定'}>
            <span>
              <Button
                variant="contained"
                color="secondary"
                startIcon={<LockClockOutlinedIcon />}
                disabled={busy || readonly || !canLock}
                onClick={() => lock({ sampleId: batch.sampleId, version: batch.version, by: operator })}
              >
                {batch.lock.status === '已失效' ? '重新审核锁定' : '审核锁定'}
              </Button>
            </span>
          </Tooltip>
        ) : (
          <Button variant="outlined" startIcon={<LockOpenOutlinedIcon />} disabled={busy || readonly} onClick={() => unlock({ sampleId: batch.sampleId, version: batch.version, by: operator })}>
            解锁（开修订分支）
          </Button>
        )}
        <Tooltip title={canFinalize ? '' : '必须在判定有效且已锁定时定版'}>
          <span>
            <Button
              variant="contained"
              color="success"
              startIcon={<TaskAltOutlinedIcon />}
              disabled={busy || readonly || !canFinalize}
              onClick={() => finalize({ sampleId: batch.sampleId, version: batch.version, by: operator })}
            >
              进入定版
            </Button>
          </span>
        </Tooltip>
        {localDraft && (
          <Button sx={{ ml: 'auto' }} onClick={onDiscardDraft}>放弃现场值，采用生效值</Button>
        )}
      </Box>
      <Typography fontSize={11} color="text.secondary" sx={{ px: 1.6, pb: 1.2 }}>
        所有提交携带版本号 v{batch.version}；两名跟单员同时提交时先到生效，后到保留现场值并列出差异。
      </Typography>
    </Box>
  )
}
