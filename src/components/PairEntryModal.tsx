import { Alert, App, Modal, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { errorText } from '../lib/errors'
import { money } from '../lib/format'
import { useT } from '../lib/i18n'
import { moduleColor, notifyJournalChanged } from '../lib/journal'
import type { JournalLine } from '../lib/journal'
import { fetchWaiting } from '../lib/journalPair'
import type { PairLine } from '../lib/journalPair'
import { supabase } from '../lib/supabase'

// 「对上已记的」（数据库 40）：一条待填的银行流水，对上这个账户里已经记了、还在“等流水”的那一笔。
// 自动配对分不清（同一天同金额好几笔）、隔得太久（支票晚兑）、号码没写的时候用。
// 先记的收付走 pair_line_entry；流水里还没有的到账照「关联已录的」那样配（要能改“银行对账”）。
// 只有同方向、同金额的能选：金额不一样的先打开那一笔改金额（或者到账走银行对账里的「关联已录的」补填差额）。

const amtOf = (r: JournalLine) => Number(r.amount_in ?? r.amount_out ?? 0)

export default function PairEntryModal({ line, onClose }: { line: PairLine | null; onClose: (changed: boolean) => void }) {
  const t = useT()
  const { message } = App.useApp()
  const { canEdit } = useAuth()
  const rcEdit = canEdit('reconcile')
  const jEdit = canEdit('journal')
  const [rows, setRows] = useState<JournalLine[]>([])
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // 换了一条流水：先清掉上一条的（渲染时就清，不等读回来）
  const [shownFor, setShownFor] = useState<PairLine | null>(null)
  if (line !== shownFor) {
    setShownFor(line)
    setRows([])
    setPicked(null)
    setLoading(!!line)
  }

  useEffect(() => {
    if (!line) return
    let alive = true
    void fetchWaiting(line.account_id, line.amount > 0 ? 1 : -1).then(({ rows: list, error }) => {
      if (!alive) return
      if (error) message.error(errorText(error))
      const amt = Math.abs(line.amount)
      const d = dayjs(line.entry_date)
      const score = (r: JournalLine) => [Math.abs(amtOf(r) - amt) < 0.005 ? 0 : 1, Math.abs(dayjs(r.entry_date).diff(d, 'day'))]
      // 同金额的排最前，再按日期远近
      list.sort((a, b) => {
        const [x1, y1] = score(a)
        const [x2, y2] = score(b)
        return x1 - x2 || y1 - y2
      })
      setRows(list)
      // 只有一笔同金额的：先选上
      const same = list.filter((r) => Math.abs(amtOf(r) - amt) < 0.005 && (r.source === 'entry' ? jEdit : rcEdit))
      setPicked(same.length === 1 ? (same[0].key ?? null) : null)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [line, rcEdit, jEdit, message])

  /** 这一笔能不能选：同金额；收支要能改“银行日记账”，到账要能改“银行对账” */
  const why = (r: JournalLine): string | null => {
    if (!line) return null
    if (Math.abs(amtOf(r) - Math.abs(line.amount)) >= 0.005) return t('金额不一样')
    if (r.source === 'receipt' && !rcEdit) return t('配到账要有“银行对账”的编辑权限')
    if (r.source !== 'receipt' && !jEdit) return t('对上收支要有“银行日记账”的编辑权限')
    return null
  }
  const pickedRow = useMemo(() => rows.find((r) => r.key === picked) ?? null, [rows, picked])

  const pair = async () => {
    if (!line || !pickedRow) return
    setSaving(true)
    const { error } =
      pickedRow.source === 'entry'
        ? await supabase.rpc('pair_line_entry', { p_line_id: line.line_id, p_entry_id: pickedRow.source_id as number })
        : await supabase
            .from('bank_statement_lines')
            .update({ receipt_id: pickedRow.source_id as number, match_type: 'manual' })
            .eq('id', line.line_id)
    setSaving(false)
    if (error) {
      message.error(errorText(error))
      // 流水刚被别人填了、那一笔刚对上别的：关掉，列表重读
      if (/请刷新/.test(error.message)) {
        notifyJournalChanged()
        onClose(true)
      }
      return
    }
    message.success(t('已对上 {no}', { no: pickedRow.doc_no ?? '' }))
    notifyJournalChanged()
    onClose(true)
  }

  // 摘要、对方不截断：要对着银行摘要认是哪一笔
  const columns: ColumnsType<JournalLine> = [
    {
      title: t('日期 / 单号'),
      width: 150,
      render: (_, r) => (
        <>
          <div className="num">{r.entry_date}</div>
          <div className="num doc-no">{r.doc_no}</div>
        </>
      ),
    },
    {
      title: t('业务模块'),
      dataIndex: 'module',
      width: 110,
      render: (v: string | null) => (v ? <Tag color={moduleColor(v)}>{t(v)}</Tag> : null),
    },
    { title: t('客户 / 供应商'), dataIndex: 'counterparty', width: 160 },
    { title: t('摘要'), dataIndex: 'summary' },
    {
      title: t('金额'),
      width: 130,
      align: 'right',
      render: (_, r) => {
        const off = why(r)
        return (
          <span className={off ? 'num hint' : 'num'}>
            {money(amtOf(r))}
            {off && <div className="hint">{off}</div>}
          </span>
        )
      },
    },
    { title: t('记的人'), dataIndex: 'created_by_name', width: 84 },
  ]

  return (
    <Modal
      open={!!line}
      title={t('对上已记的')}
      okText={t('对上')}
      okButtonProps={{ disabled: !pickedRow, loading: saving }}
      onOk={() => void pair()}
      onCancel={() => onClose(false)}
      width={1000}
      destroyOnHidden
      className="pair-entry-modal"
    >
      {line && (
        <Typography.Paragraph>
          {t('银行流水：')}
          <span className="num">{line.entry_date}</span> · {line.bank_summary || '—'} ·{' '}
          <b className="num">
            {line.amount < 0 ? '−' : ''}
            {line.currency} {money(Math.abs(line.amount))}
          </b>
        </Typography.Paragraph>
      )}
      <Alert
        type="info"
        showIcon
        className="filters"
        title={t('这里列的是这个账户已经记了、银行流水里还没有的（等流水），选是哪一笔。只有金额一样的能对上；金额不一样的先打开那一笔改金额。')}
      />
      <Table
        rowKey={(r) => r.key ?? `${r.source}-${r.source_id}`}
        size="small"
        loading={loading}
        dataSource={rows}
        columns={columns}
        pagination={false}
        scroll={{ x: 760, y: 360 }}
        rowSelection={{
          type: 'radio',
          selectedRowKeys: picked ? [picked] : [],
          onChange: (keys) => setPicked(String(keys[0])),
          getCheckboxProps: (r) => ({ disabled: !!why(r) }),
        }}
        onRow={(r) => ({ onClick: () => !why(r) && setPicked(r.key ?? null) })}
        locale={{ emptyText: t('这个账户没有等流水的（先记的收付、流水里还没有的到账）') }}
      />
    </Modal>
  )
}
