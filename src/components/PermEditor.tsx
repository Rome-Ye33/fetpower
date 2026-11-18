import { Alert, App, Button, Modal, Radio, Space, Table, Tag, Typography } from 'antd'
import { useState } from 'react'
import { asDuty, PERM_LEVELS, PERM_MODULES, permOf, SALES_LEVELS, SALES_MODULES, storedPerms, storedSalesPerms } from '../lib/perms'
import type { Duty, PermLevel, PermModule, Perms } from '../lib/perms'
import type { Json } from '../lib/database.types'
import { errorText } from '../lib/errors'
import { useT } from '../lib/i18n'
import { supabase } from '../lib/supabase'
import type { AppRole } from '../lib/supabase'

// 财务的模块权限（数据库 31）：每个财务账号（邀请名单上还没注册的也行）、每个模块一档 不可见 / 只看 / 可编辑。
// 管理员永远全部可编辑。业务员这里只有一项「支票管理」，三档：不可见 / 只看自己的 / 全部支票
//（Rome 2026-11-18「设置一些业务员能看到支票表」「我需要某些业务员能看所有的支票」），两档都只能看。
// 「只看自己的」数据库本来就只给他自己名下的票；「全部支票」靠数据库 44 的 private.sees_all_cheques()。
// 还有银行流水分工（数据库 36）：填收款 / 填付款 / 都填，和模块权限一起存。

/** 每个模块“可编辑”能做什么（只看 = 能打开看，这些都做不了） */
const MODULE_HINT: Record<PermModule, string> = {
  receipts: '录到账、拆分、审核业务员提交、请业务员填写',
  journal: '填银行流水（付款、其他收入、互转、一起填），设银行账户的期初余额',
  cash: '记现金支出、其他收入、账户互转，设现金账户的期初余额',
  cheques: '录支票、存票、退票、导入表格',
  vehicles: '新增、修改、导入车辆，录期初、优惠折让',
  commission: '替业务员开提成单、修改、标记发放',
  reconcile: '导入银行流水、配对、忽略',
  base: '客户、汇率（业务员、收款账户、款项性质只有管理员能改）',
}

const LEVEL_COLOR: Record<PermLevel, string> = { none: 'default', view: 'default', edit: 'blue', all: 'default' }

/** 表格里的一格：这个人现在的模块权限（和银行流水分工） */
export function PermSummary({ role, perms, duty }: { role: AppRole | null; perms: Json | null; duty?: string | null }) {
  const t = useT()
  if (role === 'admin') return <span className="hint">{t('管理员：全部可编辑')}</span>
  if (role === 'sales') {
    const on = SALES_MODULES.map((m) => ({ m, level: permOf('sales', perms, m) })).filter((x) => x.level !== 'none')
    if (!on.length) return <span className="hint">{t('只看得到自己名下的')}</span>
    return (
      <Space size={[0, 4]} wrap className="perm-tags">
        {on.map(({ m, level }) => (
          <Tag key={m} color={level === 'all' ? 'purple' : undefined}>
            {level === 'all' ? t('全部支票（只看）') : t('我的支票（只看）')}
          </Tag>
        ))}
      </Space>
    )
  }
  if (role !== 'finance') return null
  const d = asDuty(duty)
  const dutyTag = d ? (
    <Tag color="purple" key="duty">
      {d === 'in' ? t('分工：填收款') : t('分工：填付款')}
    </Tag>
  ) : null
  if (perms === null)
    return (
      <Space size={[0, 4]} wrap className="perm-tags">
        <Tag color="green">{t('全部可编辑')}</Tag>
        {dutyTag}
      </Space>
    )
  const shown = PERM_MODULES.map((m) => ({ ...m, level: permOf('finance', perms, m.key) })).filter((m) => m.level !== 'none')
  if (!shown.length) return <Tag>{t('全部不可见')}</Tag>
  return (
    <Space size={[0, 4]} wrap className="perm-tags">
      {shown.map((m) => (
        <Tag key={m.key} color={LEVEL_COLOR[m.level]}>
          {m.level === 'edit' ? t(m.label) : t('{module}（只看）', { module: t(m.label) })}
        </Tag>
      ))}
      {dutyTag}
    </Space>
  )
}

export type PermTarget =
  | { kind: 'profile'; id: string; name: string; role: AppRole | null; perms: Json | null; duty: string | null }
  | { kind: 'invite'; email: string; name: string; role: AppRole | null; perms: Json | null; duty: string | null }

/** 设置一个账号（或邀请名单上的人）的模块权限：财务 8 个模块，业务员只有支票管理 */
export default function PermEditor({ target, onClose }: { target: PermTarget | null; onClose: (saved: boolean) => void }) {
  const t = useT()
  const { message } = App.useApp()
  const [levels, setLevels] = useState<Perms>({})
  const [duty, setDuty] = useState<Duty | null>(null)
  const [saving, setSaving] = useState(false)
  // 打开另一个人时，按他现在的权限重新填（在渲染时对上，不用 effect）
  const [shownFor, setShownFor] = useState<PermTarget | null>(null)
  if (target !== shownFor) {
    setShownFor(target)
    if (target) {
      setLevels(Object.fromEntries(PERM_MODULES.map((m) => [m.key, permOf(target.role ?? 'finance', target.perms, m.key)])) as Perms)
      setDuty(asDuty(target.duty))
    }
  }
  const sales = target?.role === 'sales'
  const modules = sales ? PERM_MODULES.filter((m) => SALES_MODULES.includes(m.key)) : PERM_MODULES
  // 分工只对填银行流水的人有用：银行日记账或银行对账能编辑
  const fillsLines = !sales && (levels.journal === 'edit' || levels.reconcile === 'edit')

  const setAll = (level: PermLevel) => setLevels(Object.fromEntries(PERM_MODULES.map((m) => [m.key, level])) as Perms)

  const save = async () => {
    if (!target) return
    setSaving(true)
    const perms = sales ? storedSalesPerms(levels) : storedPerms(levels)
    const journal_duty = fillsLines ? duty : null
    const { error } =
      target.kind === 'profile'
        ? await supabase.from('profiles').update({ perms, journal_duty }).eq('id', target.id)
        : await supabase.from('user_invites').update({ perms, journal_duty }).eq('email', target.email)
    setSaving(false)
    if (error) {
      message.error(errorText(error))
      return
    }
    message.success(t('已保存'))
    onClose(true)
  }

  return (
    <Modal
      open={!!target}
      title={t('模块权限：{name}', { name: target?.name ?? '' })}
      okText={t('保存')}
      confirmLoading={saving}
      onOk={() => void save()}
      onCancel={() => onClose(false)}
      width={720}
      destroyOnHidden
      className="perm-editor"
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title={
          sales
            ? t('不可见：菜单里没有这一项。只看自己的：只看客户或车是他的那些票。全部支票：公司所有的票都看得到。')
            : t('不可见：菜单里没有这一项。只看：能打开看、能导出，不能新建、修改、删除。可编辑：都能做。')
        }
        description={
          sales
            ? t('两档都只能看：不能录支票、修改、删除、存票、导入表格。别的地方不变，他的「我的车辆」「提交到账」还是只有自己名下的。')
            : t('审批照旧按审批岗位：轮到他审批的单，就算这个模块是只看或不可见，也能在工作台里打开、通过或退回。')
        }
      />
      {!sales && (
        <Space wrap style={{ marginBottom: 8 }}>
          <Button size="small" onClick={() => setAll('edit')}>
            {t('全部可编辑')}
          </Button>
          <Button size="small" onClick={() => setAll('view')}>
            {t('全部只看')}
          </Button>
        </Space>
      )}
      <Table
        rowKey="key"
        size="small"
        pagination={false}
        dataSource={modules}
        columns={[
          {
            title: t('模块'),
            render: (_, m) => (
              <div>
                <Typography.Text strong>{t(m.label)}</Typography.Text>
                <div className="hint">
                  {sales ? t('看支票：到期、存了没、到账了没、是谁的；不能录入、修改、存票') : t('可编辑：{what}', { what: t(MODULE_HINT[m.key]) })}
                </div>
              </div>
            ),
          },
          {
            title: t('权限'),
            width: 230,
            render: (_, m) => (
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                size="small"
                value={levels[m.key] ?? 'none'}
                onChange={(e) => setLevels((l) => ({ ...l, [m.key]: e.target.value as PermLevel }))}
                options={(sales ? SALES_LEVELS : PERM_LEVELS).map((l) => ({ value: l.key, label: t(l.label) }))}
              />
            ),
          },
        ]}
      />
      {!sales && (
        <div className="hint" style={{ marginTop: 8 }}>
          {t('从支票、银行流水生成到账，还要“到账录入”可编辑。客户在车辆、支票的录入框里也能直接新建。')}
        </div>
      )}
      {!sales && (
      <div className="duty-box">
        <div>
          <Typography.Text strong>{t('银行流水分工')}</Typography.Text>
          <div className="hint">
            {t('几个人一起填银行流水时设：填收款的打开银行对账先看「银行有、没人报」，填付款的先看「付款待填」，别人那一摊只能看。')}
          </div>
        </div>
        <Radio.Group
          optionType="button"
          buttonStyle="solid"
          size="small"
          disabled={!fillsLines}
          value={fillsLines ? (duty ?? 'all') : 'all'}
          onChange={(e) => setDuty(e.target.value === 'all' ? null : (e.target.value as Duty))}
          options={[
            { value: 'all', label: t('都填') },
            { value: 'in', label: t('只填收款') },
            { value: 'out', label: t('只填付款') },
          ]}
        />
      </div>
      )}
    </Modal>
  )
}
