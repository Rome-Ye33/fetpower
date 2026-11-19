import { ArrowLeftOutlined, PrinterOutlined } from '@ant-design/icons'
import { Alert, Button, Checkbox, Result, Space, Spin } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import fetLogo from '../assets/fet-logo.jpg'
import { useAuth } from '../lib/auth'
import { CHEQUE_STATUS_LABEL, chequeStatus, chequeVins, waitingDeposit } from '../lib/cheques'
import type { Cheque } from '../lib/cheques'
import { errorText } from '../lib/errors'
import { dateTime, money, num, todayAccra } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { fitScale, MIN_SCALE } from '../lib/printFit'
import { supabase } from '../lib/supabase'

// 支票存票审批单（Rome 2026-11-19 09:06「把明日到期支票的列表可以全选打印，生成支票存票审批单，有金额的不用管，
// 没写金额的需要业务部确认金额，需要财务部应收会计和财务经理和销售部签字」）。
// 支票台账勾中几张（点「明日到期」再点表头的勾全选最常用）→「打印存票审批单」→ 新标签页出这张单，A4 竖版，
// 浏览器“打印”可以直接打或另存为 PDF。张数多一页放不下就接着打，表头每页都有，签字栏不拆开。
// 只放还没存的票（待存 / 等业务确认）：勾中的里面已存、已到账、退票、取消的不放进来，工具栏上写明是哪几张。
// 有金额的照印；空白支票在「业务部确认金额」一栏留一格，业务部手写金额；后面「情况说明」一栏都留空手写（Rome 09:47 加的，09:48「稍微宽一点」）。
// 「缩到一页」（Rome 09:48「需要可以设置缩打到一页」，默认勾上，和提成单一样）：放不下就整张缩小，最多缩到 60%；
// 缩到 60% 还放不下就不缩，按原大小分页打（表头每页都有，一行不拆开），比整张缩小了再断成两页清楚。
// 底下三个签字（应收会计、财务经理、销售部）是纸上签字，不是线上审批；单子上的内容和英文照提成单的做法中英都印。

/** 存票那天：定了计划存票日期按计划，没定按到期日期（和台账上的提醒一样） */
const actDate = (c: Cheque) => c.plan_date ?? c.due_date ?? ''

const cmp = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').localeCompare(b ?? '', 'en', { numeric: true })

/** 单子上的顺序：存票那天 → 客户 → 合同序号 → 第几期 → 支票号（同一个客户的一批排在一起，业务部好对） */
function byDeposit(a: Cheque, b: Cheque): number {
  const da = actDate(a)
  const db = actDate(b)
  if (da !== db) return !da ? 1 : !db ? -1 : da < db ? -1 : 1
  return (
    cmp(a.customer_name, b.customer_name) ||
    cmp(a.contract_no, b.contract_no) ||
    (a.installment_no ?? 0) - (b.installment_no ?? 0) ||
    cmp(a.cheque_no, b.cheque_no)
  )
}

/** 合同序号 · 第几期/共几期，例如 372 · 3/6 */
function instText(c: Cheque): string {
  const parts: string[] = []
  if (c.contract_no) parts.push(c.contract_no)
  if (c.installment_no) parts.push(`${c.installment_no}/${c.installment_count ?? c.installment_no}`)
  return parts.join(' · ')
}

/** 地址里的 ids=1,2,3 */
function parseIds(s: string | null): number[] {
  return [...new Set((s ?? '').split(',').map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0))]
}

export default function ChequeDepositPrintPage() {
  const [sp] = useSearchParams()
  const ids = sp.get('ids') ?? ''
  const idList = useMemo(() => parseIds(ids), [ids])
  // 换了一批（地址变了）就整页重来，免得露出上一批的内容
  return <PrintForm key={ids} ids={idList} />
}

function PrintForm({ ids }: { ids: number[] }) {
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const [rows, setRows] = useState<Cheque[] | null>(null)
  const [err, setErr] = useState<string | null>(ids.length ? null : t('没有选中支票'))
  /** 打开这一页的时间：印在单子上，重打的时候分得清是哪一张 */
  const [printedAt] = useState(() => new Date().toISOString())

  useEffect(() => {
    if (!ids.length) return
    let alive = true
    void supabase
      .from('v_cheques')
      .select('*')
      .in('id', ids)
      .then(({ data, error }) => {
        if (!alive) return
        if (error) setErr(errorText(error))
        else if (!data?.length) setErr(t('找不到这些支票，或没有权限'))
        else setRows(data)
      })
    return () => {
      alive = false
    }
  }, [ids, t])

  const list = useMemo(() => (rows ?? []).filter(waitingDeposit).sort(byDeposit), [rows])
  /** 勾中了但不是待存的（已存、已到账、退票、取消），不放进单子 */
  const skipped = useMemo(() => (rows ?? []).filter((c) => !waitingDeposit(c)), [rows])
  const blanks = list.filter((c) => c.amount == null).length
  /** 每种币种的合计（空白的不算） */
  const totals = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of list) if (c.amount != null) m.set(c.currency ?? '', (m.get(c.currency ?? '') ?? 0) + num(c.amount))
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([cur, v]) => ({ cur, v: Math.round(v * 100) / 100 }))
  }, [list])
  /** 存票日期：这一批都是同一天、而且不早于今天，就印上；不是同一天或者是过了期的，留空手写 */
  const depositDate = useMemo(() => {
    const ds = new Set(list.map(actDate))
    const d = ds.size === 1 ? [...ds][0] : ''
    return d && d >= todayAccra() ? d : ''
  }, [list])

  // 打印时浏览器用页面标题当文件名
  useEffect(() => {
    if (!list.length) return
    const old = document.title
    document.title = `Cheque Deposit Approval ${depositDate || todayAccra()}`
    return () => {
      document.title = old
    }
  }, [list.length, depositDate])

  /** logo 出来了（或者读不到）才让点打印，免得打出来抬头缺一块 */
  const [logoDone, setLogoDone] = useState(false)
  const ready = rows !== null && list.length > 0 && logoDone

  /** 缩到一页（默认缩）；去掉勾就按原大小，放不下就分页打 */
  const [fit, setFit] = useState(true)
  const [scale, setScale] = useState(1)
  /** 缩到 60% 也放不下一页：这时不缩，按原大小分页 */
  const [tooBig, setTooBig] = useState(false)
  /** 没缩之前这张单有多高（px）：打印时和现在窗口里可能不一样（窗口窄时单子会被挤高） */
  const [height, setHeight] = useState({ print: 0, screen: 0 })
  const wrapRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)

  const measure = useCallback(() => {
    const wrap = wrapRef.current
    const inner = innerRef.current
    const sheet = inner?.querySelector<HTMLElement>('.cv-sheet')
    if (!wrap || !inner || !sheet) return
    // 量的是没缩之前的高度：先把缩放和裁切去掉，量完再恢复
    const tf = inner.style.transform
    const on = wrap.classList.contains('cv-fit-on')
    inner.style.transform = 'none'
    wrap.classList.remove('cv-fit-on')
    const r = fitScale(sheet)
    inner.style.transform = tf
    wrap.classList.toggle('cv-fit-on', on)
    setTooBig(!r.fits)
    setScale(r.fits ? r.scale : 1)
    setHeight({ print: r.print, screen: r.screen })
  }, [])

  // 出单后量一次（等排完版）；字体加载完高度会变，再量一次
  useEffect(() => {
    if (!ready || !fit) return
    let alive = true
    const again = () => {
      if (alive) measure()
    }
    const raf = requestAnimationFrame(again)
    void (typeof document !== 'undefined' && document.fonts ? document.fonts.ready : Promise.resolve(null)).then(again)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [ready, fit, list, measure])

  // 外面那层按缩完的高度裁（屏幕上按现在的高度，打印时按 190mm 排版的高度，styles.css 的 .cv-fit-on），里面那层缩小
  const applied = fit ? scale : 1
  const scaled = applied < 1 && height.print > 0
  const outerStyle = scaled
    ? ({
        '--fit-h': `${Math.ceil(Math.max(height.screen, height.print) * applied) + 2}px`,
        '--fit-h-print': `${Math.ceil(height.print * applied) + 2}px`,
      } as CSSProperties)
    : undefined
  const innerStyle = scaled ? { transform: `scale(${applied})`, transformOrigin: 'top center' } : undefined

  return (
    <div className="print-page">
      <div className="print-toolbar no-print">
        <Space wrap>
          <Checkbox checked={fit} onChange={(e) => setFit(e.target.checked)} className="cdf-fit-check">
            {t('缩到一页')}
          </Checkbox>
          {applied < 1 && <span className="hint cdf-fit-hint">{t('已缩到 {pct}%', { pct: Math.round(applied * 100) })}</span>}
          {fit && tooBig && (
            <span className="hint cdf-fit-hint">{t('张数太多，缩到 {pct}% 也放不下一页，按原大小分页打', { pct: Math.round(MIN_SCALE * 100) })}</span>
          )}
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/cheques')}>
            {t('回到支票管理')}
          </Button>
          <Button type="primary" icon={<PrinterOutlined />} disabled={!ready} onClick={() => window.print()}>
            {t('打印')}
          </Button>
        </Space>
      </div>
      {skipped.length > 0 && (
        <Alert
          className="no-print cdf-skip"
          type="warning"
          showIcon
          title={t('{n} 张不是待存的，没放进来：{list}', {
            n: skipped.length,
            list: skipped
              .map((c) => {
                const no = c.cheque_no ?? `#${c.id}`
                const st = t(CHEQUE_STATUS_LABEL[chequeStatus(c.status)])
                return lang === 'en' ? `${no} (${st})` : `${no}（${st}）`
              })
              .join(lang === 'en' ? ', ' : '、'),
          })}
        />
      )}
      {err ? (
        <Result status="warning" title={err} />
      ) : rows === null ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : !list.length ? (
        <Result status="warning" title={t('选中的支票都不是待存的，没有要存的')} />
      ) : (
        <div className={scaled ? 'cv-fit cv-fit-on' : 'cv-fit'} ref={wrapRef} style={outerStyle}>
          <div ref={innerRef} style={innerStyle}>
            <div className="cv-sheet cdf-sheet">
              {/* 抬头：左边公司 logo（Rome 2026-11-19 09:18 发的，和登录页是同一个图），中间公司名和单名；右边留同样宽的空，单名才在正中 */}
              <div className="cdf-head">
                <img className="cdf-logo" src={fetLogo} alt="FET AUTO" onLoad={() => setLogoDone(true)} onError={() => setLogoDone(true)} />
                <div>
                  <div className="cv-company">FET AUTO COMPANY LIMITED</div>
                  <div className="cv-title">支票存票审批单&nbsp;&nbsp;CHEQUE DEPOSIT APPROVAL FORM</div>
                </div>
                <div />
              </div>
              <div className="cdf-meta">
                <span>
                  存票日期 DEPOSIT DATE：{depositDate ? <b>{depositDate}</b> : <span className="cdf-line" />}
                </span>
                <span>
                  共 {list.length} 张 TOTAL {list.length} {list.length === 1 ? 'CHEQUE' : 'CHEQUES'}
                  {blanks > 0 && `（空白 ${blanks} 张 BLANK ${blanks}）`}
                </span>
              </div>
              <div className="cdf-meta2">
                制单 PREPARED BY：{profile?.full_name ?? ''}&nbsp;&nbsp;{dateTime(printedAt)}
              </div>
              <table className="cv-table cdf-table">
                <colgroup>
                  {/* 一共 190mm：情况说明最宽（约 36mm），留着手写 */}
                  <col style={{ width: '3.5%' }} />
                  <col style={{ width: '16.5%' }} />
                  <col style={{ width: '10%' }} />
                  <col style={{ width: '10%' }} />
                  <col style={{ width: '7.5%' }} />
                  <col style={{ width: '9%' }} />
                  <col style={{ width: '12.5%' }} />
                  <col style={{ width: '12%' }} />
                  <col style={{ width: '19%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>
                      客户 / 车
                      <br />
                      CUSTOMER / VEHICLE
                    </th>
                    <th>
                      支票号 / 银行
                      <br />
                      CHEQUE NO. / BANK
                    </th>
                    <th>
                      到期日期
                      <br />
                      DUE DATE
                    </th>
                    <th>
                      序号 / 期
                      <br />
                      REF. / INST.
                    </th>
                    <th>
                      业务员
                      <br />
                      SALES REP
                    </th>
                    <th>
                      支票金额
                      <br />
                      CHEQUE AMOUNT
                    </th>
                    <th>
                      业务部确认金额
                      <br />
                      AMOUNT CONFIRMED BY SALES
                    </th>
                    <th>
                      情况说明
                      <br />
                      REMARKS
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((c, i) => {
                    const blank = c.amount == null
                    const vins = chequeVins(c)
                    return (
                      <tr key={c.id} className={blank ? 'cdf-row cdf-row-blank' : 'cdf-row'}>
                        <td className="c">{i + 1}</td>
                        <td>
                          {/* 支票上的户名和客户名只是大小写不同（常见）就不重复印 */}
                          {c.customer_name}
                          {c.drawer_name && c.drawer_name.toLowerCase() !== (c.customer_name ?? '').toLowerCase() && <div className="cdf-sub">{c.drawer_name}</div>}
                          {vins.length > 0 && (
                            <div className="cdf-sub cv-vin">
                              {vins[0]}
                              {vins.length > 1 ? ` +${vins.length - 1}` : ''}
                            </div>
                          )}
                        </td>
                        <td>
                          {c.cheque_no}
                          {c.drawer_bank && <div className="cdf-sub">{c.drawer_bank}</div>}
                        </td>
                        <td className="c cdf-nowrap">
                          {c.due_date ?? ''}
                          {c.plan_date && c.plan_date !== c.due_date && <div className="cdf-sub">计划 PLAN {c.plan_date}</div>}
                        </td>
                        <td className="c">{instText(c)}</td>
                        <td>{c.salesperson_name ?? ''}</td>
                        <td className="r cdf-nowrap">
                          {blank ? (
                            <>
                              空白 BLANK
                              {c.installment_usd != null && <div className="cdf-sub">每期 USD {money(c.installment_usd)}</div>}
                            </>
                          ) : (
                            `${c.currency ?? ''} ${money(c.amount)}`
                          )}
                        </td>
                        {blank ? (
                          <td className="cdf-confirm">
                            <span className="cdf-cur">{c.currency ?? ''}</span>
                          </td>
                        ) : (
                          <td className="c">—</td>
                        )}
                        <td className="cdf-remark" />
                      </tr>
                    )
                  })}
                  <tr className="cdf-total">
                    <th colSpan={6} className="cdf-total-label">
                      合计 TOTAL
                    </th>
                    <td className="r b">
                      {totals.map((x) => (
                        <div key={x.cur}>
                          {x.cur} {money(x.v)}
                        </div>
                      ))}
                      {blanks > 0 && <div className="cdf-sub">+ 空白 BLANK × {blanks}</div>}
                    </td>
                    <td />
                    <td />
                  </tr>
                </tbody>
              </table>
              {blanks > 0 && (
                <div className="cdf-note">
                  说明：有金额的支票按支票上的金额存；空白支票请业务部在「业务部确认金额」一栏写上金额，并在下面签字确认。
                  <br />
                  NOTE: Cheques with an amount are deposited as written. For blank cheques, Sales writes the amount under Amount Confirmed by Sales and signs below.
                </div>
              )}
              <div className="cv-sign cdf-sign">
                <Signer zh="财务部 应收会计" en="FINANCE · AR ACCOUNTANT" />
                <Signer zh="财务部 财务经理" en="FINANCE MANAGER" />
                <Signer zh="销售部" en="SALES DEPT" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 一个手写签字的格子：谁签、签字线、日期线 */
function Signer({ zh, en }: { zh: string; en: string }) {
  return (
    <div className="cdf-signer">
      <div className="cv-sign-label">
        {zh}
        <br />
        {en}:
      </div>
      <div className="cv-sign-name" />
      <div className="cdf-date">
        日期 DATE：<span className="cdf-line" />
      </div>
    </div>
  )
}
