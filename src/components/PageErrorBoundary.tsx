import { Button, Result } from 'antd'
import { Component } from 'react'
import type { ReactNode } from 'react'
import { useT } from '../lib/i18n'
import { isLoadError, reloadOnce } from '../lib/updateReload'

// 页面出错时不再整页白掉（以前没有接住，React 把整个网页都撤掉了）：
// 拿不到网页文件（网站刚更新过）就自动刷新一次换成新版；别的错写出来，给一个「刷新」按钮。
// App.tsx 里按地址套在每个页面外面：换一个菜单就重新来，左边菜单一直在。

type State = { error: unknown; failed: boolean }

export default class PageErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, failed: false }

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true }
  }

  componentDidCatch(error: unknown) {
    if (isLoadError(error)) reloadOnce()
  }

  render() {
    if (!this.state.failed) return this.props.children
    return <ErrorView error={this.state.error} />
  }
}

function ErrorView({ error }: { error: unknown }) {
  const t = useT()
  const load = isLoadError(error)
  const msg = error instanceof Error ? error.message : String(error)
  return (
    <Result
      className="page-error"
      status="warning"
      title={load ? t('网站刚更新过，刷新一下就好') : t('这个页面出错了，刷新一下试试')}
      subTitle={load ? undefined : msg}
      extra={
        <Button type="primary" onClick={() => window.location.reload()}>
          {t('刷新')}
        </Button>
      }
    />
  )
}
