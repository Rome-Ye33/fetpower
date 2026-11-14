import { Drawer, Table, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { RECEIPT_STATUS_COLOR, RECEIPT_STATUS_LABEL, receiptStatus } from '../lib/flow'
import { pickCol } from '../lib/colFilter'
import { money, num, usd } from '../lib/format'
import { useT } from '../lib/i18n'
import { supabase } from '../lib/supabase'
import type { Claim } from '../lib/supabase'
import { UNLOCKED_KINDS, UNLOCKED_LIVE } from '../lib/unlocked'

/**
 * 业务员“提交到账”上的“查看”：自己名下还没定是哪台车的到账（大架号未锁定）。
 * 只放到账这边，车辆台账只放定了车的（Rome 2026-11-14）。财务在到账录入里按“大架号未锁定”筛。
 */
export default function UnlockedDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const [rows, setRows] = useState<Claim[]>([])
  const [loading, setLoading] = useState(false)
  /** 列头筛选后表里实际显示的行（合计按它算） */
  const [shown, setShown] = useState<Claim[] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('v_receipt_claims')
      .select('*')
      .is('vehicle_id', null)
      .in('nature_kind', UNLOCKED_KINDS)
      .or(UNLOCKED_LIVE)
      .order('claim_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(2000)
    setRows(data ?? [])
    setShown(null)
    setLoading(false)
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  // 合计只算已生效的（审批中的还不算到账）
  const total = (shown ?? rows).filter((r) => receiptStatus(r.receipt_status) === 'approved').reduce((s, r) => s + num(r.amount_usd), 0)

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size={Math.min(1000, typeof window !== 'undefined' ? window.innerWidth : 1000)}
      title={t('大架号未锁定的到账')}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        {t('这些到账记在客户名下，但还没定是哪台车，不算进任何一台车的回款（审批中的也列在这里）。知道是哪台车后请告诉财务。')}
      </Typography.Paragraph>
      <Table
        rowKey={(r) => r.id as number}
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={{ defaultPageSize: 50, showTotal: (n) => t('共 {n} 笔', { n }) }}
        scroll={{ x: 900 }}
        onChange={(_, __, ___, extra) => setShown(extra.currentDataSource)}
        columns={[
          { title: t('日期'), dataIndex: 'claim_date', width: 100 },
          {
            title: t('审批'),
            width: 90,
            // 期初不挂到账，算已生效
            render: (_, c) => <Tag color={RECEIPT_STATUS_COLOR[receiptStatus(c.receipt_status)]}>{t(RECEIPT_STATUS_LABEL[receiptStatus(c.receipt_status)])}</Tag>,
            ...pickCol(rows, (c) => RECEIPT_STATUS_LABEL[receiptStatus(c.receipt_status)], t),
          },
          { title: t('客户'), dataIndex: 'customer_name', width: 180, ellipsis: true, ...pickCol(rows, (c) => c.customer_name) },
          { title: t('数量与设备型号'), dataIndex: 'model_desc', ellipsis: true },
          { title: t('性质'), dataIndex: 'nature', width: 90, render: (x: string) => t(x) },
          {
            title: t('金额'),
            width: 140,
            align: 'right',
            render: (_, c) => (c.receipt_id ? <span className="num">{`${c.currency} ${money(c.amount_orig)}`}</span> : ''),
          },
          { title: 'USD', dataIndex: 'amount_usd', width: 100, align: 'right', render: (x) => <span className="num">{usd(x)}</span> },
          { title: t('到账编号'), dataIndex: 'receipt_no', width: 150, render: (no: string | null) => no ?? '—' },
        ]}
        summary={() =>
          rows.length ? (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={6}>
                {t('已生效合计')}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={6} align="right">
                <span className="num">{usd(total)}</span>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={7} />
            </Table.Summary.Row>
          ) : null
        }
      />
    </Drawer>
  )
}
