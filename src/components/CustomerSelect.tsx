import { App, Select } from 'antd'
import { useEffect, useState } from 'react'
import { errorText } from '../lib/errors'
import { useRefData } from '../lib/refdata'
import { supabase } from '../lib/supabase'
import type { Customer } from '../lib/supabase'
import { useT } from '../lib/i18n'

// 客户下拉：本地过滤；搜不到时可以直接新建
//
// 名单是登录时读的，别的标签页、别人（比如导车辆时）新建的客户这里一开始没有（2026-11-28 Rome 录支票碰到）：
// - 选了车带出来的客户名单里没有：重新读一次名单，好显示名字（不然框里是个数字）；
// - 打开下拉时名单读过一分钟了就重新读，刚建的客户也搜得到；
// - 点「+ 新建客户」先读最新的名单，同名的（不分大小写、多余空格）已经有了就直接选上那个，不再新建；
//   正好同时有人建了同名的、数据库说重名，也是读一下名单选上那个。

/** 比名字用：去掉多余空格、不分大小写（和数据库批量导入找客户一样） */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

type Props = {
  value?: number | null
  /** 第二个参数是选中的客户（刚新建的、刚读到的也有）：要用客户资料（业务员等）就用它，别再去名单里找 */
  onChange?: (id: number | null, customer: Customer | null) => void
  allowCreate?: boolean
  /** 新建客户时带上的业务员 */
  salespersonId?: number | null
  placeholder?: string
  style?: React.CSSProperties
  /** 只列这些客户（比如某个业务员名下的）；不传就列全部。当前已选的客户不受影响 */
  only?: Set<number> | null
  disabled?: boolean
}

export default function CustomerSelect({ value, onChange, allowCreate, salespersonId, placeholder, style, only, disabled }: Props) {
  const t = useT()
  const { loaded, customers, refreshPeople, ensureKnown } = useRefData()
  const { message } = App.useApp()
  const [text, setText] = useState('')
  const [creating, setCreating] = useState(false)
  /** 为这个客户重新读过名单了（还是没有，多半是没权限看） */
  const [looked, setLooked] = useState<number | null>(null)

  const current = value != null ? customers.find((c) => c.id === value) : undefined
  const missing = value != null && value > 0 && !current
  useEffect(() => {
    if (!loaded || !missing || value == null) return
    let on = true
    void ensureKnown({ customers: [value] }).finally(() => {
      if (on) setLooked(value)
    })
    return () => {
      on = false
    }
  }, [loaded, missing, value, ensureKnown])

  const q = norm(text)
  const list = customers.filter((c) => (!only || only.has(c.id)) && (!q || norm(c.name).includes(q))).slice(0, 50)
  const exact = customers.some((c) => norm(c.name) === q)
  const options: { value: number; label: string }[] = list.map((c) => ({ value: c.id, label: c.name }))
  if (allowCreate && q && !exact) options.unshift({ value: -1, label: t('+ 新建客户“{name}”', { name: text.trim() }) })
  if (value != null && value > 0 && !options.some((o) => o.value === value)) {
    options.push({ value, label: current?.name ?? (looked === value ? `#${value}` : t('读取中…')) })
  }

  const pick = (c: Customer, note: string) => {
    setText('')
    onChange?.(c.id, c)
    message.success(note)
  }

  /** 点了「+ 新建客户」：先看最新的名单里是不是已经有了，有就选上那个，没有才新建 */
  const create = async (name: string) => {
    const same = (list: Customer[]) => list.find((c) => norm(c.name) === norm(name))
    const already = (c: Customer) => t('客户“{name}”已经有了，直接选上了', { name: c.name })
    setCreating(true)
    try {
      const had = same((await refreshPeople()).customers)
      if (had) return pick(had, already(had))
      const { data, error } = await supabase.from('customers').insert({ name, salesperson_id: salespersonId ?? null }).select('*').single()
      if (error) {
        const dup = error.code === '23505' ? same((await refreshPeople()).customers) : undefined
        if (dup) return pick(dup, already(dup))
        message.error(errorText(error))
        return
      }
      await refreshPeople()
      pick(data, t('已新建客户'))
    } finally {
      setCreating(false)
    }
  }

  const handle = (id: number | undefined) => {
    if (id === -1) {
      void create(text.trim())
      return
    }
    onChange?.(id ?? null, id != null ? (customers.find((c) => c.id === id) ?? null) : null)
  }

  return (
    <Select
      showSearch={{ filterOption: false, onSearch: setText, searchValue: text }}
      allowClear
      loading={creating}
      disabled={disabled}
      // 一直受控，没选就是 null：给 undefined 的话 antd 自己记住点过的「+ 新建客户」，新建没成功框里就卡在那一项上
      value={value ?? null}
      placeholder={placeholder ?? t('选择客户')}
      style={style}
      options={options}
      onChange={handle}
      onOpenChange={(open) => {
        if (open) void refreshPeople(60_000)
        else setText('')
      }}
    />
  )
}
