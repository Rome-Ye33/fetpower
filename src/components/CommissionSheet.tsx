import { EN } from '../i18n/en'
import {
  PAY_STATE_ZH,
  parsePayments,
  parseVehicles,
  paymentDisplay,
  perCarCommission,
  payStateEn,
  payStateVars,
  savedTotals,
  TRAIL_PRINT,
  VOUCHER_STATUS_EN,
  VOUCHER_STATUS_LABEL,
  voucherStatus,
} from '../lib/commission'
import type { CommissionVoucher } from '../lib/commission'
import { changeSummary, parseChanges, zhOnly } from '../lib/editChanges'
import { stepPrintNames, voucherFlow } from '../lib/flow'
import { dateTime, money, num, shortDate } from '../lib/format'
import { useRefData } from '../lib/refdata'
import type { ApprovalLog } from '../lib/workbench'

// 打印的提成单（2026-11-21 Rome「打印模板设置简单点，数据显示一目了然」，改成现在这个样子）：
// 黑字白底、A4 竖版、中英文都印。从上到下：
//   抬头（公司、单号、状态）→ 客户 / 业务员 / 部门 / 日期 一行 → 几个关键数字（本次发放 USD、折合赛地、提成金额、发放比例）
//   → 一、车辆（每台车：大架号、车型、单价；分开填了提成的多印「本车提成」；填了自己汇率的多印「汇率」「折合赛地」；已到账 / 余额）
//   → 二、客户付款（每笔：日期、款项、到账编号、金额、汇率、折合美元）+ 销售总额 / 已付 / 余额 / 分期情况 一行
//   → 三、审批：一行审批流（谁、哪天）+ 审批过程表（提交、每一级通过、退回和原因、修改、发放）。线上审批，不用签字。
// 空着的、为 0 的项不印（其他费用、折扣、分期那些有才出现），单子短，一眼看得到钱。
// 内容是提交时存下的车和付款，审批后再改到账也不会变；「已到账 / 余额」是车辆台账现在的数（这台车收到的所有钱）。
// 有人要美元、有人要赛地：填了汇率的单子印折合赛地；每台车的汇率可以不一样（47），这时每台车各印各的汇率和赛地。

/** 中文 + 英文（对照表里有英文的才加） */
function bi(zh: string | null | undefined): string {
  if (!zh) return ''
  const en = EN[zh]
  return en ? `${zh} ${en}` : zh
}

function fill(zh: string, vars?: Record<string, number>): string {
  return zh.replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? ''))
}

/** 有数才显示（0 和空都留白） */
function has(v: unknown): boolean {
  return !(v === null || v === undefined || v === '' || num(v) === 0)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** 表头：中文一行、英文一行 */
function Th({ zh, en, colSpan }: { zh: string; en: string; colSpan?: number }) {
  return (
    <th colSpan={colSpan}>
      {zh}
      <br />
      <span className="cv-en">{en}</span>
    </th>
  )
}

export default function CommissionSheet({
  v,
  trail = [],
  ledger,
}: {
  v: CommissionVoucher
  trail?: ApprovalLog[]
  /** 每台车现在的到账情况（车辆台账里的数，不是这张单上的）：结清了没有、还差多少 */
  ledger?: Map<number, { received: number; balance: number }>
}) {
  const vehicles = parseVehicles(v.vehicles)
  const payments = parsePayments(v.payments)
  const tt = savedTotals(v)
  const { steps } = useRefData()
  const byKey = new Map(steps.map((s) => [s.key, s]))
  const status = voucherStatus(v.status)
  const final = status === 'approved' || status === 'paid'
  const pending = status === 'submitted' && v.step ? stepPrintNames(byKey.get(v.step), v.step) : null
  const stamp = pending
    ? `待${pending.zh}审批 PENDING${pending.en ? ' ' + pending.en : ''}`
    : `${VOUCHER_STATUS_LABEL[status]} ${VOUCHER_STATUS_EN[status]}`
  const flow = voucherFlow(v.flow, steps)
  const many = vehicles.length > 1
  const st = tt.state
  const ratio = v.payout_ratio == null ? null : num(v.payout_ratio)

  /** 每台车分开填了提成：多一列「本车提成」 */
  const perCar = perCarCommission(vehicles)
  const headRate = num(v.payout_rate) > 0 ? num(v.payout_rate) : null
  /** 每台车用的汇率（自己的，没有就整单的）；填了提成的车才算 */
  const carRate = (x: { commission_usd: number | null; payout_rate: number | null }) => (x.commission_usd == null ? null : num(x.payout_rate) > 0 ? num(x.payout_rate) : headRate)
  /** 有车填了和整单不一样的汇率：车辆表多印「汇率」「折合赛地」两列 */
  const ownRates = perCar != null && vehicles.some((x) => x.commission_usd != null && x.payout_rate != null && x.payout_rate !== headRate)
  /** 折合赛地印合计的（提成部分 + 奖励）；有奖励但整单没汇率就折不了，整块不印 */
  const showGhs = tt.payTotalGhs != null
  const carGhsTotal = ownRates ? round2(vehicles.reduce((s, x) => s + (carRate(x) != null ? num(x.commission_usd) * (carRate(x) as number) : 0), 0)) : null
  /** 车辆表各列的宽度（%）：按有没有「本车提成」「汇率 / 折合赛地」三种情况分配，加起来 100 */
  const vehWidths = ownRates ? [4, 21, 14, 11, 11, 7, 11, 13, 8] : perCar != null ? [5, 20, 24, 12, 12, 15, 12] : [5, 22, 31, 13, 16, 13]
  const vehCols = vehWidths.length

  /** 销售及付款条件：全款的只写全款；分期的写首付、期数、每期、已还 */
  const terms: string[] = []
  if (v.full_payment === false) {
    terms.push('分期 INSTALLMENTS')
    if (has(v.down_payment_usd)) terms.push(`首付 DOWN PAYMENT $ ${money(v.down_payment_usd)}`)
    if (v.terms_count) terms.push(`${v.terms_count} 期 TERMS`)
    if (has(v.per_term_usd)) terms.push(`每期 PER TERM $ ${money(v.per_term_usd)}`)
    if (tt.termsPaid != null) terms.push(`已还 PAID ${tt.termsPaid} / 剩 LEFT ${tt.termsLeft}`)
  } else terms.push('全款 FULL PAYMENT')

  return (
    <div className="cv-sheet cv-simple">
      <div className="cv-top">
        <div>
          <div className="cv-company">FET AUTO COMPANY LIMITED</div>
          <div className="cv-title">提成单&nbsp;&nbsp;COMMISSION VOUCHER</div>
        </div>
        <div className="cv-top-right">
          {!final && <span className="cv-stamp">{stamp}</span>}
          <div className="cv-no">NO. {v.voucher_no ?? '—'}</div>
          <div className="cv-en">日期 DATE {v.voucher_date}</div>
        </div>
      </div>

      <div className="cv-info">
        <div>
          <div className="cv-label">客户 CUSTOMER</div>
          <div className="cv-val">{v.customer_name}</div>
        </div>
        <div>
          <div className="cv-label">业务员 SALESPERSON</div>
          <div className="cv-val">{v.salesperson_name}</div>
        </div>
        <div>
          <div className="cv-label">申请部门 DEPT</div>
          <div className="cv-val">{bi(v.dept)}</div>
        </div>
        <div>
          <div className="cv-label">数量与型号 QTY &amp; MODEL</div>
          <div className="cv-val">{v.qty_model || `${tt.units} 台 UNITS`}</div>
        </div>
      </div>

      <div className="cv-kpi">
        <div className="cv-kpi-main">
          <div className="cv-label">{tt.bonus > 0 ? '本次发放合计 TOTAL PAYOUT (USD)' : '本次发放提成 TOTAL PAYOUT (USD)'}</div>
          <div className="cv-kpi-num">{tt.payTotal == null ? '—' : `$ ${money(tt.payTotal)}`}</div>
        </div>
        {showGhs && (
          <div className="cv-kpi-main">
            <div className="cv-label">折合赛地 TOTAL PAYOUT (GHS)</div>
            <div className="cv-kpi-num">GH₵ {money(tt.payTotalGhs)}</div>
          </div>
        )}
        <div>
          <div className="cv-label">提成金额 COMMISSION (USD)</div>
          <div className="cv-kpi-sub">{v.commission_usd == null ? '—' : `$ ${money(v.commission_usd)}`}</div>
        </div>
        {tt.bonus > 0 && (
          // 额外奖励（48）：整单一个数、不挂车、不乘比例，全额加在提成之后
          <div className="cv-kpi-bonus">
            <div className="cv-label">额外奖励 BONUS (USD)</div>
            <div className="cv-kpi-sub">$ {money(tt.bonus)}</div>
            {v.bonus_note && <div className="cv-kpi-note">{v.bonus_note}</div>}
          </div>
        )}
        <div>
          <div className="cv-label">发放比例 PAYOUT RATIO</div>
          <div className="cv-kpi-sub">{ratio == null ? '—' : `${Math.round(ratio * 10000) / 100}%`}</div>
        </div>
        {showGhs && !ownRates && (
          <div>
            <div className="cv-label">汇率 RATE GHS/USD</div>
            <div className="cv-kpi-sub">{tt.payoutRate}</div>
          </div>
        )}
        {showGhs && ownRates && (
          <div>
            <div className="cv-label">汇率 RATE GHS/USD</div>
            <div className="cv-kpi-sub">按车 PER UNIT</div>
          </div>
        )}
      </div>

      <div className="cv-h">一、车辆&nbsp;&nbsp;VEHICLES</div>
      <table className="cv-table cv-veh">
        <colgroup>
          {vehWidths.map((w, i) => (
            <col key={i} style={{ width: `${w}%` }} />
          ))}
        </colgroup>
        <thead>
          <tr className="cv-head">
            <th>#</th>
            <Th zh="大架号" en="CHASSIS NO." />
            <Th zh="品牌 / 车型" en="BRAND / MODEL" />
            <Th zh="单价" en="UNIT PRICE (USD)" />
            {perCar != null && <Th zh="本车提成" en="COMMISSION (USD)" />}
            {ownRates && <Th zh="汇率" en="RATE" />}
            {ownRates && <Th zh="折合赛地" en="GHS" />}
            <Th zh="已到账 / 余额" en="PAID / BALANCE" />
            <Th zh="备注" en="NOTE" />
          </tr>
        </thead>
        <tbody>
          {vehicles.map((x, i) => {
            const paid = ledger?.get(x.vehicle_id)
            const r = carRate(x)
            return (
              <tr key={x.vehicle_id}>
                <td className="c">{i + 1}</td>
                <td className="cv-vin">{x.vin}</td>
                <td>{x.model}</td>
                <td className="r">{money(x.unit_price_usd)}</td>
                {perCar != null && <td className="r">{x.commission_usd == null ? '' : money(x.commission_usd)}</td>}
                {ownRates && <td className="r">{r ?? ''}</td>}
                {ownRates && <td className="r">{r == null || x.commission_usd == null ? '' : money(round2(num(x.commission_usd) * r))}</td>}
                <td className="r">
                  {paid && (
                    <>
                      {money(paid.received)}
                      <br />
                      <span className="cv-en">{paid.balance < 1 ? '已结清 PAID OFF' : `还差 BAL ${money(paid.balance)}`}</span>
                    </>
                  )}
                </td>
                <td>{[bi(x.payment_method), x.note].filter(Boolean).join('; ')}</td>
              </tr>
            )
          })}
          <tr className="cv-sum">
            <td className="c">{tt.units}</td>
            <td colSpan={2}>合计&nbsp;&nbsp;TOTAL</td>
            <td className="r b">{money(tt.vehiclesUsd)}</td>
            {perCar != null && <td className="r b">{money(perCar)}</td>}
            {ownRates && <td />}
            {ownRates && <td className="r b">{carGhsTotal == null ? '' : money(carGhsTotal)}</td>}
            <td colSpan={vehCols - 4 - (perCar != null ? 1 : 0) - (ownRates ? 2 : 0)} />
          </tr>
        </tbody>
      </table>
      {(has(v.other_charges_usd) || has(v.discount_usd) || v.remarks) && (
        <div className="cv-line">
          {has(v.other_charges_usd) && (
            <span>
              其他费用 OTHER CHARGES $ {money(v.other_charges_usd)}
              {v.charges_note ? `（${v.charges_note}）` : ''}
            </span>
          )}
          {has(v.discount_usd) && <span>折扣 DISCOUNT $ {money(v.discount_usd)}</span>}
          {v.remarks && <span>备注 REMARKS：{v.remarks}</span>}
        </div>
      )}

      <div className="cv-h">二、客户付款&nbsp;&nbsp;PAYMENTS RECEIVED</div>
      <table className="cv-table cv-pay">
        <colgroup>
          {[12, 15, 17, 17, 8, 13, 18].map((w, i) => (
            <col key={i} style={{ width: `${w}%` }} />
          ))}
        </colgroup>
        <thead>
          <tr className="cv-head">
            <Th zh="日期" en="DATE" />
            <Th zh="款项" en="TYPE" />
            <Th zh="到账编号" en="RECEIPT" />
            <Th zh="金额" en="AMOUNT" />
            <Th zh="汇率" en="RATE" />
            <Th zh="折合美元" en="USD" />
            <Th zh="备注" en="NOTE" />
          </tr>
        </thead>
        <tbody>
          {payments.length === 0 && (
            <tr>
              <td colSpan={7} className="c cv-en">
                （还没有到账 NO PAYMENTS RECEIVED）
              </td>
            </tr>
          )}
          {payments.map((p) => {
            const d = paymentDisplay(p)
            const note = [p.note, d.sharedFrom ? `合付 TOTAL ${d.sharedFrom}` : '', many && p.vin ? `VIN …${p.vin.slice(-6)}` : '']
              .filter(Boolean)
              .join('; ')
            return (
              <tr key={p.claim_id}>
                <td className="c">{p.pay_date}</td>
                <td>{bi(p.nature)}</td>
                <td className="cv-vin">{p.receipt_no ?? '期初 OPENING'}</td>
                <td className="r">
                  {d.currency} {money(d.amount)}
                </td>
                <td className="r">{d.rate ?? ''}</td>
                <td className="r">{money(d.usd)}</td>
                <td>{note}</td>
              </tr>
            )
          })}
          <tr className="cv-sum">
            <td colSpan={5}>客户已支付合计&nbsp;&nbsp;TOTAL PAID BY CUSTOMER (USD)</td>
            <td className="r b">{money(tt.paid)}</td>
            <td className="cv-warn">{st.kind === 'overpaid' ? '⚠ 已付超过销售额 OVERPAID' : ''}</td>
          </tr>
        </tbody>
      </table>
      <div className="cv-line cv-balance">
        <span>
          销售总金额 TOTAL SALES <b>$ {money(tt.totalSales)}</b>
        </span>
        <span>
          已付 PAID <b>$ {money(tt.paid)}</b>
        </span>
        <span>
          未付余额 BALANCE <b>$ {money(tt.balance)}</b>
          {tt.progress != null ? `（${(tt.progress * 100).toFixed(1)}%）` : ''}
        </span>
        <span className={st.kind === 'overpaid' ? 'cv-warn' : ''}>
          {fill(PAY_STATE_ZH[st.kind], payStateVars(st))} {payStateEn(st)}
        </span>
        <span className="cv-en">{terms.join(' · ')}</span>
      </div>

      <div className="cv-h">三、审批&nbsp;&nbsp;APPROVAL</div>
      <div className="cv-flow">
        <span className="cv-flow-step">
          <span className="cv-label">制单 PREPARED BY</span>
          <span className="cv-sign-name">{v.prepared_name ?? ''}</span>
          <span className="cv-sign-date">{v.prepared_name ? shortDate(v.prepared_at) : ''}</span>
        </span>
        {flow.map((f) => {
          const n = stepPrintNames(byKey.get(f.step), f.step)
          const waiting = !f.by_name && status === 'submitted' && v.step === f.step
          return (
            <span key={f.step} className="cv-flow-step">
              <span className="cv-label">
                {n.zh}
                {n.en ? ` ${n.en}` : ''}
              </span>
              <span className="cv-sign-name">{f.by_name ?? (waiting ? '待审 PENDING' : '')}</span>
              <span className="cv-sign-date">{f.by_name ? shortDate(f.at) : ''}</span>
            </span>
          )
        })}
      </div>
      <div className="cv-sign-note">
        以上各级为线上审批，无需签字&nbsp;&nbsp;Approved online in the system; no signature required
        {status === 'paid' && (
          <span className="cv-paid">
            &nbsp;&nbsp;·&nbsp;&nbsp;已发放 PAID OUT {v.paid_on}
            {v.paid_name ? ` · ${v.paid_name}` : ''}
          </span>
        )}
      </div>

      {trail.length > 0 && (
        <table className="cv-table cv-trail">
          <colgroup>
            <col style={{ width: '6%' }} />
            <col style={{ width: '38%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '22%' }} />
          </colgroup>
          <thead>
            <tr className="cv-head">
              <th>#</th>
              <Th zh="步骤" en="STEP" />
              <Th zh="处理人" en="BY" />
              <Th zh="时间" en="TIME" />
              <Th zh="意见" en="NOTE" />
            </tr>
          </thead>
          <tbody>
            {trail.map((r, i) => {
              const a = TRAIL_PRINT[r.action] ?? { zh: r.action, en: '' }
              // 通过、退回写明是哪一级
              const lv = r.step ? stepPrintNames(byKey.get(r.step), r.step) : null
              return (
                <tr key={r.id}>
                  <td className="c">{i + 1}</td>
                  <td>
                    {lv ? `${lv.zh} ` : ''}
                    {a.zh}
                    <span className="cv-trail-en">
                      {lv?.en ? ` ${lv.en}` : ''} {a.en}
                    </span>
                  </td>
                  <td>{r.actor_name ?? ''}</td>
                  <td className="c">{dateTime(r.at)}</td>
                  <td>{r.action === 'edit' ? changeSummary(parseChanges(r.changes), zhOnly) : (r.note ?? '')}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
