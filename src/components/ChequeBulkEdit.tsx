import { Alert, App, Checkbox, DatePicker, Input, InputNumber, Modal, Radio, Select, Space, Table, Typography } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import type { Json } from '../lib/database.types'
import { CHEQUE_PURPOSES, CHEQUE_STATUS_LABEL, chequeStatus, notifyChequesChanged } from '../lib/cheques'
import type { Cheque } from '../lib/cheques'
import { errorText } from '../lib/errors'
import { useT } from '../lib/i18n'
import { useRefData } from '../lib/refdata'
import { supabase } from '../lib/supabase'
import type { Vehicle } from '../lib/supabase'
import CustomerSelect from './CustomerSelect'
import { VehicleMultiSelect } from './VehicleSelect'

// 批量修改支票（Rome 2026-11-18「我需要能按序号批量编辑支票」）：
// 在台账上按「序号」搜出一个合同的几张票、全选，然后这里勾要改的项，一次全改。
// 没勾的项每张票保留自己原来的值（数据库的 save_cheques 是整行覆盖，所以这里把每张票现在的值一起带上）。
// 到期日期、第几期这两项按「这一叠的顺序」排：到期日早的在前，没写日期的排最后，同一天按支票号。

/** 支票号里的数字（排序用） */
const noNum = (s: string | null) => {
  const d = (s ?? '').replace(/\D/g, '')
  return d ? Number(d) : Number.MAX_SAFE_INTEGER
}
const ordered = (list: Cheque[]) =>
  [...list].sort(
    (a, b) =>
      (a.due_date ?? '9999-12-31').localeCompare(b.due_date ?? '9999-12-31') ||
      noNum(a.cheque_no) - noNum(b.cheque_no) ||
      (a.id ?? 0) - (b.id ?? 0),
  )

/** 能批量改的项 */
type FieldKey =
  | 'customer'
  | 'cars'
  | 'salesperson'
  | 'drawer_bank'
  | 'drawer_name'
  | 'purpose'
  | 'amount'
  | 'installment_usd'
  | 'due_date'
  | 'contract_no'
  | 'installment_no'
  | 'installment_count'
  | 'note'

type Values = {
  customer_id: number | null
  vehicle_ids: number[]
  salesperson_id: number | null
  drawer_bank: string | null
  drawer_name: string
  purpose: string
  currency: 'GHS' | 'USD'
  amount: number | null
  installment_usd: number | null
  due_date: dayjs.Dayjs | null
  /** 到期日期怎么改：每张都这一天，还是从这一天起每月一张 */
  due_mode: 'same' | 'monthly'
  contract_no: string
  installment_no: number
  installment_count: number | null
  note: string
}

const EMPTY: Values = {
  customer_id: null,
  vehicle_ids: [],
  salesperson_id: null,
  drawer_bank: null,
  drawer_name: '',
  purpose: '分期款',
  currency: 'GHS',
  amount: null,
  installment_usd: null,
  due_date: null,
  due_mode: 'monthly',
  contract_no: '',
  installment_no: 1,
  installment_count: null,
  note: '',
}

export default function ChequeBulkEdit({ open, cheques, onClose }: { open: boolean; cheques: Cheque[]; onClose: (changed: boolean) => void }) {
  const t = useT()
  const { message } = App.useApp()
  const { salespersons, chequeBanks } = useRefData()
  const [on, setOn] = useState<Partial<Record<FieldKey, boolean>>>({})
  const [v, setV] = useState<Values>(EMPTY)
  const [known, setKnown] = useState<Vehicle[]>([])
  const [saving, setSaving] = useState(false)

  const list = useMemo(() => ordered(cheques), [cheques])
  // 这几张票是不是同一个客户的（改「车」要知道是谁的车）
  const customers = new Set(list.map((c) => c.customer_id).filter((x) => x != null))
  const oneCustomer = customers.size === 1 ? (list[0]?.customer_id ?? null) : null
  const cleared = list.filter((c) => c.status === 'cleared')

  useEffect(() => {
    if (!open) return
    setOn({})
    setV({ ...EMPTY, customer_id: oneCustomer, installment_count: list.length })
    setKnown([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 选了客户以后，把他名下的车先捞一批当下拉的候选
  const carCustomer = on.customer ? v.customer_id : oneCustomer
  useEffect(() => {
    if (!open || !on.cars || carCustomer == null) return
    void supabase
      .from('v_vehicle_ledger')
      .select('*')
      .eq('customer_id', carCustomer)
      .limit(500)
      .then((r) => setKnown(r.data ?? []))
  }, [open, on.cars, carCustomer])

  const bankOptions = chequeBanks.filter((b) => b.active).map((b) => ({ value: b.name, label: b.name }))
  const spOptions = salespersons.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))
  const tick = (k: FieldKey) => (e: { target: { checked: boolean } }) => setOn((o) => ({ ...o, [k]: e.target.checked }))

  /** 第 i 张（按这一叠的顺序）的到期日期 */
  const dueOf = (i: number) => {
    if (!v.due_date) return null
    const d = v.due_mode === 'monthly' ? v.due_date.add(i, 'month') : v.due_date
    return d.format('YYYY-MM-DD')
  }

  const chosenFields = (Object.keys(on) as FieldKey[]).filter((k) => on[k])

  const save = async () => {
    if (!chosenFields.length) {
      message.warning(t('先勾要改的项'))
      return
    }
    if (on.customer && v.customer_id == null) {
      message.error(t('请选客户'))
      return
    }
    if (on.cars && carCustomer == null) {
      message.error(t('这几张票不是同一个客户的，要改车请连客户一起勾上'))
      return
    }
    if (on.due_date && !v.due_date) {
      message.error(t('请选到期日期'))
      return
    }
    const rows = list.map((c, i) => ({
      id: c.id,
      updated_at: c.updated_at,
      cheque_no: c.cheque_no,
      customer_id: on.customer ? v.customer_id : c.customer_id,
      vehicle_ids: on.cars ? v.vehicle_ids : (c.vehicle_ids ?? (c.vehicle_id != null ? [c.vehicle_id] : [])),
      salesperson_id: on.salesperson ? v.salesperson_id : c.salesperson_id,
      drawer_name: on.drawer_name ? v.drawer_name.trim() || null : c.drawer_name,
      drawer_bank: on.drawer_bank ? v.drawer_bank || null : c.drawer_bank,
      currency: on.amount ? v.currency : (c.currency ?? 'GHS'),
      amount: on.amount ? v.amount : c.amount != null ? Number(c.amount) : null,
      installment_usd: on.installment_usd ? v.installment_usd : c.installment_usd != null ? Number(c.installment_usd) : null,
      due_date: on.due_date ? dueOf(i) : c.due_date,
      purpose: on.purpose ? v.purpose : (c.purpose ?? '分期款'),
      contract_no: on.contract_no ? v.contract_no.trim() || null : c.contract_no,
      installment_no: on.installment_no ? v.installment_no + i : c.installment_no,
      installment_count: on.installment_count ? v.installment_count : c.installment_count,
      note: on.note ? v.note.trim() || null : c.note,
    }))
    setSaving(true)
    const { error } = await supabase.rpc('save_cheques', { p_rows: rows as unknown as Json })
    setSaving(false)
    if (error) {
      message.error(errorText(error))
      return
    }
    message.success(t('已改 {n} 张支票', { n: rows.length }))
    notifyChequesChanged()
    onClose(true)
  }

  /** 一行：勾 + 标题 + 控件 */
  const line = (k: FieldKey, label: string, control: React.ReactNode, hint?: string, disabled?: boolean) => ({
    key: k,
    label,
    hint,
    disabled,
    control,
  })

  const fields = [
    line(
      'customer',
      t('客户'),
      <CustomerSelect value={v.customer_id} onChange={(id) => setV((x) => ({ ...x, customer_id: id, vehicle_ids: [] }))} style={{ width: '100%' }} />,
    ),
    line(
      'cars',
      t('哪几台车的'),
      <VehicleMultiSelect
        value={v.vehicle_ids}
        known={known}
        onChange={(ids) => setV((x) => ({ ...x, vehicle_ids: ids }))}
        placeholder={carCustomer == null ? t('先选客户') : t('搜大架号')}
        style={{ width: '100%' }}
        disabled={carCustomer == null}
      />,
      t('选中的每张票都改成这几台（整单几台车的分期票就是这样）'),
    ),
    line(
      'salesperson',
      t('业务员'),
      <Select
        allowClear
        showSearch={{ optionFilterProp: 'label' }}
        options={spOptions}
        value={v.salesperson_id}
        onChange={(id) => setV((x) => ({ ...x, salesperson_id: id ?? null }))}
        style={{ width: '100%' }}
        placeholder={t('选业务员')}
      />,
    ),
    line(
      'drawer_bank',
      t('支票银行'),
      <Select
        showSearch
        allowClear
        options={bankOptions}
        optionFilterProp="value"
        filterOption={(q, o) => (o?.value as string).includes(q.toUpperCase())}
        value={v.drawer_bank}
        onChange={(b) => setV((x) => ({ ...x, drawer_bank: b ?? null }))}
        style={{ width: '100%' }}
        placeholder={t('选银行')}
      />,
    ),
    line('drawer_name', t('支票名称'), <Input maxLength={120} value={v.drawer_name} onChange={(e) => setV((x) => ({ ...x, drawer_name: e.target.value }))} />),
    line(
      'purpose',
      t('用途'),
      <Select
        options={CHEQUE_PURPOSES.map((p) => ({ value: p, label: t(p) }))}
        value={v.purpose}
        onChange={(p) => setV((x) => ({ ...x, purpose: p }))}
        style={{ width: '100%' }}
      />,
    ),
    line(
      'amount',
      t('币种和金额'),
      <Space.Compact style={{ width: '100%' }}>
        <Select
          options={[
            { value: 'GHS', label: 'GHS' },
            { value: 'USD', label: 'USD' },
          ]}
          value={v.currency}
          onChange={(c) => setV((x) => ({ ...x, currency: c }))}
          style={{ width: 90 }}
          disabled={cleared.length > 0}
        />
        <InputNumber
          min={0.01}
          precision={2}
          placeholder={t('空白')}
          value={v.amount}
          onChange={(n) => setV((x) => ({ ...x, amount: n ?? null }))}
          style={{ width: '100%' }}
          disabled={cleared.length > 0}
        />
      </Space.Compact>,
      cleared.length > 0
        ? t('选中的里有 {n} 张已到账的（{list}），金额、币种按到账为准，改不了', {
            n: cleared.length,
            list: cleared.slice(0, 3).map((c) => c.cheque_no).join('、'),
          })
        : t('每张都改成这个数；空着就是空白支票'),
      cleared.length > 0,
    ),
    line(
      'installment_usd',
      t('分期款/月 USD'),
      <InputNumber
        min={0.01}
        precision={2}
        value={v.installment_usd}
        onChange={(n) => setV((x) => ({ ...x, installment_usd: n ?? null }))}
        style={{ width: '100%' }}
      />,
    ),
    line(
      'due_date',
      t('到期日期'),
      <Space wrap>
        <DatePicker value={v.due_date} onChange={(d) => setV((x) => ({ ...x, due_date: d }))} />
        <Radio.Group
          size="small"
          optionType="button"
          value={v.due_mode}
          onChange={(e) => setV((x) => ({ ...x, due_mode: e.target.value as 'same' | 'monthly' }))}
          options={[
            { value: 'monthly', label: t('从这天起每月一张') },
            { value: 'same', label: t('都是这一天') },
          ]}
        />
      </Space>,
      v.due_mode === 'monthly' ? t('按下面的顺序一张一个月往后排') : undefined,
    ),
    line(
      'contract_no',
      t('合同序号'),
      <Input maxLength={30} value={v.contract_no} onChange={(e) => setV((x) => ({ ...x, contract_no: e.target.value }))} placeholder={t('清空就是去掉序号')} />,
    ),
    line(
      'installment_no',
      t('第几期'),
      <InputNumber
        min={1}
        max={120}
        precision={0}
        value={v.installment_no}
        onChange={(n) => setV((x) => ({ ...x, installment_no: n ?? 1 }))}
        style={{ width: '100%' }}
      />,
      t('按下面的顺序重排：填 1 就是第 1、2、3……期'),
    ),
    line(
      'installment_count',
      t('共几期'),
      <InputNumber
        min={1}
        max={120}
        precision={0}
        value={v.installment_count}
        onChange={(n) => setV((x) => ({ ...x, installment_count: n ?? null }))}
        style={{ width: '100%' }}
        placeholder={t('可不填')}
      />,
      t('选中的是 {n} 张', { n: list.length }),
    ),
    line('note', t('备注'), <Input maxLength={300} value={v.note} onChange={(e) => setV((x) => ({ ...x, note: e.target.value }))} placeholder={t('清空就是去掉备注')} />),
  ]

  return (
    <Modal
      open={open}
      title={t('批量修改 {n} 张支票', { n: list.length })}
      okText={t('保存')}
      cancelText={t('取消')}
      confirmLoading={saving}
      onOk={() => void save()}
      onCancel={() => onClose(false)}
      width={820}
      destroyOnHidden
      className="cheque-bulk-edit"
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title={t('勾上的项才改，没勾的每张票保留自己原来的。')}
        description={t('按序号改一叠：先在台账「序号」那一列搜合同序号，再点表头的勾全选，然后到这里改。')}
      />
      <Table
        rowKey="key"
        size="small"
        pagination={false}
        dataSource={fields}
        showHeader={false}
        className="bulk-fields"
        columns={[
          {
            width: 150,
            render: (_, f) => (
              <Checkbox checked={!!on[f.key]} onChange={tick(f.key)} disabled={f.disabled}>
                {f.label}
              </Checkbox>
            ),
          },
          {
            render: (_, f) => (
              <div className={on[f.key] ? '' : 'bulk-off'}>
                {f.control}
                {f.hint && <div className="hint">{f.hint}</div>}
              </div>
            ),
          },
        ]}
      />
      <div style={{ marginTop: 12 }}>
        <Typography.Text strong>{t('这 {n} 张（按顺序）', { n: list.length })}</Typography.Text>
        <div className="hint bulk-list">
          {list.map((c, i) => (
            <span key={c.id}>
              {i + 1}. {c.cheque_no}
              {c.due_date ? ` ${c.due_date}` : ''}
              {on.due_date && v.due_date ? ` → ${dueOf(i)}` : ''}
              {on.installment_no ? t('（第 {n} 期）', { n: v.installment_no + i }) : ''}
              {c.status !== 'pending' ? `（${t(CHEQUE_STATUS_LABEL[chequeStatus(c.status)])}）` : ''}
            </span>
          ))}
        </div>
      </div>
    </Modal>
  )
}
