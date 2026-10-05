import { Box, Button, Chip, LinearProgress, Stack, Typography } from '@mui/material'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'
import { useNavigate } from 'react-router-dom'
import { useAppSelector } from '../app/hooks'

export default function OverviewPage() {
  const samples = useAppSelector((state) => state.development.samples)
  const navigate = useNavigate()
  const pendingProposals = samples.reduce((sum, item) => sum + item.proposals.filter((proposal) => proposal.status === '待决定').length, 0)
  const pendingAnnotations = samples.reduce((sum, item) => sum + item.annotations.filter((annotation) => annotation.status === '待处理').length, 0)
  const averagePass = Math.round(
    (samples.reduce((sum, sample) => {
      const measurements = sample.measurements['第三轮']
      const passed = measurements.filter((item) => Math.abs(item.actual - item.spec) <= item.tolerance).length
      return sum + passed / measurements.length
    }, 0) /
      samples.length) *
      100,
  )

  return (
    <Box className="page">
      <Box className="page-head">
        <Box>
          <Typography className="eyebrow">PRODUCT DEVELOPMENT / 产品开发</Typography>
          <Typography component="h1" fontWeight={800}>打样轮次总览</Typography>
          <Typography color="text.secondary">关注超差、待决方案与审核节奏，所有数据来自本地 MSW 服务。</Typography>
        </Box>
        <Button variant="contained" onClick={() => navigate('/review')}>进入样衣评审</Button>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', lg: 'repeat(4,1fr)' }, gap: 1.5, mb: 2 }}>
        {[
          ['在开发款式', samples.length, '2 家供应商协同'],
          ['尺寸达标率', `${averagePass}%`, '第三轮综合结果'],
          ['待决定改版', pendingProposals, '需负责人采纳'],
          ['未关闭批注', pendingAnnotations, '包含尺寸与工艺'],
        ].map(([label, value, hint]) => (
          <Box className="panel" key={String(label)} sx={{ p: 2 }}>
            <Typography color="#756f69" fontSize={12}>{label}</Typography>
            <Typography fontSize={{ xs: 26, md: 32 }} fontWeight={850} mt={0.8} color="#203634">{value}</Typography>
            <Typography color="#89837e" fontSize={11}>{hint}</Typography>
          </Box>
        ))}
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: '1.25fr .75fr' }, gap: 1.5 }}>
        <Box className="panel">
          <Box sx={{ p: 1.8, borderBottom: '1px solid #ece9e4', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography fontWeight={800}>近期待办款式</Typography>
            <Button size="small" endIcon={<ArrowForwardIcon />} onClick={() => navigate('/styles')}>全部档案</Button>
          </Box>
          {samples.map((sample) => {
            const pending = sample.proposals.filter((item) => item.status === '待决定').length + sample.annotations.filter((item) => item.status === '待处理').length
            const third = sample.measurements['第三轮']
            const passed = third.filter((item) => Math.abs(item.actual - item.spec) <= item.tolerance).length
            return (
              <Box key={sample.id} sx={{ p: 2, borderBottom: '1px solid #efede9', display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr auto' }, gap: 1.5 }}>
                <Box>
                  <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
                    <Typography fontWeight={800}>{sample.styleCode} · {sample.styleName}</Typography>
                    <Chip size="small" label={sample.status} color={sample.status === '已锁定' ? 'success' : sample.status === '待审核' ? 'warning' : 'default'} />
                  </Stack>
                  <Typography color="text.secondary" fontSize={12} mt={0.8}>{sample.fabric} · {sample.colorway} · 交样 {sample.dueDate}</Typography>
                  <LinearProgress variant="determinate" value={(passed / third.length) * 100} sx={{ mt: 1.5, maxWidth: 380, height: 6, borderRadius: 8 }} />
                </Box>
                <Box sx={{ alignSelf: 'center', textAlign: { sm: 'right' } }}>
                  <Typography color={pending ? '#ad552d' : '#43856a'} fontWeight={800}>{pending ? `${pending} 项待处理` : '无待办'}</Typography>
                  <Typography color="text.secondary" fontSize={11}>负责人 {sample.owner}</Typography>
                  <Button
                    size="small"
                    sx={{ mt: 0.8 }}
                    onClick={() => {
                      navigate('/review')
                    }}
                  >
                    查看轮次
                  </Button>
                </Box>
              </Box>
            )
          })}
        </Box>

        <Box className="panel" sx={{ p: 2 }}>
          <Typography fontWeight={800} mb={1.5}>本周节点</Typography>
          <Stack spacing={1.4}>
            {[
              ['10-01', '第三轮样衣到达', '仓库收样并完成外观拍照'],
              ['10-08', '试穿评审会', '产品、版师、品类负责人'],
              ['10-12', 'WR-26AW-018 定版', '锁定尺寸与工艺包'],
              ['10-18', 'WR-26AW-021 供应商截止', '门襟定位模板确认'],
            ].map(([date, title, desc], index) => (
              <Box key={title} sx={{ display: 'grid', gridTemplateColumns: '52px 1fr', gap: 1.2, position: 'relative' }}>
                <Typography color="#27756c" fontWeight={800} fontSize={12} fontFamily="monospace">{date}</Typography>
                <Box sx={{ borderLeft: index === 0 ? '3px solid #d47b3d' : '3px solid #dce4e1', pl: 1.2, pb: 1.2 }}>
                  <Typography fontWeight={750} fontSize={13}>{title}</Typography>
                  <Typography color="text.secondary" fontSize={11} mt={0.3}>{desc}</Typography>
                </Box>
              </Box>
            ))}
          </Stack>
        </Box>
      </Box>
    </Box>
  )
}
