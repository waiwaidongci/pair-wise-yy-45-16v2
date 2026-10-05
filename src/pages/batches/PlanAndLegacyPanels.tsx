import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import PostAddOutlinedIcon from '@mui/icons-material/PostAddOutlined'
import UpgradeOutlinedIcon from '@mui/icons-material/UpgradeOutlined'
import LightbulbOutlinedIcon from '@mui/icons-material/LightbulbOutlined'
import type { Batch } from '../../api/batchTypes'
import { useAddReviewAnnotationMutation, useUpgradeLegacyMutation } from '../../app/batchApi'

/* ---------------- 批注 / 方案变更联动 ---------------- */

export function PlanChangePanel({ batch, onNotified }: { batch: Batch; onNotified: (message: string, tone: 'success' | 'warning' | 'error') => void }) {
  const [addAnnotation, state] = useAddReviewAnnotationMutation()
  const [content, setContent] = useState('')

  const submit = async () => {
    try {
      const result = await addAnnotation({ sampleId: batch.sampleId, content: content.trim() || undefined }).unwrap()
      onNotified(result.message, result.changed ? 'warning' : 'success')
      setContent('')
    } catch (error) {
      onNotified((error as { data?: { message: string } })?.data?.message ?? '同步失败。', 'error')
    }
  }

  return (
    <Box className="panel">
      <Box sx={{ px: 2, py: 1.4, borderBottom: '1px solid #ece9e4' }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <LightbulbOutlinedIcon color="secondary" fontSize="small" />
          <Typography fontWeight={800}>批注 / 方案变更联动</Typography>
        </Stack>
        <Typography color="text.secondary" fontSize={11.5} mt={0.6}>
          尺寸或批注方案一变，相关超差判断与锁定结论立即失效并按新依据重算；未重新确认不能锁定 / 定版。
        </Typography>
      </Box>
      <Box sx={{ p: 1.6, display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', md: 'minmax(0,1.2fr) minmax(260px,.8fr)' } }}>
        <Box>
          <TextField
            multiline
            minRows={2}
            fullWidth
            size="small"
            label="模拟内部刚做完的评审批注"
            value={content}
            disabled={batch.finalized}
            onChange={(event) => setContent(event.target.value)}
            placeholder="例如：袖口暗扣拉力复测后建议加衬，影响袖长合缝方案"
          />
          <Button sx={{ mt: 1 }} size="small" variant="contained" startIcon={<PostAddOutlinedIcon />} disabled={state.isLoading || batch.finalized} onClick={submit}>
            写入评审并同步批次依据
          </Button>
          {batch.judgment.stale && (
            <Alert severity="warning" sx={{ mt: 1.2 }} icon={<Chip size="small" color="warning" label="失效" />}>
              当前判定相对最新依据已失效：{batch.judgment.staleReason}
            </Alert>
          )}
        </Box>
        <Box sx={{ border: '1px solid #e4e1dc', borderRadius: 1.2, maxHeight: 220, overflowY: 'auto' }}>
          <Typography fontWeight={800} fontSize={12} sx={{ px: 1.3, py: 0.9, bgcolor: '#f6f5f2' }}>
            当前方案依据信号（{batch.planSignals.length}）
          </Typography>
          <List dense disablePadding>
            {batch.planSignals.map((signal) => (
              <ListItem key={signal} sx={{ py: 0.4, px: 1.3, borderBottom: '1px solid #f0eee9' }}>
                <ListItemText
                  primaryTypographyProps={{ fontSize: 11.5 }}
                  primary={signal}
                  secondary={signal.includes('待处理') || signal.includes('待决定') ? <Chip size="small" color="warning" variant="outlined" label="待处理/待决定" /> : null}
                />
              </ListItem>
            ))}
            {batch.planSignals.length === 0 && (
              <ListItem><ListItemText primaryTypographyProps={{ fontSize: 12 }} secondary="评审档案中还没有批注或方案。" /></ListItem>
            )}
          </List>
        </Box>
      </Box>
    </Box>
  )
}

/* ---------------- 旧草稿升级首版 ---------------- */

export function LegacyDraftCard({ batch, onNotified }: { batch: Batch; onNotified: (message: string, tone: 'success' | 'warning' | 'error') => void }) {
  const [upgrade, state] = useUpgradeLegacyMutation()
  const [open, setOpen] = useState(false)
  const [orderNo, setOrderNo] = useState('')

  if (!batch.legacyDraft) return null

  const submit = async () => {
    try {
      const result = await upgrade({ sampleId: batch.sampleId, supplierOrderNo: orderNo.trim() }).unwrap()
      onNotified(result.message, 'success')
      setOpen(false)
      setOrderNo('')
    } catch (error) {
      onNotified((error as { data?: { message: string } })?.data?.message ?? '升级失败。', 'error')
    }
  }

  return (
    <Box className="panel" sx={{ p: 1.8, borderLeft: '4px solid #d8a25f' }}>
      <Stack direction="row" spacing={1} alignItems="center" mb={0.8}>
        <UpgradeOutlinedIcon color="secondary" />
        <Typography fontWeight={800}>旧草稿待升级为首版回执</Typography>
        <Chip size="small" color="warning" label="缺供应商单号" />
      </Stack>
      <Typography color="text.secondary" fontSize={12.5}>
        创建于 {batch.legacyDraft.createdAt}：{batch.legacyDraft.note}
      </Typography>
      <Typography fontSize={11.5} color="text.secondary" mt={0.8}>
        旧草稿没有供应商单号时不并入批次；回填单号后升级为首版（修订 1）并写入回执台账。
      </Typography>
      <Button sx={{ mt: 1.2 }} size="small" variant="contained" startIcon={<UpgradeOutlinedIcon />} onClick={() => setOpen(true)}>
        回填供应商单号并升级首版
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>升级旧草稿为首版</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            sx={{ mt: 1 }}
            size="small"
            label="供应商单号（必填）"
            placeholder="如 PO-YY-2610-021"
            value={orderNo}
            onChange={(event) => setOrderNo(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>取消</Button>
          <Button variant="contained" disabled={!orderNo.trim() || state.isLoading} onClick={submit}>升级为修订 1</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
