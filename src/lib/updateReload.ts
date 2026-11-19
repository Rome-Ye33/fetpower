// 网站更新以后（每次上线文件名都会换），还开着的旧网页去拿已经换掉的文件会失败，以前整页就白了（Rome 2026-11-19「怎么有点卡」）。
// 发布时会多留上一版的文件（.github/workflows/deploy.yml），一般拿得到；万一还是拿不到（比如连着更新了两次），就自动刷新一次换成新版。
// 一分钟内只自动刷新一次，免得网站真出了问题时一直刷；刷过还不行，页面上写明并给「刷新」按钮（components/PageErrorBoundary.tsx）。
// index.html 里还有一段同样的处理，管的是网页还没打开（首页的文件就拿不到）的时候。

const KEY = 'auto-reload-at'

/** 自动刷新一次；一分钟内已经刷过就不刷，返回 false */
export function reloadOnce(): boolean {
  let last = 0
  try {
    last = Number(sessionStorage.getItem(KEY) || 0)
  } catch {
    // 读不了就当没刷过
  }
  if (Date.now() - last < 60_000) return false
  try {
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    return false // 记不下来就不自动刷，免得一直刷
  }
  window.location.reload()
  return true
}

/** 是不是拿不到网页文件的错（网站刚更新、网断了）：Chrome / Edge、Firefox、Safari 的说法各不一样 */
export function isLoadError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(msg)
}
