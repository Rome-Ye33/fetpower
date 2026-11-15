// 维护模式的几块界面：被挡在外面的人看到的维护提示页、登录页上的提示、管理员每页顶上的提示、用户与权限里的开关
import { ToolOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Input, Modal, Popconfirm, Space, Tag, Typography } from 'antd'
import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { errorText } from '../lib/errors'
import { dateTime } from '../lib/format'
import { useT } from '../lib/i18n'
import { useMaintenance } from '../lib/maintenance'
import LangSwitch from './LangSwitch'
import Logo from './Logo'

const NOTE_MAX = 500

/** 登录了但被挡在外面的人（维护期间除管理员以外的所有人）看到的整页提示 */
export function MaintenancePage() {
  const t = useT()
  const { message } = App.useApp()
  const { session, signOut } = useAuth()
  const m = useMaintenance()
  const [busy, setBusy] = useState(false)

  const check = async () => {
    setBusy(true)
    const next = await m.refresh()
    setBusy(false)
    // 维护结束了会直接整页刷新；还在维护就说一声
    if (!next || next.blocked) message.info(t('还在维护中，请稍后再试'))
  }

  return (
    <div className="maint-wrap">
      <div className="maint-top">
        <Logo size={32} />
        <LangSwitch />
      </div>
      <div className="maint-card">
        <div className="maint-icon">
          <ToolOutlined />
        </div>
        <h1 className="maint-title">{t('系统维护中')}</h1>
        <Typography.Paragraph type="secondary" className="maint-sub">
          {t('管理员正在维护系统，这段时间暂时用不了。维护结束后这个页面会自动恢复，不用重新登录。')}
        </Typography.Paragraph>
        {m.note && (
          <div className="maint-note">
            <div className="maint-note-label">{t('管理员的说明')}</div>
            <div className="maint-note-text">{m.note}</div>
          </div>
        )}
        {m.since && <div className="hint maint-since">{t('开始时间：{time}', { time: dateTime(m.since) })}</div>}
        <Space wrap className="maint-actions">
          <Button type="primary" loading={busy} onClick={() => void check()}>
            {t('刷新看看')}
          </Button>
          <Button onClick={() => void signOut()}>{t('退出登录')}</Button>
        </Space>
        <div className="hint maint-who">{t('当前登录：{email}', { email: session?.user.email ?? '' })}</div>
      </div>
    </div>
  )
}

/** 登录页上：维护期间提示只有管理员能登录 */
export function MaintenanceLoginNotice() {
  const t = useT()
  const m = useMaintenance()
  if (!m.active) return null
  return (
    <Alert
      type="warning"
      showIcon
      icon={<ToolOutlined />}
      className="maint-login-alert"
      title={t('系统维护中，现在只有管理员能登录')}
      description={
        <>
          {m.note && <div className="maint-pre">{m.note}</div>}
          {m.since && <div className="hint">{t('开始时间：{time}', { time: dateTime(m.since) })}</div>}
        </>
      }
    />
  )
}

/** 结束维护的按钮（先确认） */
function EndButton({ type = 'primary', size }: { type?: 'primary' | 'default'; size?: 'small' | 'middle' }) {
  const t = useT()
  const { message } = App.useApp()
  const m = useMaintenance()
  const [busy, setBusy] = useState(false)
  const end = async () => {
    setBusy(true)
    try {
      await m.set(false)
      message.success(t('已结束维护，大家的页面几秒内自动恢复'))
    } catch (e) {
      message.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Popconfirm
      title={t('结束维护？')}
      description={t('大家的页面几秒内自动恢复，攒下的待办提醒邮件随后发出。')}
      okText={t('结束维护')}
      cancelText={t('取消')}
      onConfirm={end}
    >
      <Button type={type} size={size} loading={busy} className="maint-end">
        {t('结束维护')}
      </Button>
    </Popconfirm>
  )
}

/** 管理员：维护开着时每个页面顶上都提示，免得忘了结束 */
export function MaintenanceBanner() {
  const t = useT()
  const { isAdmin } = useAuth()
  const m = useMaintenance()
  if (!isAdmin || !m.active) return null
  return (
    <Alert
      type="warning"
      showIcon
      icon={<ToolOutlined />}
      className="maint-banner"
      title={
        m.since
          ? t('维护中（{time} 开始）：除管理员以外的人现在都登录不了、也用不了系统。', { time: dateTime(m.since) })
          : t('维护中：除管理员以外的人现在都登录不了、也用不了系统。')
      }
      action={<EndButton size="small" />}
    />
  )
}

/** 用户与权限：维护模式的开关 */
export function MaintenanceCard() {
  const t = useT()
  const { message } = App.useApp()
  const m = useMaintenance()
  /** start：开始维护；note：改说明 */
  const [open, setOpen] = useState<'start' | 'note' | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const openDialog = (kind: 'start' | 'note') => {
    setNote(kind === 'note' ? (m.note ?? '') : '')
    setOpen(kind)
  }
  const save = async () => {
    setBusy(true)
    try {
      await m.set(true, note)
      message.success(open === 'start' ? t('已开始维护：除你以外的人现在都用不了系统') : t('说明已更新'))
      setOpen(null)
    } catch (e) {
      message.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      size="small"
      className={`maint-card-admin${m.active ? ' is-on' : ''}`}
      style={{ marginBottom: 12 }}
      title={
        <Space size={8}>
          <ToolOutlined />
          {t('维护模式')}
          {m.active ? <Tag color="orange">{t('维护中')}</Tag> : <Tag>{t('没在维护')}</Tag>}
        </Space>
      }
      extra={
        m.active ? (
          <Space wrap>
            <Button onClick={() => openDialog('note')}>{t('改说明')}</Button>
            <EndButton />
          </Space>
        ) : (
          <Button danger disabled={m.failed} onClick={() => openDialog('start')}>
            {t('开始维护')}
          </Button>
        )
      }
    >
      {m.active ? (
        <>
          <div>
            {m.since
              ? t('{time} 开始。除管理员以外的人现在都登录不了、也用不了系统；待办提醒邮件先攒着，结束后再发。', { time: dateTime(m.since) })
              : t('除管理员以外的人现在都登录不了、也用不了系统；待办提醒邮件先攒着，结束后再发。')}
          </div>
          <div className="maint-card-note">
            <span className="hint">{t('给大家的说明：')}</span>
            {m.note ? <span className="maint-pre">{m.note}</span> : <span className="hint">{t('没写')}</span>}
          </div>
        </>
      ) : (
        <div className="hint maint-card-desc">
          {t('改数据库、导入数据或上线新版本前，先点“开始维护”：除管理员以外的人都登录不了，已经登录的人页面会换成“系统维护中”，看不到也改不了任何东西；待办提醒邮件也先不发。维护完点“结束维护”，大家的页面自动恢复，不用重新登录，攒下的提醒邮件随后发出。')}
        </div>
      )}
      {m.failed && <div className="hint text-warn" style={{ marginTop: 8 }}>{t('读不到维护状态，请刷新页面再试。')}</div>}
      {!m.failed && m.gate === false && (
        <div className="hint text-warn" style={{ marginTop: 8 }}>
          {t('数据库那一道拦截没有生效：现在只靠网页挡着。请让 Claude 检查。')}
        </div>
      )}

      <Modal
        open={open !== null}
        title={open === 'start' ? t('开始维护') : t('改说明')}
        okText={open === 'start' ? t('开始维护') : t('保存')}
        okButtonProps={{ danger: open === 'start', loading: busy }}
        cancelText={t('取消')}
        onOk={() => void save()}
        onCancel={() => setOpen(null)}
        destroyOnHidden
      >
        {open === 'start' && (
          <>
            <div style={{ marginBottom: 6 }}>{t('开始以后：')}</div>
            <ul className="maint-list">
              <li>{t('除管理员以外的人都登录不了；已经登录的人 5 秒内页面换成“系统维护中”，看不到也改不了任何东西')}</li>
              <li>{t('你照常使用，每个页面顶上都会提示“维护中”，维护完记得点“结束维护”')}</li>
              <li>{t('待办提醒邮件先不发，结束后马上补发')}</li>
            </ul>
          </>
        )}
        <div className="field-label" style={{ marginBottom: 4 }}>
          {t('给大家的说明（可以不填，登录页和维护提示页上会显示）')}
        </div>
        <Input.TextArea
          className="maint-note-input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={NOTE_MAX}
          showCount
          autoSize={{ minRows: 2, maxRows: 5 }}
          placeholder={t('比如：系统升级，预计 15:00 恢复')}
        />
      </Modal>
    </Card>
  )
}
