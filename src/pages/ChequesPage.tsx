import { PlusOutlined, PrinterOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { Button, DatePicker, Input, Select, Space, Table, Tag, Tooltip } from 'antd'
import dayjs from 'dayjs'
import type { Key } from 'react'
import type { ColumnsType } from 'antd/es/table'
import { useCallback, useEffect, useMemo, useState } from 'react'
import ChequeBulkEdit from '../components/ChequeBulkEdit'
import ChequeDetail from '../components/ChequeDetail'
import ChequeEditor from '../components/ChequeEditor'
import ChequeImport from '../components/ChequeImport'
import ReceiptEditor from '../components/ReceiptEditor'
import type { ReceiptPrefill } from '../components/ReceiptEditor'
import { useAuth } from '../lib/auth'
import {
  CHEQUE_ALERT_LABEL,
  CHEQUE_ALERTS,
  CHEQUE_STATUS_COLOR,
  CHEQUE_STATUS_LABEL,
  CHEQUE_STATUSES,
  chequeStatus,
  chequeVehicleIds,
  chequeVins,
  inAlert,
  printDepositForm,
  waitingDeposit,
} from '../lib/cheques'
import type { Cheque, ChequeAlert, ChequeStatus } from '../lib/cheques'
import { colsWidth, pickCol, textCol } from '../lib/colFilter'
import { cleanSearch, money, shortDate, todayAccra, usd } from '../lib/format'
import { useT } from '../lib/i18n'
import { accountOptions, useRefData } from '../lib/refdata'
import { fetchAll, supabase } from '../lib/supabase'

// 支票管理：客户给的（分期）支票一张一行。顶上几个提醒数字点开就是清单；点一行看详情、做操作（存票、对到账、退票…）。
// 读 v_cheques（一次全部读回来，筛选在页面上做，提醒数字按全部算）。写都走数据库函数。

type StatusFilter = 'open' | 'all' | ChequeStatus
const OPEN_STATUSES: string[] = ['pending', 'confirming', 'deposited', 'bounced']

export default function ChequesPage() {
  const t = useT()
  const { canEdit, canView, perm, role } = useAuth()
  /** 录、改、删、导入支票（“支票管理”可编辑）；只看的只能看台账和记录 */
  const chEdit = canEdit('cheques')
  /** 业务员开的是「只看自己的」：数据库只给他自己名下的票，所以业务员那一栏、那个筛选都不用了
   *（开「全部支票」的业务员和财务一样，要看是谁的票） */
  const ownOnly = role === 'sales' && perm('cheques') !== 'all'
  const { accounts, salespersons } = useRefData()
  const [rows, setRows] = useState<Cheque[]>([])
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<StatusFilter>('open')
  const [alert, setAlert] = useState<ChequeAlert | null>(null)
  const [salespersonId, setSalespersonId] = useState<number | undefined>()
  const [accountId, setAccountId] = useState<number | undefined>()
  const [q, setQ] = useState('')
  /** 按到期日期筛（Rome 2026-11-20「这个我可以选到期日期来筛选吗」）：从哪天到哪天，两头都算；没写到期日期的票选了就不出来 */
  const [dueRange, setDueRange] = useState<[dayjs.Dayjs, dayjs.Dayjs] | null>(null)
  const [editor, setEditor] = useState<{ open: boolean; cheque: Cheque | null }>({ open: false, cheque: null })
  const [detailId, setDetailId] = useState<number | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [receipt, setReceipt] = useState<{ open: boolean; id: number | null; prefill: ReceiptPrefill | null }>({ open: false, id: null, prefill: null })
  const [selected, setSelected] = useState<number[]>([])
  /** 批量修改要改的那几张：详情里「改这一批」给的整批；null = 没开 */
  const [bulk, setBulk] = useState<Cheque[] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await fetchAll<Cheque>(() =>
      supabase.from('v_cheques').select('*').order('due_date', { ascending: true, nullsFirst: false }).order('id', { ascending: true }),
    )
    setRows(data)
    // 勾着的票存了、退了、删了（状态变了）就不再算勾着：勾选只用来打印存票审批单，只留还没存的
    const waiting = new Set(data.filter(waitingDeposit).map((c) => c.id as number))
    setSelected((prev) => (prev.every((id) => waiting.has(id)) ? prev : prev.filter((id) => waiting.has(id))))
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 到账那边有变化（审核通过、删除）也会影响支票的到账状态
  useEffect(() => {
    const h = () => void load()
    window.addEventListener('submissions-changed', h)
    return () => window.removeEventListener('submissions-changed', h)
  }, [load])

  const alertCount = useMemo(() => Object.fromEntries(CHEQUE_ALERTS.map((a) => [a, rows.filter((c) => inAlert(c, a)).length])) as Record<ChequeAlert, number>, [rows])

  const shown = useMemo(() => {
    const s = cleanSearch(q).toLowerCase()
    return rows.filter((c) => {
      if (alert) {
        if (!inAlert(c, alert)) return false
      } else if (status === 'open') {
        if (!OPEN_STATUSES.includes(c.status ?? '')) return false
      } else if (status !== 'all' && c.status !== status) return false
      if (salespersonId && c.salesperson_id !== salespersonId) return false
      if (accountId && c.deposit_account_id !== accountId) return false
      if (dueRange) {
        const d = c.due_date ?? ''
        if (!d || d < dueRange[0].format('YYYY-MM-DD') || d > dueRange[1].format('YYYY-MM-DD')) return false
      }
      if (s && !`${c.cheque_no ?? ''} ${c.customer_name ?? ''} ${c.drawer_name ?? ''} ${c.vins ?? c.vin ?? ''} ${c.drawer_bank ?? ''} ${c.contract_no ?? ''}`.toLowerCase().includes(s))
        return false
      return true
    })
  }, [rows, alert, status, salespersonId, accountId, dueRange, q])

  /** 到期日期的快捷选项：本周是周一到周日，本月是 1 号到月底；点的时候才按加纳的今天算（页面开过夜也对） */
  const duePresets = useMemo(() => {
    type Range = [dayjs.Dayjs, dayjs.Dayjs]
    const today = () => dayjs(todayAccra())
    const monday = () => today().subtract((today().day() + 6) % 7, 'day')
    const month = (n: number): Range => {
      const m = today().add(n, 'month')
      return [m.startOf('month'), m.endOf('month')]
    }
    return [
      { label: t('今天'), value: (): Range => [today(), today()] },
      { label: t('明天'), value: (): Range => [today().add(1, 'day'), today().add(1, 'day')] },
      { label: t('本周'), value: (): Range => [monday(), monday().add(6, 'day')] },
      { label: t('下周'), value: (): Range => [monday().add(7, 'day'), monday().add(13, 'day')] },
      { label: t('本月'), value: () => month(0) },
      { label: t('下个月'), value: () => month(1) },
    ]
  }, [t])

  const detail = detailId == null ? null : (rows.find((c) => c.id === detailId) ?? null)

  const createReceipt = (c: Cheque) => {
    const ids = chequeVehicleIds(c)
    const amt = c.amount != null ? Number(c.amount) : null
    const per = amt != null && ids.length ? Math.floor((amt / ids.length) * 100) / 100 : 0
    setReceipt({
      open: true,
      id: null,
      prefill: {
        account_id: c.deposit_account_id ?? undefined,
        receipt_date: c.deposit_date ?? undefined,
        amount_orig: c.amount != null ? Number(c.amount) : undefined,
        cheque_no: c.cheque_no,
        payer_summary: c.drawer_name ?? c.customer_name,
        cheque_id: c.id ?? undefined,
        // 几台车：一台一行，金额先按台数平均分（分不均的分差放第一台），不对就在拆分里改
        claims: ids.length
          ? ids.map((vid, i) => ({
              nature: c.purpose === '配件款' ? '配件款' : c.purpose === '预付款' ? '预付款' : '分期款',
              vehicle_id: vid,
              customer_id: c.customer_id,
              amount_orig: amt == null ? null : i === 0 ? Math.round((amt - per * (ids.length - 1)) * 100) / 100 : per,
            }))
          : c.customer_id
            ? [{ customer_id: c.customer_id, amount_orig: c.amount != null ? Number(c.amount) : null }]
            : [],
      },
    })
  }

  // 勾选只用来打印存票审批单（Rome 2026-11-20「去掉这俩」：台账上的「修改选中」「删除选中」去掉了，
  // 批量修改从详情里的「改这一批」进，删除在详情里一张一张删）。按列表上看得见的选中项算
  /** 存票审批单只放还没存的（待存 / 等业务确认）；别的票勾不上，勾了以后状态变了的重新读的时候就去掉了（load） */
  const toDeposit = shown.filter((c) => selected.includes(c.id as number) && waitingDeposit(c))
  /** 详情里的「改这一批」：同一个客户、同一个合同序号的所有支票（不看当前的筛选，整批都要） */
  const stackOf = (c: Cheque) =>
    c.contract_no ? rows.filter((x) => x.contract_no === c.contract_no && x.customer_id === c.customer_id) : [c]
  const dueCell = (c: Cheque) => {
    if (!c.due_date) return <span className="hint">{t('没写')}</span>
    const d = c.days_to_due
    const open = OPEN_STATUSES.includes(c.status ?? '') && c.status !== 'deposited'
    const cls = !open || d == null ? '' : d < 0 ? 'text-danger' : d <= 7 ? 'text-warn' : ''
    const hint = !open || d == null ? '' : d < 0 ? t('过了 {n} 天', { n: -d }) : d === 0 ? t('今天') : t('还有 {n} 天', { n: d })
    return (
      <span className={cls}>
        {c.due_date}
        {hint && <div className="hint">{hint}</div>}
      </span>
    )
  }

  const columns: ColumnsType<Cheque> = [
    {
      title: t('状态'),
      width: 110,
      render: (_, c) => <Tag color={CHEQUE_STATUS_COLOR[chequeStatus(c.status)]}>{t(CHEQUE_STATUS_LABEL[chequeStatus(c.status)])}</Tag>,
      ...pickCol(rows, (c) => CHEQUE_STATUS_LABEL[chequeStatus(c.status)], t),
    },
    {
      title: t('序号'),
      width: 100,
      render: (_, c) =>
        c.contract_no || c.installment_no ? (
          <span className="num">
            {c.contract_no ?? ''}
            {c.installment_no ? (
              <div className="hint">{t('第 {n}/{m} 期', { n: c.installment_no, m: c.installment_count ?? c.installment_no })}</div>
            ) : null}
          </span>
        ) : (
          ''
        ),
      ...textCol<Cheque>((c) => `${c.contract_no ?? ''} ${c.installment_no ?? ''}`),
    },
    {
      title: t('支票号'),
      width: 130,
      render: (_, c) => (
        <span className="num">
          {c.cheque_no}
          {c.drawer_bank && <div className="hint">{c.drawer_bank}</div>}
        </span>
      ),
      ...textCol<Cheque>((c) => `${c.cheque_no ?? ''} ${c.drawer_bank ?? ''}`),
    },
    {
      title: t('客户'),
      width: 200,
      ellipsis: true,
      render: (_, c) => (
        <span>
          {c.customer_name}
          {c.drawer_name && c.drawer_name !== c.customer_name && <div className="hint">{c.drawer_name}</div>}
        </span>
      ),
      ...textCol<Cheque>((c) => `${c.customer_name ?? ''} ${c.drawer_name ?? ''}`),
    },
    {
      title: t('车'),
      width: 190,
      ellipsis: true,
      render: (_, c) => {
        const vins = chequeVins(c)
        if (!vins.length) return ''
        // 几台车是同一个车型（常见）就只写一次
        const models = [...new Set((c.models ?? c.model ?? '').split(' / ').filter(Boolean))]
        return (
          <Tooltip title={vins.length > 1 ? vins.join('、') : null}>
            <span>
              <span className="cv-vin">{vins[0]}</span>
              {vins.length > 1 && <span className="hint"> {t('等 {n} 台', { n: vins.length })}</span>}
              {models.length > 0 && <div className="hint">{models.join(' / ')}</div>}
            </span>
          </Tooltip>
        )
      },
      ...textCol<Cheque>((c) => `${c.vins ?? c.vin ?? ''} ${c.models ?? c.model ?? ''}`),
    },
    ...(ownOnly ? [] : [{ title: t('业务员'), dataIndex: 'salesperson_name', width: 124, ellipsis: true, ...pickCol(rows, (c: Cheque) => c.salesperson_name) }]),
    { title: t('用途'), dataIndex: 'purpose', width: 90, render: (v: string) => t(v), ...pickCol(rows, (c) => c.purpose, t) },
    {
      title: t('金额'),
      width: 130,
      align: 'right',
      render: (_, c) => <span className="num">{c.amount == null ? <span className="hint">{t('空白')}</span> : `${c.currency} ${money(c.amount)}`}</span>,
      ...textCol<Cheque>((c) => (c.amount == null ? '' : `${c.currency} ${money(c.amount)}`)),
    },
    { title: t('分期款 USD'), dataIndex: 'installment_usd', width: 100, align: 'right', render: (v: number | null) => (v == null ? '' : <span className="num">{usd(v)}</span>) },
    { title: t('到期日期'), width: 110, render: (_, c) => dueCell(c), ...textCol<Cheque>((c) => c.due_date) },
    {
      title: t('存票'),
      width: 190,
      ellipsis: true,
      render: (_, c) =>
        c.deposit_date ? (
          <span>
            {c.deposit_date}
            {c.deposit_account_name && <div className="hint">{c.deposit_account_name}</div>}
          </span>
        ) : c.plan_date ? (
          <span className="hint">{t('计划 {date}', { date: c.plan_date })}</span>
        ) : (
          ''
        ),
      ...pickCol(rows, (c) => c.deposit_account_name),
    },
    {
      title: t('到账'),
      width: 150,
      render: (_, c) =>
        c.receipt_id ? (
          <span>
            {canView('receipts') ? (
              <a
                onClick={(e) => {
                  e.stopPropagation()
                  setReceipt({ open: true, id: c.receipt_id, prefill: null })
                }}
              >
                {c.receipt_no ?? `#${c.receipt_id}`}
              </a>
            ) : (
              (c.receipt_no ?? `#${c.receipt_id}`)
            )}
          </span>
        ) : c.status === 'deposited' && c.days_deposited != null ? (
          <span className={c.days_deposited >= 3 ? 'text-warn' : 'hint'}>{t('存了 {n} 天', { n: c.days_deposited })}</span>
        ) : (
          ''
        ),
      ...textCol<Cheque>((c) => c.receipt_no ?? ''),
    },
    {
      title: t('最近沟通'),
      width: 220,
      ellipsis: true,
      render: (_, c) =>
        c.last_note ? (
          <Tooltip title={c.last_note}>
            <span>
              <span className="hint">{shortDate(c.last_note_at)} </span>
              {c.last_note}
            </span>
          </Tooltip>
        ) : (
          <span className="hint">{c.reason ?? c.note ?? ''}</span>
        ),
      ...textCol<Cheque>((c) => `${c.last_note ?? ''} ${c.reason ?? ''} ${c.note ?? ''}`),
    },
  ]

  const statusOptions = [
    { value: 'open', label: t('还在处理的') },
    { value: 'all', label: t('全部') },
    ...CHEQUE_STATUSES.map((s) => ({ value: s, label: t(CHEQUE_STATUS_LABEL[s]) })),
  ]

  return (
    <div className="cheques-page">
      <Space wrap className="cheque-alerts" style={{ marginBottom: 12 }}>
        {CHEQUE_ALERTS.map((a) => (
          <Button
            key={a}
            className={`cheque-alert cheque-alert-${a}${alert === a ? ' active' : ''}`}
            type={alert === a ? 'primary' : 'default'}
            danger={a === 'overdue' && alertCount[a] > 0 && alert !== a}
            onClick={() => setAlert(alert === a ? null : a)}
          >
            {t(CHEQUE_ALERT_LABEL[a])} <b>{alertCount[a]}</b>
          </Button>
        ))}
      </Space>
      <Space wrap className="filters">
        <Select style={{ width: 150 }} value={alert ? 'all' : status} disabled={!!alert} onChange={(v: StatusFilter) => setStatus(v)} options={statusOptions} />
        {!ownOnly && (
          <Select
            allowClear
            placeholder={t('业务员')}
            style={{ width: 140 }}
            showSearch={{ optionFilterProp: 'label' }}
            value={salespersonId}
            onChange={setSalespersonId}
            options={salespersons.map((s) => ({ value: s.id, label: s.name }))}
          />
        )}
        <Select
          allowClear
          placeholder={t('存票账户')}
          style={{ width: 220 }}
          showSearch={{ optionFilterProp: 'label' }}
          options={accountOptions(accounts, false)}
          value={accountId}
          onChange={setAccountId}
        />
        <DatePicker.RangePicker
          className="cheque-due-range"
          allowClear
          placeholder={[t('到期日期从'), t('到期日期到')]}
          style={{ width: 270 }}
          value={dueRange}
          onChange={(v) => setDueRange(v && v[0] && v[1] ? [v[0], v[1]] : null)}
          presets={duePresets}
          classNames={{ popup: { root: 'cheque-due-popup' } }}
        />
        <Input.Search allowClear placeholder={t('支票号、客户、户名、大架号、合同序号')} style={{ width: 240 }} onSearch={setQ} />
        <Button icon={<ReloadOutlined />} onClick={() => void load()} />
        {chEdit && toDeposit.length > 0 && (
          <Button icon={<PrinterOutlined />} onClick={() => printDepositForm(toDeposit.map((c) => c.id as number))} className="cheque-deposit-print">
            {t('打印存票审批单（{n} 张）', { n: toDeposit.length })}
          </Button>
        )}
        {chEdit && (
          <>
            <Button icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>
              {t('导入表格')}
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditor({ open: true, cheque: null })}>
              {t('录支票')}
            </Button>
          </>
        )}
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={shown}
        scroll={{ x: colsWidth(columns, chEdit ? 40 : 0) }}
        pagination={{ defaultPageSize: 50, showSizeChanger: true, showTotal: (n) => t('共 {n} 张支票', { n }) }}
        rowClassName={() => 'clickable-row'}
        onRow={(c) => ({ onClick: (e) => !(e.target as HTMLElement).closest('.ant-table-selection-column') && setDetailId(c.id) })}
        rowSelection={
          chEdit
            ? {
                selectedRowKeys: selected,
                onChange: (keys: Key[]) => setSelected(keys as number[]),
                selections: [Table.SELECTION_ALL, Table.SELECTION_NONE],
                // 只有还没存的（待存 / 等业务确认）能进存票审批单，别的票勾不上（全选也只勾这些）
                getCheckboxProps: (c: Cheque) => ({ disabled: !waitingDeposit(c) }),
                columnWidth: 40,
                fixed: true,
              }
            : undefined
        }
      />
      <ChequeBulkEdit
        open={bulk != null}
        cheques={bulk ?? []}
        onClose={(changed) => {
          setBulk(null)
          if (changed) {
            setSelected([])
            void load()
          }
        }}
      />
      <ChequeEditor
        open={editor.open}
        cheque={editor.cheque}
        onClose={(changed) => {
          setEditor({ open: false, cheque: null })
          if (changed) void load()
        }}
      />
      <ChequeDetail
        open={detailId != null}
        cheque={detail}
        onClose={() => setDetailId(null)}
        onChanged={() => void load()}
        onEdit={(c) => setEditor({ open: true, cheque: c })}
        onBulkEdit={(c) => setBulk(stackOf(c))}
        stackCount={detail ? stackOf(detail).length : 0}
        onCreateReceipt={createReceipt}
        onOpenReceipt={(id) => setReceipt({ open: true, id, prefill: null })}
      />
      <ChequeImport
        open={importOpen}
        onClose={(changed) => {
          setImportOpen(false)
          if (changed) void load()
        }}
      />
      <ReceiptEditor
        open={receipt.open}
        receiptId={receipt.id}
        prefill={receipt.prefill}
        onClose={(changed) => {
          setReceipt({ open: false, id: null, prefill: null })
          if (changed) void load()
        }}
      />
    </div>
  )
}
