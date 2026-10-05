import { useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import CloudSyncOutlinedIcon from '@mui/icons-material/CloudSyncOutlined'
import ReplayOutlinedIcon from '@mui/icons-material/ReplayOutlined'
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined'
import type { Batch, IngestReceiptResponse, PendingWrite } from '../../api/batchTypes'
import { useIngestReceiptMutation, useRetryPendingWriteMutation } from '../../app/batchApi'

type Props = {
  batch: Batch | undefined
  sampleId: string
  pendingWrites: PendingWrite[]
  onNotified: (message: string, tone: 'success' | 'warning' | 'error') => void
}

const statusChip: Record<string, { label: string; color: 'success' | 'warning' | 'default' }> = {
  accepted: { label: '生效', color: 'success' },
  duplicate: { label: '同号重传·仅记录', color: 'default' },
  expired: { label: '晚到旧修订', color: 'warning' },
}

export default function ReceiptPanel({ batch, sampleId, pendingWrites, onNotified }: Props) {
  const [ingest, ingestState] = useIngestReceiptMutation()
  const [retry, retryState] = useRetryPendingWriteMutation()
  const [orderNo, setOrderNo] = useState(batch?.supplierOrderNo ?? '')
  const [revision, setRevision] = useState<number>(1)
  const [note, setNote] = useState('')
  const [simulateFailure, setSimulateFailure] = useState(false)

  // 切换款式批次后同步表单默认值
  useEffect(() => {
    setOrderNo(batch?.supplierOrderNo ?? '')
    setRevision((batch?.revision ?? 0) + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleId, batch?.supplierOrderNo, batch?.revision])

  const minePending = pendingWrites.filter((item) => item.sampleId === sampleId)
  // 演示用：更早一版（晚到旧修订）、当前修订（同号重传）、下一修订（新回执）
  const currentRevision = batch?.revision ?? 0
  const revisionOptions = [currentRevision - 1, currentRevision, currentRevision + 1]
    .filter((value) => value >= 1)
    .filter((value, index, list) => list.indexOf(value) === index)

  const submit = async () => {
    try {
      const response = (await ingest({
        sampleId,
        supplierName: batch?.supplierName,
        supplierOrderNo: orderNo.trim() || null,
        revision,
        measurements: null,
        note: note.trim() || `供应商回执 修订 ${revision}`,
        simulateWriteFailure: simulateFailure,
      }).unwrap()) as IngestReceiptResponse
      if (response.outcome === 'write-failed') onNotified(response.message, 'warning')
      else onNotified(response.message, response.outcome === 'expired' ? 'warning' : 'success')
      setNote('')
      setSimulateFailure(false)
    } catch (error) {
      onNotified((error as { data?: { message: string } })?.data?.message ?? '回执写入失败。', 'error')
    }
  }

  const retryWrite = async (token: string) => {
    try {
      const response = await retry(token).unwrap() as IngestReceiptResponse
      onNotified(`未完成回执已重试成功（${response.outcome === 'duplicate' ? '同号仅记录一次' : '已并入批次'}）。`, 'success')
    } catch (error) {
      const data = (error as { data?: { message?: string } })?.data
      onNotified(data?.message ?? '重试失败，未完成回执继续保留，可再次重试。', 'error')
    }
  }
  return (
    <Box className="panel" sx={{ alignSelf: 'start' }}>
      <Box sx={{ p: 1.6, borderBottom: '1px solid #ece9e4' }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <CloudSyncOutlinedIcon color="primary" fontSize="small" />
          <Typography fontWeight={800}>供应商交样回执</Typography>
        </Stack>
        <Typography color="text.secondary" fontSize={11.5} mt={0.6}>
          回执带供应商单号与修订；同号同修订重传只算一次；晚到旧修订登记但不覆盖现行尺寸。
        </Typography>
      </Box>

      <Stack spacing={1.4} sx={{ p: 1.6 }}>
        <TextField
          size="small"
          label="供应商单号"
          value={orderNo}
          onChange={(event) => setOrderNo(event.target.value)}
          placeholder="如 PO-MZ-2609-118"
          disabled={Boolean(batch?.finalized)}
        />
        <TextField
          select
          size="small"
          label="修订号"
          value={revision}
          onChange={(event) => setRevision(Number(event.target.value))}
          disabled={Boolean(batch?.finalized)}
        >
          {revisionOptions.map((value) => (
            <MenuItem key={value} value={value}>
              修订 {value}
              {value === currentRevision ? '（同号重传演示）' : value < currentRevision ? '（晚到旧修订演示）' : '（新回执）'}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          multiline
          minRows={2}
          label="回执说明"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={Boolean(batch?.finalized)}
        />
        <FormControlLabel
          control={<Switch size="small" checked={simulateFailure} onChange={(event) => setSimulateFailure(event.target.checked)} />}
          label={<Typography fontSize={12}>模拟供应商系统写入失败（502）</Typography>}
        />
        <Button variant="contained" fullWidth startIcon={<UploadFileOutlinedIcon />} disabled={ingestState.isLoading || batch?.finalized} onClick={submit}>
          接取回执并入批次
        </Button>
      </Stack>

      {minePending.length > 0 && (
        <>
          <Divider />
          <Box sx={{ p: 1.6 }}>
            <Alert severity="warning" sx={{ mb: 1.2 }}>
              {minePending.length} 份未完成回执：写入失败但已保留现场，可原载荷接着重试。
            </Alert>
            <Stack spacing={1}>
              {minePending.map((pending) => (
                <Box key={pending.token} sx={{ p: 1.2, border: '1px dashed #d8a25f', borderRadius: 1, bgcolor: '#fffaf2' }}>
                  <Typography fontWeight={800} fontSize={12.5}>
                    {pending.supplierOrderNo ?? '（无单号）'} · 修订 {pending.revision ?? '?'}
                  </Typography>
                  <Typography color="text.secondary" fontSize={11} mt={0.4}>{pending.note}</Typography>
                  <Typography color="#a35d2b" fontSize={11} mt={0.4}>
                    最近错误：{pending.lastError} · 已尝试 {pending.attempts} 次 · {pending.createdAt}
                  </Typography>
                  <Button size="small" sx={{ mt: 0.6 }} variant="outlined" startIcon={<ReplayOutlinedIcon />} disabled={retryState.isLoading} onClick={() => retryWrite(pending.token)}>
                    原载荷重试
                  </Button>
                </Box>
              ))}
            </Stack>
          </Box>
        </>
      )}

      <Divider />
      <Box sx={{ p: 1.6 }}>
        <Typography fontWeight={800} fontSize={13} mb={1}>批次回执台账</Typography>
        <Table size="small">
          <TableHead>
            <TableRow sx={{ bgcolor: '#f6f5f2' }}>
              <TableCell>供应商单号</TableCell>
              <TableCell>修订</TableCell>
              <TableCell>到达时间</TableCell>
              <TableCell>状态</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(batch?.receipts ?? []).slice().reverse().map((receipt) => (
              <TableRow key={`${receipt.idempotencyKey}-${receipt.receivedAt}`}>
                <TableCell>
                  <Typography fontSize={12} fontWeight={700}>{receipt.supplierOrderNo}</Typography>
                  <Typography fontSize={10.5} color="text.secondary">{receipt.note}</Typography>
                </TableCell>
                <TableCell>v{receipt.revision}</TableCell>
                <TableCell><Typography fontSize={11}>{receipt.receivedAt}</Typography></TableCell>
                <TableCell><Chip size="small" {...statusChip[receipt.status]} /></TableCell>
              </TableRow>
            ))}
            {(!batch || batch.receipts.length === 0) && (
              <TableRow>
                <TableCell colSpan={4}>
                  <Typography fontSize={12} color="text.secondary" sx={{ py: 1 }}>暂无生效回执。</Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Box>
    </Box>
  )
}
