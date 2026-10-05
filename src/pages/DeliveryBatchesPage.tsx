import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material'
import LocalShippingOutlinedIcon from '@mui/icons-material/LocalShippingOutlined'
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined'
import LockOutlineIcon from '@mui/icons-material/LockOutlined'
import VerifiedOutlinedIcon from '@mui/icons-material/VerifiedOutlined'
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined'
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined'
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined'
import { useAppDispatch, useAppSelector } from '../app/hooks'
import {
  acknowledgeBatchConflict,
  finalizeBatch,
  lockBatch,
  receiveReceipt,
  reconfirmBatch,
  retryBatchReceipt,
  selectBatch,
  updateMeasurement,
} from '../features/developmentSlice'
import { canFinalize, measurementPassRate, overToleranceCount } from '../features/batchLogic'
import {
  useGetSupplierReceiptsQuery,
  useProcessSupplierReceiptMutation,
  usePushSupplierReceiptMutation,
} from '../app/api'
import type { BatchStatus, DeliveryBatch, ReceiptPush, SupplierReceipt } from '../api/types'

const statusColor = (status: BatchStatus): 'default' | 'primary' | 'warning' | 'success' | 'error' => {
  switch (status) {
    case '已接收':
      return 'primary'
    case '差异待确认':
      return 'warning'
    case '已锁定':
      return 'success'
    case '已定版':
      return 'success'
    case '待接收':
      return 'error'
    default:
      return 'default'
  }
}

const fmt = (n: number) => n.toFixed(1)

export default function DeliveryBatchesPage() {
  const dispatch = useAppDispatch()
  const { batches, samples, selectedBatchId } = useAppSelector((state) => state.development)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [finalizeTarget, setFinalizeTarget] = useState<DeliveryBatch | null>(null)

  const { data: supplierReceipts = [] } = useGetSupplierReceiptsQuery()
  const [pushSupplierReceipt] = usePushSupplierReceiptMutation()
  const [processSupplierReceipt] = useProcessSupplierReceiptMutation()

  const sampleName = (sampleId: string) => {
    const sample = samples.find((item) => item.id === sampleId)
    return sample ? `${sample.styleCode} · ${sample.styleName}` : sampleId
  }

  const selectedBatch = useMemo(
    () => batches.find((item) => item.id === (selectedBatchId ?? batches[0]?.id)) ?? null,
    [batches, selectedBatchId],
  )

  const stats = useMemo(() => {
    const pending = batches.filter((b) => b.status === '待接收' || b.status === '差异待确认' || b.status === '已失效').length
    return {
      total: batches.length,
      pending,
      locked: batches.filter((b) => b.status === '已锁定').length,
      finalized: batches.filter((b) => b.status === '已定版').length,
    }
  }, [batches])

  const receiveFromInbox = (receipt: SupplierReceipt) => {
    const push: ReceiptPush = {
      supplierNo: receipt.supplierNo,
      revision: receipt.revision,
      sampleId: receipt.sampleId,
      round: receipt.round,
      measurements: receipt.measurements,
      submittedBy: receipt.submittedBy,
      source: receipt.source,
    }
    dispatch(receiveReceipt(push))
    processSupplierReceipt(receipt.id)
  }

  // 场景模拟：供应商正常推送
  const simulateNormalPush = () => {
    const target = samples[0]
    const round = '第三轮'
    pushSupplierReceipt({
      supplierNo: `GYS-26${Math.floor(100 + Math.random() * 900)}`,
      revision: 'R1',
      sampleId: target.id,
      round,
      measurements: target.measurements[round].map((m) => ({ ...m, actual: m.actual + (Math.random() * 0.4 - 0.2) })),
      submittedBy: '外部系统',
      source: '供应商系统',
    })
  }

  // 场景模拟：旧草稿（无供应商单号）升级为首版
  const simulateLegacy = () => {
    const target = samples[1] ?? samples[0]
    dispatch(
      receiveReceipt({
        supplierNo: '',
        revision: '',
        sampleId: target.id,
        round: '第一轮',
        measurements: target.measurements['第一轮'].map((m) => ({ ...m })),
        submittedBy: '跟单员补录',
        source: '手工补录',
      }),
    )
  }

  // 场景模拟：写入失败，保留未完成回执可重试
  const simulateFailure = () => {
    const target = samples[0]
    dispatch(
      receiveReceipt({
        supplierNo: `GYS-26${Math.floor(100 + Math.random() * 900)}`,
        revision: 'R2',
        sampleId: target.id,
        round: '第二轮',
        measurements: target.measurements['第二轮'].map((m) => ({ ...m })),
        submittedBy: '外部系统',
        source: '供应商系统',
        forceFailure: true,
        failureReason: '写入工作台失败：网络超时，回执已保留，可重试',
      }),
    )
  }

  // 场景模拟：两名跟单员同时提交同一批次（同号重传，尺寸有差异）→ 先到生效
  const simulateConcurrent = () => {
    if (!selectedBatch || selectedBatch.status === '已定版') return
    const tweaked = selectedBatch.measurements.map((m, i) =>
      i === 0 ? { ...m, actual: +(m.actual + 0.6).toFixed(1) } : { ...m },
    )
    dispatch(
      receiveReceipt({
        supplierNo: selectedBatch.supplierNo === '待补录' ? '' : selectedBatch.supplierNo,
        revision: selectedBatch.revision === '首版' ? '' : selectedBatch.revision,
        sampleId: selectedBatch.sampleId,
        round: selectedBatch.round,
        measurements: tweaked,
        submittedBy: '跟单员 B',
        source: '手工补录',
      }),
    )
  }

  // 场景模拟：尺寸实测变更 → 超差判断与锁定结论失效，需重新确认
  const simulateMeasurementChange = () => {
    if (!selectedBatch || selectedBatch.status === '已定版') return
    const first = selectedBatch.measurements[0]
    dispatch(
      updateMeasurement({
        sampleId: selectedBatch.sampleId,
        round: selectedBatch.round,
        key: first.key,
        actual: +(first.actual + 1.2).toFixed(1),
      }),
    )
  }

  const finalizeCheck = finalizeTarget ? canFinalize(finalizeTarget) : null

  return (
    <Box className="page">
      <Box className="page-head">
        <Box>
          <Typography className="eyebrow">DELIVERY BATCH / 交样批次</Typography>
          <Typography component="h1" fontWeight={800}>交样回执 · 尺寸实测 · 审核锁定</Typography>
          <Typography color="text.secondary">
            回执带供应商单号与修订，同号重传只算一次；尺寸或批注变化后锁定结论失效，未重新确认不能定版。
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button variant="outlined" startIcon={<LocalShippingOutlinedIcon />} onClick={simulateNormalPush}>
            模拟供应商推送
          </Button>
          <Button variant="outlined" onClick={simulateLegacy}>模拟旧草稿升级</Button>
          <Button variant="outlined" color="error" onClick={simulateFailure}>模拟写入失败</Button>
          <Tooltip title={selectedBatch?.status === '已定版' ? '已定版批次不可再模拟并发' : '对当前选中批次重传同号回执，尺寸有差异时先到生效'}>
            <span>
              <Button
                variant="outlined"
                color="warning"
                startIcon={<SwapHorizOutlinedIcon />}
                onClick={simulateConcurrent}
                disabled={!selectedBatch || selectedBatch.status === '已定版'}
              >
                模拟并发提交
              </Button>
            </span>
          </Tooltip>
          <Tooltip title={selectedBatch?.status === '已定版' ? '已定版批次不可再变更尺寸' : '变更当前选中批次的尺寸实测，锁定结论将失效'}>
            <span>
              <Button
                variant="outlined"
                color="secondary"
                onClick={simulateMeasurementChange}
                disabled={!selectedBatch || selectedBatch.status === '已定版'}
              >
                模拟尺寸变更
              </Button>
            </span>
          </Tooltip>
        </Stack>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(4,1fr)' }, gap: 1.5, mb: 2 }}>
        {[
          ['批次总数', stats.total, '交样回执批次'],
          ['待处理', stats.pending, '待接收 / 差异 / 失效'],
          ['已锁定', stats.locked, '完成审核锁定'],
          ['已定版', stats.finalized, '不可覆盖'],
        ].map(([label, value, hint]) => (
          <Box className="panel" key={String(label)} sx={{ p: 2 }}>
            <Typography color="#756f69" fontSize={12}>{label}</Typography>
            <Typography fontSize={{ xs: 26, md: 32 }} fontWeight={850} mt={0.8} color="#203634">{value}</Typography>
            <Typography color="#89837e" fontSize={11}>{hint}</Typography>
          </Box>
        ))}
      </Box>

      {stats.pending > 0 && (
        <Alert severity="warning" sx={{ mb: 1.5 }}>
          当前有 {stats.pending} 个批次待处理：请确认并发差异、重新确认失效结论或重试写入失败的回执。
        </Alert>
      )}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: 'minmax(0,1.35fr) minmax(340px,.65fr)' }, gap: 1.5 }}>
        <Box className="panel">
          <Box sx={{ px: 2, py: 1.4, borderBottom: '1px solid #ece9e4', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography fontWeight={800}>批次列表</Typography>
            <Typography color="text.secondary" fontSize={11}>点击行展开尺寸实测与差异</Typography>
          </Box>

          {batches.length === 0 && (
            <Box sx={{ p: 4, textAlign: 'center' }}>
              <Typography color="text.secondary" fontSize={13}>暂无批次。</Typography>
              <Typography color="text.secondary" fontSize={12} mt={0.5}>
                可从右侧「外部系统待接收」接收回执，或点击上方按钮模拟供应商推送、旧草稿升级、写入失败与并发提交。
              </Typography>
            </Box>
          )}

          {batches.map((batch) => {
            const isOpen = expanded === batch.id
            const passRate = measurementPassRate(batch.measurements)
            const over = overToleranceCount(batch.measurements)
            return (
              <Box
                key={batch.id}
                sx={{
                  borderBottom: '1px solid #efede9',
                  bgcolor: selectedBatch?.id === batch.id ? '#f4f8f7' : 'transparent',
                  cursor: 'pointer',
                }}
                onClick={() => {
                  dispatch(selectBatch(batch.id))
                  setExpanded(isOpen ? null : batch.id)
                }}
              >
                <Box sx={{ p: 2 }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1} flexWrap="wrap">
                    <Box>
                      <Stack direction="row" spacing={0.8} alignItems="center" flexWrap="wrap">
                        <Typography fontWeight={800}>{batch.batchNo}</Typography>
                        <Chip size="small" label={batch.status} color={statusColor(batch.status)} />
                        {batch.stale && <Chip size="small" color="warning" icon={<WarningAmberOutlinedIcon />} label="已失效" />}
                        {batch.conflict && !batch.conflict.acknowledged && <Chip size="small" color="warning" variant="outlined" label="差异待确认" />}
                        {batch.writeState === '写入失败' && <Chip size="small" color="error" variant="outlined" label="写入失败" />}
                        {batch.upgradedFromLegacy && <Chip size="small" variant="outlined" label="旧草稿升级" />}
                      </Stack>
                      <Typography fontSize={13} mt={0.6}>{sampleName(batch.sampleId)} · {batch.round}</Typography>
                      <Typography color="text.secondary" fontSize={11} mt={0.3}>
                        供应商单号 {batch.supplierNo} · 修订 {batch.revision} · 来源 {batch.source}
                      </Typography>
                    </Box>
                    <Box sx={{ textAlign: 'right' }}>
                      <Typography fontWeight={800} color={over ? '#b44b2d' : '#2d7665'}>
                        达标率 {passRate}%
                      </Typography>
                      <Typography color="text.secondary" fontSize={11}>{over} 项超差</Typography>
                    </Box>
                  </Stack>

                  {batch.stale && (
                    <Alert severity="warning" sx={{ mt: 1 }}>
                      {batch.staleReasons.join('；')}。超差判断与锁定结论已失效，需重新确认。
                    </Alert>
                  )}
                  {batch.writeState === '写入失败' && (
                    <Alert severity="error" sx={{ mt: 1 }}>
                      写入失败：{batch.failureReason}（已保留，可重试，第 {batch.retryCount} 次）
                    </Alert>
                  )}
                  {batch.conflict && !batch.conflict.acknowledged && (
                    <Alert severity="info" sx={{ mt: 1 }}>
                      并发提交：先到生效，现场值已保留；后到 {batch.conflict.submittedBy} 提交了 {batch.conflict.diffs.length} 项差异。
                    </Alert>
                  )}

                  {isOpen && (
                    <Box sx={{ mt: 1.5 }} onClick={(e) => e.stopPropagation()}>
                      {batch.conflict && !batch.conflict.acknowledged && (
                        <Box sx={{ mb: 1.5 }}>
                          <Typography fontWeight={800} fontSize={12} mb={0.6}>并发差异（现场值保留，先到生效）</Typography>
                          <Table size="small">
                            <TableHead>
                              <TableRow sx={{ bgcolor: '#f6f5f2' }}>
                                <TableCell>部位</TableCell>
                                <TableCell>现场值（先到）</TableCell>
                                <TableCell>后到值</TableCell>
                                <TableCell>差异</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {batch.conflict.diffs.map((d) => (
                                <TableRow key={d.field}>
                                  <TableCell>{d.label}</TableCell>
                                  <TableCell sx={{ fontWeight: 700 }}>{fmt(Number(d.onSite))}</TableCell>
                                  <TableCell>{fmt(Number(d.incoming))}</TableCell>
                                  <TableCell>
                                    {typeof d.onSite === 'number' && typeof d.incoming === 'number'
                                      ? fmt(d.incoming - d.onSite)
                                      : '—'}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </Box>
                      )}

                      <Typography fontWeight={800} fontSize={12} mb={0.6}>尺寸实测（回执）</Typography>
                      <Table size="small">
                        <TableHead>
                          <TableRow sx={{ bgcolor: '#f6f5f2' }}>
                            <TableCell>部位</TableCell>
                            <TableCell>规格</TableCell>
                            <TableCell>容差</TableCell>
                            <TableCell>实测</TableCell>
                            <TableCell>判定</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {batch.measurements.map((m) => {
                            const ok = Math.abs(m.actual - m.spec) <= m.tolerance
                            return (
                              <TableRow key={m.key} sx={{ bgcolor: ok ? 'transparent' : '#fff4ef' }}>
                                <TableCell>{m.name}</TableCell>
                                <TableCell>{m.spec}</TableCell>
                                <TableCell>±{m.tolerance}</TableCell>
                                <TableCell sx={{ fontWeight: 700, color: ok ? '#2d7665' : '#b44b2d' }}>{fmt(m.actual)}</TableCell>
                                <TableCell>
                                  <Chip size="small" label={ok ? '达标' : '超差'} color={ok ? 'success' : 'error'} />
                                </TableCell>
                              </TableRow>
                            )
                          })}
                        </TableBody>
                      </Table>

                      {batch.lockConclusion && (
                        <Box sx={{ mt: 1.5, p: 1.2, border: '1px solid #e2dfda', borderRadius: 1 }}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <VerifiedOutlinedIcon color={batch.lockConclusion.stale ? 'disabled' : 'success'} fontSize="small" />
                            <Typography fontWeight={800} fontSize={12}>
                              锁定结论 {batch.lockConclusion.stale ? '（已失效）' : ''}
                            </Typography>
                          </Stack>
                          <Typography color="text.secondary" fontSize={11} mt={0.4}>
                            {batch.lockConclusion.round} · 达标率 {batch.lockConclusion.measurementPassRate}% · 未关闭批注 {batch.lockConclusion.openAnnotations} 项 · {batch.lockConclusion.lockedBy} 于 {batch.lockConclusion.lockedAt} 锁定
                          </Typography>
                        </Box>
                      )}

                      <Stack direction="row" spacing={1} mt={1.5} flexWrap="wrap" useFlexGap>
                        {batch.writeState === '写入失败' && (
                          <Button
                            size="small"
                            variant="contained"
                            color="error"
                            startIcon={<RefreshOutlinedIcon />}
                            onClick={() => dispatch(retryBatchReceipt(batch.id))}
                          >
                            重试写入
                          </Button>
                        )}
                        {batch.conflict && !batch.conflict.acknowledged && (
                          <>
                            <Button
                              size="small"
                              variant="contained"
                              onClick={() => dispatch(acknowledgeBatchConflict({ batchId: batch.id, keepOnSite: true }))}
                            >
                              确认差异（保留现场值）
                            </Button>
                            <Button
                              size="small"
                              variant="outlined"
                              onClick={() => dispatch(acknowledgeBatchConflict({ batchId: batch.id, keepOnSite: false }))}
                            >
                              采纳后到值
                            </Button>
                          </>
                        )}
                        {batch.stale && batch.status !== '已定版' && (
                          <Button
                            size="small"
                            variant="contained"
                            color="warning"
                            startIcon={<HistoryOutlinedIcon />}
                            onClick={() => dispatch(reconfirmBatch(batch.id))}
                          >
                            重新确认
                          </Button>
                        )}
                        {batch.status === '已接收' && !batch.stale && (
                          <Button
                            size="small"
                            variant="contained"
                            startIcon={<LockOutlineIcon />}
                            onClick={() => dispatch(lockBatch(batch.id))}
                          >
                            审核锁定
                          </Button>
                        )}
                        {(batch.status === '已锁定' || batch.status === '已失效') && (
                          <Button
                            size="small"
                            variant="contained"
                            color="success"
                            startIcon={<VerifiedOutlinedIcon />}
                            onClick={() => setFinalizeTarget(batch)}
                          >
                            定版
                          </Button>
                        )}
                      </Stack>
                    </Box>
                  )}
                </Box>
              </Box>
            )
          })}
        </Box>

        <Box className="panel" sx={{ alignSelf: 'start' }}>
          <Box sx={{ px: 1.8, py: 1.4, borderBottom: '1px solid #ece9e4' }}>
            <Typography fontWeight={800}>外部系统待接收</Typography>
            <Typography color="text.secondary" fontSize={11} mt={0.3}>供应商推送的交样回执，接收到工作台后生成批次</Typography>
          </Box>
          <Stack spacing={1.2} p={1.5}>
            {supplierReceipts.filter((r) => r.status === '待处理').length === 0 && (
              <Typography color="text.secondary" fontSize={12}>暂无待接收回执。</Typography>
            )}
            {supplierReceipts
              .filter((r) => r.status === '待处理')
              .map((receipt) => (
                <Box key={receipt.id} sx={{ p: 1.3, border: '1px solid #e4e1dc', borderRadius: 1 }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography fontWeight={800} fontSize={13}>
                      {receipt.supplierNo || '无供应商单号'} · {receipt.revision || '首版'}
                    </Typography>
                    <Chip size="small" label={receipt.round} />
                  </Stack>
                  <Typography color="text.secondary" fontSize={11} mt={0.4}>
                    {sampleName(receipt.sampleId)} · {receipt.submittedBy} · {receipt.pushedAt}
                  </Typography>
                  <Button size="small" variant="outlined" sx={{ mt: 1 }} onClick={() => receiveFromInbox(receipt)}>
                    接收到工作台
                  </Button>
                </Box>
              ))}
          </Stack>
        </Box>
      </Box>

      <Dialog open={Boolean(finalizeTarget)} onClose={() => setFinalizeTarget(null)} fullWidth maxWidth="sm">
        <DialogTitle>确认定版</DialogTitle>
        <DialogContent>
          {finalizeCheck?.ok ? (
            <Typography color="text.secondary">
              批次 {finalizeTarget?.batchNo} 已完成审核锁定，尺寸实测与批注均已确认。定版后批次不可覆盖。
            </Typography>
          ) : (
            <Alert severity="warning" sx={{ mt: 1 }}>
              未重新确认不能进入定版：
              <Box component="ul" sx={{ m: 0, pl: 2 }}>
                {finalizeCheck?.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </Box>
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setFinalizeTarget(null)}>取消</Button>
          <Button
            variant="contained"
            color="success"
            disabled={!finalizeCheck?.ok}
            onClick={() => {
              if (finalizeTarget) dispatch(finalizeBatch(finalizeTarget.id))
              setFinalizeTarget(null)
            }}
          >
            确认定版
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
