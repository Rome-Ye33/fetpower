// 打印页的“缩到一页”（提成单 Rome 2026-11-13「我希望能打印在一页上」；存票审批单 Rome 2026-11-19「需要可以设置缩打到一页」）：
// 出单以后量一下高度，放不下就整张单子一起缩小（像 Excel 的“调整为一页”），屏幕上看到的就是打出来的样子。
// 量高度时按打印的宽度 190mm 量，窗口宽窄不影响缩放比例。最多缩到 60%，再小看不清。
// 缩放用 transform，不用 zoom——量过，Chrome 打印时按 zoom 之前的高度分页。transform 不占位置，所以页面上分两层：
// 里面那层缩小（排版高度不变），外面那层高度 = 缩完的高度、overflow hidden（styles.css 的 .cv-fit-on），分页就按缩完的算。

/** A4 竖版 297mm 减掉上下页边距各 10mm（@page 里设的） */
export const PAGE_MM = 277
/** 打印时单子的宽度：A4 210mm 减掉左右页边距各 10mm */
export const SHEET_MM = 190
/** 最多缩到这么小 */
export const MIN_SCALE = 0.6

/**
 * 这张单要缩到几成才放得进一页（scale = 1 表示不用缩），以及缩之前有多高（px）：
 * print = 按打印的宽度 190mm 排版时的高度（分页看这个），screen = 现在窗口里的高度（窗口窄时会更高）；
 * fits = 按 scale 缩完放得进一页（缩到 60% 还放不下时是 false）
 */
export function fitScale(sheet: HTMLElement): { scale: number; print: number; screen: number; fits: boolean } {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:absolute;top:0;left:-9999px;visibility:hidden;width:100mm;height:100mm'
  document.body.appendChild(probe)
  const pxPerMm = probe.getBoundingClientRect().height / 100
  probe.remove()
  if (!pxPerMm) return { scale: 1, print: 0, screen: 0, fits: true }
  const onScreen = sheet.scrollHeight
  // 窗口比一页窄时单子会被挤窄、变高，所以量之前先按打印的宽度排一次
  const { width, maxWidth } = sheet.style
  sheet.style.width = `${SHEET_MM}mm`
  sheet.style.maxWidth = 'none'
  const height = sheet.scrollHeight
  sheet.style.width = width
  sheet.style.maxWidth = maxWidth
  const page = PAGE_MM * pxPerMm
  if (!height || height <= page) return { scale: 1, print: height, screen: onScreen, fits: true }
  const scale = Math.max(MIN_SCALE, Math.floor((page / height) * 100) / 100)
  return { scale, print: height, screen: onScreen, fits: height * scale <= page }
}
